// Provisioning Worker, the trusted front door (#182). This module is the whole
// security boundary of the Worker path: it decides WHO may call, and it BUILDS
// the provisioning cfg from the Worker's own trusted configuration so a caller
// can never supply code, bindings, a namespace, a kv id or a zone.
//
// The authenticated caller sends ONLY { kind, name, domain }. Everything a
// previous version read from the body (modules, resourceBindings, namespace,
// kvId, hostname, saasZoneId, secrets) is built HERE from env + the vetted
// bundle in the Worker's own R2 bucket. The caller chooses a type and a name,
// and picks an OWNED base domain from an allowlist; it configures nothing.
import { SITE_NAME_RE, assertValidName, isCallerReservedName, genSecret } from './shared.mjs';
import { bDosqlBindings, mediaBucketName } from './wp-site-config.mjs';

// ---- 1. Caller auth (operator baseline) --------------------------------------
// A shared operator secret in env.PROVISION_AUTH, sent as `Authorization:
// Bearer <secret>`. The compare is constant-time over SHA-256 digests of both
// sides, so neither the secret's bytes nor its length leak through timing. This
// is the token-gated baseline; a self-serve identity layer slots in by replacing
// authorize() (and the rate-limit key) without touching the cfg-building below.
async function sha256Bytes(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
async function timingSafeEqual(a, b) {
  const [va, vb] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}
export async function authorize(request, env) {
  const expected = env.PROVISION_AUTH;
  // Must be a non-empty STRING: a Secrets Store / KV / R2 object bound here must
  // not pass (grok residual 1). No secret configured: fail closed.
  if (typeof expected !== 'string' || !expected) return false;
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  if (!m) return false;
  return timingSafeEqual(m[1], expected);
}

// ---- 2. Rate limit per caller ------------------------------------------------
// The native Workers Rate Limiting binding (env.RATE_LIMITER.limit({ key })).
// The key is the caller's IP for the operator baseline; it becomes the identity
// when the self-serve layer lands. The Worker requires the binding (fail closed
// by configuration), so this never silently passes without a limiter.
export async function enforceRateLimit(env, key) {
  const res = await env.RATE_LIMITER.limit({ key });
  return !!(res && res.success);
}
export function callerKey(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

// ---- 3. Validate the minimal request ----------------------------------------
// Read ONLY kind, name, domain. Any other field in the body is dropped here and
// never reaches the cfg, so an injected modules/namespace/kvId/saasZoneId/secrets
// cannot take effect. Returns the three vetted values or throws a 400-worthy
// error.
export function validateRequest(body) {
  if (!body || typeof body !== 'object') throw new BadRequest('body must be a JSON object');
  const { kind, name, domain } = body;
  // The c1 'shop' store path was retired (#214): a store is a b-dosql site with
  // WooCommerce active, not a separate kind. Reject it with a clear pointer.
  if (kind === 'shop' || kind === 'store') throw new BadRequest('the c1 store path was retired (#214); a store is a b-dosql site, use kind "wp"');
  if (kind !== 'wp') throw new BadRequest('kind must be "wp"');
  if (typeof name !== 'string' || !SITE_NAME_RE.test(name)) throw new BadRequest('name must be lower case, digits, hyphens, 1 to 30, no leading or trailing hyphen');
  if (isCallerReservedName(name)) throw new BadRequest('name is reserved (an infrastructure, service, or demo-lane label); pick another');
  if (typeof domain !== 'string' || !domain) throw new BadRequest('domain is required');
  return { kind, name, domain };
}
export class BadRequest extends Error {}

// ---- 4. Server-owned base domains -------------------------------------------
// env.WFP_BASES is a JSON map of OWNED base domains to their routing config:
//   { "<base>": { "saasZoneId": "<zone>", "workersSubdomain": "<sub>" } }
// The caller picks a base by name; it can never supply a zone id or subdomain.
// An unknown base is a 400. This is the one place a zone enters the cfg, and it
// comes from the Worker's config, not the request.
export function resolveBase(env, domain) {
  let bases;
  try { bases = JSON.parse(env.WFP_BASES || '{}'); } catch { throw new Error('the Worker WFP_BASES config is not valid JSON'); }
  const base = Object.hasOwn(bases, domain) ? bases[domain] : undefined;
  if (!base) throw new BadRequest(`domain "${domain}" is not an owned base (allowed: ${Object.keys(bases).join(', ') || 'none configured'})`);
  return base;
}

// ---- 5. Least-privilege token split -----------------------------------------
// wp runs on the restricted token (no account-token minting, no plain
// /workers/scripts write); shop runs on the elevated token (adds minting and
// Containers). The wp path NEVER holds the elevated token. Token VALUES are env
// vars, never in code.
// ONE token only (#214): the c1 'shop' store path was retired, so the elevated
// SHOP_PROVISION_TOKEN (which could mint account tokens and edit Containers) is
// gone. The provisioning Worker runs entirely on the restricted WP token, which
// cannot mint a token or write a plain script. An unknown kind THROWS.
const TOKEN_ENV = { wp: 'WP_PROVISION_TOKEN' };
export function selectToken(env, kind) {
  const key = Object.hasOwn(TOKEN_ENV, kind) ? TOKEN_ENV[kind] : undefined;
  if (!key) throw new Error(`selectToken: unknown kind ${JSON.stringify(kind)} (only 'wp' is supported; c1 'shop' retired #214)`);
  const token = env[key];
  if (!token) throw new Error(`the Worker is missing ${key}`);
  return token;
}

// ---- 6. Derive the routing target (cheap, no IO) ----------------------------
// script name, hostname, saasZoneId, namespace, kvId, all from env + the base.
// Used both to pre-check idempotency (before loading the bundle) and inside the
// full cfg.
export function deriveTarget(env, { kind, name, domain }) {
  assertValidName(name);
  const base = resolveBase(env, domain);
  const namespace = env.WFP_NAMESPACE || 'wp-wfp';
  const kvId = env.WFP_KV_ID;
  if (!kvId) throw new Error('the Worker is missing WFP_KV_ID');
  if (kind === 'wp') {
    if (!base.saasZoneId) throw new Error(`base "${domain}" has no saasZoneId`);
    return { kind, name, script: `site-${name}`, hostname: `${name}.${domain}`, saasZoneId: base.saasZoneId, namespace, kvId };
  }
  const sub = base.workersSubdomain;
  if (!sub) throw new Error(`base "${domain}" has no workersSubdomain for a shop`);
  return { kind, name, script: `c1-${name}`, hostname: `c1-${name}.${sub}.workers.dev`, namespace, kvId };
}

// ---- 7. The vetted bundle, from the Worker's own R2 bucket -------------------
// env.BUNDLES is a read-only R2 binding to the bundles bucket the operator/bake
// lane writes. The caller cannot name it (it is a binding) and cannot write it.
// Modules load as text for JS and as BINARY for .wasm/.zip data (reading those
// as utf8 corrupts them, the #158 finding). Decouples a WP code update (push a
// new bundle to R2, flip the prefix) from redeploying this security-critical
// Worker.
function moduleType(f) {
  if (f.endsWith('.js') || f.endsWith('.mjs')) return 'application/javascript+module';
  if (f.endsWith('.wasm')) return 'application/wasm';
  return 'application/octet-stream';
}
async function loadBundle(env, kind) {
  if (!env.BUNDLES) throw new Error('the Worker is missing the BUNDLES R2 binding');
  const prefix = kind === 'wp'
    ? (env.WP_BUNDLE_PREFIX || 'bundles/b-dosql/current/')
    : (env.C1_BUNDLE_PREFIX || 'bundles/c1/current/');
  const listed = await env.BUNDLES.list({ prefix });
  const objects = (listed && listed.objects) || [];
  const mods = [];
  for (const o of objects) {
    const f = o.key.slice(prefix.length);
    if (!f || f.endsWith('.map') || f === 'README.md' || !/\.(m?js|wasm|zip|bin|dat|data)$/.test(f)) continue;
    const obj = await env.BUNDLES.get(o.key);
    if (!obj) continue;
    const type = moduleType(f);
    const content = type === 'application/javascript+module' ? await obj.text() : new Uint8Array(await obj.arrayBuffer());
    mods.push({ name: f, content, type });
  }
  if (!mods.length) throw new Error(`no bundle modules under ${prefix} in the BUNDLES bucket`);
  return mods;
}

// ---- 8. Build the full server-side cfg --------------------------------------
// Mirrors cli.mjs buildCfg, but every value comes from env + the base + the
// bundle, never the request. Secrets are generated fresh here.
export async function buildServerCfg(env, { kind, name, domain, demo = false, expiresAt }) {
  const target = deriveTarget(env, { kind, name, domain });
  const compatibilityDate = env.WFP_COMPAT || '2026-07-01';
  const common = {
    name, namespace: target.namespace, kvId: target.kvId,
    compatibilityDate, compatibilityFlags: ['nodejs_compat'],
    modules: await loadBundle(env, kind),
  };
  if (kind === 'wp') {
    const mediaBucket = mediaBucketName(name);
    return {
      ...common, kind: 'wp', mainModule: env.WP_MAIN || 'index.js',
      hostname: target.hostname,
      // The FULL b-dosql binding + var set (deploy/wfp lib.sh render_user), from
      // the ONE shared source so the provisioning path and the deploy path cannot
      // drift. The caller supplies no extra bindings.
      resourceBindings: bDosqlBindings({ mediaBucket, siteOrigin: `https://${target.hostname}`, location: env.WFP_LOCATION || 'enam', cronIntervalMs: env.WFP_CRON_INTERVAL_MS }),
      sqliteClasses: ['PhpRuntime'],
      saasZoneId: target.saasZoneId,
      secrets: { WP_SALT: genSecret(), SPIKE_TOKEN: genSecret(24) },
      buckets: { media: mediaBucket },
      // Demo lane (#182 Path B): the entry is stamped ephemeral so the reaper can
      // find and fully tear it down. saasZoneId is carried for the DNS teardown.
      ...(demo ? { demo: true, expiresAt } : {}),
    };
  }
  // Only 'wp' (b-dosql) is built; the c1 'shop' store path was retired (#214).
  throw new Error(`buildServerCfg: only kind 'wp' is supported (c1 'shop' retired #214), got ${JSON.stringify(kind)}`);
}


// ---- Path B (public demo) controls ------------------------------------------
// Turnstile verify, FAIL CLOSED. The public demo form solves a Turnstile
// challenge; the worker verifies the token via siteverify before any
// provisioning. No long-lived operator token lives on this path. A missing
// secret, a missing token, a non-200, or success!==true all deny.
export async function verifyTurnstile(env, token, remoteip) {
  if (!env.TURNSTILE_SECRET || !token || typeof token !== 'string') return false;
  const form = new URLSearchParams();
  form.set('secret', env.TURNSTILE_SECRET);
  form.set('response', token);
  if (remoteip) form.set('remoteip', remoteip);
  let res;
  try {
    res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  } catch { return false; }
  if (!res || !res.ok) return false;
  let data;
  try { data = await res.json(); } catch { return false; }
  return !!(data && data.success === true);
}

// The PUBLIC caller supplies a Turnstile token and, at most, a kind. The kind is
// capped to the demo tier: a b-dosql blog ('wp') only, NEVER the elevated c1/VPS
// store ('shop'). The name is worker-assigned (not read here) and the base is a
// fixed demo base (env.DEMO_BASE), so a public caller configures nothing.
export function validatePublicRequest(body) {
  if (!body || typeof body !== 'object') throw new BadRequest('body must be a JSON object');
  const kind = body.kind === undefined ? 'wp' : body.kind;
  if (kind !== 'wp') throw new BadRequest('the public demo mints only a b-dosql blog (kind "wp"); the c1/VPS store is not available on the demo tier');
  return { kind: 'wp' };
}