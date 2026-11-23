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
import { bDosqlBindings, bDosqlResourceCreateOps, bDosqlSecrets, mediaBucketName, aBindings, ocKvNamespaceName, pageCacheInputs, pageCacheProductTtl, objectTimeInputs, aCacheInputs, dbQueryTimeoutInputs } from './wp-site-config.mjs';

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
// kinds: the kinds THIS caller allows. The default is 'wp' only, so the operator
// Worker's gate is unchanged. The one-click site manager also allows 'a' (#431): a
// Hyperdrive store, whose Hyperdrive config id the manager supplies from its own
// checked list, never from the request.
// #1063: a Worker placement region, the format Cloudflare documents ({provider}:{region}; AWS, GCP and Azure).
// The same rule as deploy.sh PLACEMENT (deploy/render-conf.sh placement_check).
export const PLACEMENT_REGION_RE = /^(aws|gcp|azure):[a-z0-9-]{2,40}$/;

export function validateRequest(body, { kinds = ['wp'] } = {}) {
  if (!body || typeof body !== 'object') throw new BadRequest('body must be a JSON object');
  const { kind, name, domain } = body;
  // The c1 'shop' store path was retired (#214): a store is a b-dosql site with
  // WooCommerce active, not a separate kind. Reject it with a clear pointer.
  if (kind === 'shop' || kind === 'store') throw new BadRequest('the c1 store path was retired (#214); a store is a b-dosql site, use kind "wp"');
  if (!kinds.includes(kind)) throw new BadRequest(kinds.length === 1 ? `kind must be "${kinds[0]}"` : `kind must be one of ${kinds.map((k) => `"${k}"`).join(', ')}`);
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
  if (kind === 'wp' || kind === 'a') {
    // A workers.dev base (the one-click admin, #414): each site answers on its own
    // front-door Worker, wp-<name>.<subdomain>.workers.dev. No zone, no DNS record.
    // The admin builds this base from the account's own workers.dev subdomain.
    if (base.workersDev === true) {
      if (typeof base.subdomain !== 'string' || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(base.subdomain)) {
        throw new Error(`base "${domain}" is a workers.dev base with no valid subdomain`);
      }
      return { kind, name, script: `site-${name}`, hostname: `wp-${name}.${base.subdomain}.workers.dev`, workersDev: true, namespace, kvId };
    }
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
function bundlePrefixFor(env, kind) {
  if (kind === 'wp') return env.WP_BUNDLE_PREFIX || 'bundles/b-dosql/current/';
  if (kind === 'a') return env.A_BUNDLE_PREFIX || 'bundles/a/current/';
  return env.C1_BUNDLE_PREFIX || 'bundles/c1/current/';
}
async function sha256HexBytes(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}
async function loadBundle(env, kind) {
  if (!env.BUNDLES) throw new Error('the Worker is missing the BUNDLES R2 binding');
  const prefix = bundlePrefixFor(env, kind);
  const listed = await env.BUNDLES.list({ prefix });
  const objects = (listed && listed.objects) || [];
  const mods = [];
  for (const o of objects) {
    const f = o.key.slice(prefix.length);
    // A slash is a pack under assets/_pf/, not a Worker module. A pack zip is too big for the script.
    if (!f || f.includes('/') || f === 'remote-packs-index.json' || f.endsWith('.map') || f === 'README.md' || !/\.(m?js|wasm|zip|bin|dat|data)$/.test(f)) continue;
    const obj = await env.BUNDLES.get(o.key);
    if (!obj) continue;
    const type = moduleType(f);
    const content = type === 'application/javascript+module' ? await obj.text() : new Uint8Array(await obj.arrayBuffer());
    mods.push({ name: f, content, type });
  }
  if (!mods.length) throw new Error(`no bundle modules under ${prefix} in the BUNDLES bucket`);
  return mods;
}

// The SHA-256 manifest.json names for the pack index, or null when this prefix has no manifest
// or the manifest does not name one (an older release, or a build with OPCACHE_REMOTE=0).
async function manifestAssetsPin(env, prefix) {
  const obj = await env.BUNDLES.get(prefix + 'manifest.json');
  if (!obj) return null;
  let manifest;
  try { manifest = JSON.parse(await obj.text()); }
  catch { throw new BadRequest('manifest.json is not JSON'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new BadRequest('manifest.json is not a manifest');
  if (!Object.hasOwn(manifest, 'assetsIndexSha256')) return null;
  const want = manifest.assetsIndexSha256;
  if (typeof want !== 'string' || !/^[0-9a-f]{64}$/.test(want)) {
    throw new BadRequest('manifest.json names assetsIndexSha256 but it is not a SHA-256');
  }
  return want;
}

// The remote packs next to the modules (#1036). Null when this bundle has no index (an older
// release, or one built with OPCACHE_REMOTE=0). A manifest that names assetsIndexSha256 with no
// index is refused: the built Worker imports the pack indexes and the zips are empty, so a site
// with no packs answers 503. A present index that does not match its files throws, so a site is
// never deployed with half of its packs.
async function loadPackAssets(env, kind) {
  if (!env.BUNDLES) return null;
  const prefix = bundlePrefixFor(env, kind);
  const pin = await manifestAssetsPin(env, prefix);
  const obj = await env.BUNDLES.get(prefix + 'remote-packs-index.json');
  if (!obj) {
    if (pin) throw new BadRequest('manifest.json names assetsIndexSha256 but remote-packs-index.json is missing');
    return null;
  }
  let index;
  try { index = JSON.parse(await obj.text()); } catch { throw new Error('remote-packs-index.json is not JSON'); }
  if (!index || index.schema !== 1 || !Array.isArray(index.files) || !index.files.length) {
    throw new Error('remote-packs-index.json is not a pack index');
  }
  const files = [];
  for (const f of index.files) {
    if (!f || typeof f.path !== 'string' || !f.path.startsWith('/_pf/') || f.path.includes('..')) {
      throw new Error('remote-packs-index.json has a bad path');
    }
    const got = await env.BUNDLES.get(prefix + 'assets' + f.path);
    if (!got) throw new Error(`missing pack ${f.path}`);
    const bytes = new Uint8Array(await got.arrayBuffer());
    if (bytes.byteLength !== f.size) throw new Error(`${f.path}: size ${bytes.byteLength}, index says ${f.size}`);
    const h = await sha256HexBytes(bytes);
    if (h !== f.sha256) throw new Error(`${f.path}: sha256 does not match the pack index`);
    files.push({ path: f.path, bytes, hash: f.hash, kind: f.kind });
  }
  return { buildId: index.buildId, opcache: index.opcache || null, site: index.site || null, files };
}

// Unset is on when the bundle carries packs. OPCACHE_REMOTE=0 and SITE_REMOTE=0 are the build's
// knobs: a bundle that carries the index already imported it, and the zips are empty, so turning
// either knob off here would answer 503. A bundle with no index renders nothing, the same as every
// site before #1036, and the knobs do nothing.
function remotePackConfig(env, packs) {
  if (!packs) return { opcacheRemote: false, siteRemote: false, assets: null };
  if (env.OPCACHE_REMOTE === '0' || env.SITE_REMOTE === '0') {
    throw new BadRequest('this bundle carries remote packs, so OPCACHE_REMOTE and SITE_REMOTE cannot be turned off when the site is added. Only the build can opt out (OPCACHE_REMOTE=0 while the bundle is built).');
  }
  const siteRemote = packs.site != null;
  const files = siteRemote ? packs.files : packs.files.filter((f) => f.kind !== 'site');
  if (!files.length) return { opcacheRemote: false, siteRemote: false, assets: null };
  return { opcacheRemote: true, siteRemote, assets: { files, runWorkerFirst: ['/_pf/*'] } };
}

function applyRemotePackBindings(bindings, remote) {
  const next = [];
  for (const b of bindings || []) {
    if (b && b.type === 'plain_text' && (b.name === 'OPCACHE_REMOTE' || b.name === 'SITE_REMOTE')) continue;
    next.push(b);
  }
  if (remote.opcacheRemote) next.push({ type: 'plain_text', name: 'OPCACHE_REMOTE', text: 'on' });
  if (remote.siteRemote) next.push({ type: 'plain_text', name: 'SITE_REMOTE', text: 'on' });
  return next;
}

// ---- 8. Build the full server-side cfg --------------------------------------
// Mirrors cli.mjs buildCfg, but every value comes from env + the base + the
// bundle, never the request. Secrets are generated fresh here.
// HYPERDRIVE_ID_RE: a Hyperdrive config id is 32 lower-case hex characters.
export const HYPERDRIVE_ID_RE = /^[0-9a-f]{32}$/;
// A WordPress table prefix for a Hyperdrive store: letters, digits and underscores,
// ending in an underscore, at most 40 characters (several stores share a database).
export const TABLE_PREFIX_RE = /^[A-Za-z0-9_]{1,39}_$/;

export async function buildServerCfg(env, { kind, name, domain, demo = false, expiresAt, codeLock = false, hyperdriveId, tablePrefix, hyperdriveSqlMode, store = false, placementRegion }) {
  // #706: refuse a bad TTL or a bad WOO_ACTIVE before the bundle is read.
  try { pageCacheProductTtl(pageCacheInputs(env, { store })); objectTimeInputs(env); aCacheInputs(env); dbQueryTimeoutInputs(env); }
  catch (e) { throw new BadRequest(e.message); }
  // Kind 'a' (#431): checked before any IO, so a bad call loads no bundle.
  if (kind === 'a') {
    if (typeof hyperdriveId !== 'string' || !HYPERDRIVE_ID_RE.test(hyperdriveId)) throw new Error('buildServerCfg: kind a needs a Hyperdrive config id (32 lower-case hex)');
    if (typeof tablePrefix !== 'string' || !TABLE_PREFIX_RE.test(tablePrefix)) throw new Error('buildServerCfg: kind a needs a table prefix (letters, digits, underscores, ending in _, at most 40)');
    if (demo) throw new Error('buildServerCfg: a demo site is kind wp only');
    // #1063: the database's region, so the Worker runs next to it. Optional here: the caller decides when it is
    // required (the site manager requires it for a NEW store).
    if (placementRegion !== undefined && !PLACEMENT_REGION_RE.test(String(placementRegion))) throw new BadRequest(`buildServerCfg: the placement region must be <aws|gcp|azure>:<region>, for example azure:westus2`);
  }
  const target = deriveTarget(env, { kind, name, domain });
  const compatibilityDate = env.WFP_COMPAT || '2026-07-01';
  const modules = await loadBundle(env, kind);
  // Packs are attached by provisionSite after the existing-site return (#1036). Building them
  // here hashed about 41 MB before a re-add that does not deploy.
  const common = {
    name, namespace: target.namespace, kvId: target.kvId,
    compatibilityDate, compatibilityFlags: ['nodejs_compat', 'enable_request_signal'], // #721
    modules,
  };
  const finish = (cfg) => {
    cfg.attachRemotePacks = async () => {
      const got = remotePackConfig(env, await loadPackAssets(env, kind));
      if (got.assets) cfg.assets = got.assets;
      cfg.resourceBindings = applyRemotePackBindings(cfg.resourceBindings, got);
    };
    return cfg;
  };
  if (kind === 'wp') {
    const mediaBucket = mediaBucketName(name);
    // ONE opts object feeds the descriptor reducer for bindings, generated secrets
    // AND the provision-time resource ops, so the default-on object-cache-L2 and
    // async-email-queue descriptors provision their per-site backing resource on the
    // HOSTED provisioning path too. Without resourceCreateOps here, the OC_KV /
    // EMAIL_QUEUE bindings would deploy with no namespace / queue behind them.
    const bdosqlOpts = { mediaBucket, siteOrigin: `https://${target.hostname}`, location: env.WFP_LOCATION || 'enam', cronIntervalMs: env.WFP_CRON_INTERVAL_MS, mailFrom: target.workersDev ? undefined : `wordpress@${domain}`, mailFromName: name, demo: demo === true, codeLock: codeLock === true, siteName: name, ...pageCacheInputs(env, { store }), ...objectTimeInputs(env), opcacheRemote: false, siteRemote: false };
    return finish({
      ...common, kind: 'wp', mainModule: env.WP_MAIN || 'index.js',
      hostname: target.hostname,
      // The FULL b-dosql binding + var set (deploy/wfp lib.sh render_user), from
      // the ONE shared source so the provisioning path and the deploy path cannot
      // drift. The caller supplies no extra bindings.
      resourceBindings: bDosqlBindings(bdosqlOpts),
      sqliteClasses: ['PhpRuntime'],
      saasZoneId: target.saasZoneId,
      secrets: { WP_SALT: genSecret(), SPIKE_TOKEN: genSecret(24), ...bDosqlSecrets(bdosqlOpts) },
      resourceCreateOps: bDosqlResourceCreateOps(bdosqlOpts),
      buckets: { media: mediaBucket },
      // Demo lane (#182 Path B): the entry is stamped ephemeral so the reaper can
      // find and fully tear it down. saasZoneId is carried for the DNS teardown.
      ...(demo ? { demo: true, expiresAt } : {}),
    });
  }
  if (kind === 'a') {
    // Approach A (#431, #218): PHP in the Worker, managed MySQL through Hyperdrive.
    // The same shape as deploy/provision/cli.mjs kind 'a' (#243): entry
    // index-a-lean.js, the aBindings set, NO Durable Object (so no SQLite
    // migration), and the per-site OC_KV namespace the core creates and binds.
    // The Hyperdrive config id and the table prefix come from the trusted caller
    // (the site manager's own checked database list), never from a request body.
    // The code lock is on by default in the runtime (site-lock.mjs, #461).
    const mediaBucket = mediaBucketName(name);
    return finish({
      ...common, kind: 'a', mainModule: env.A_MAIN || 'index-a-lean.js',
      hostname: target.hostname,
      resourceBindings: aBindings({
        mediaBucket, hyperdriveId, tablePrefix, hyperdriveSqlMode,
        siteOrigin: `https://${target.hostname}`,
        mailFrom: target.workersDev ? undefined : `wordpress@${domain}`, mailFromName: name,
        siteName: name,
        ...pageCacheInputs(env, { store }),
        ...objectTimeInputs(env),
        ...aCacheInputs(env), // #296: the escape hatch for the two cache defaults
        opcacheRemote: false, siteRemote: false, // #1036: attachRemotePacks turns these on when the bundle carries packs
        ...dbQueryTimeoutInputs(env), // #1364
      }),
      sqliteClasses: [],
      ...(placementRegion ? { placement: { mode: 'targeted', region: placementRegion } } : {}),
      kvNamespaces: [{ title: ocKvNamespaceName(name), binding: 'OC_KV' }],
      saasZoneId: target.saasZoneId,
      secrets: { WP_SALT: genSecret(), SPIKE_TOKEN: genSecret(24) },
      buckets: { media: mediaBucket },
    });
  }
  // Only 'wp' (b-dosql) and 'a' (approach A) are built; the c1 'shop' store path was retired (#214).
  throw new Error(`buildServerCfg: only kinds 'wp' and 'a' are supported (c1 'shop' retired #214), got ${JSON.stringify(kind)}`);
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