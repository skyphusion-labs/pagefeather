// Provisioning Worker, two hardened front doors over one inverted-cfg core (#182).
// The caller always sends only { kind, name?, domain? }; the Worker builds every
// binding and the code. See server-config.mjs for the security boundary, demo.mjs
// for the Path B controls, and HARDENING.md for the design and token policies.
// Still NOT routed; the lead owns the deploy gate.
//
//   Path A (private): POST /         operator bearer, b-dosql (wp), caller names it.
//   Path B (public):  POST /demo     Turnstile, demo-tier b-dosql only, ephemeral.
import { provisionSite } from './provision.mjs';
import { readSite } from './registry.mjs';
import {
  authorize, enforceRateLimit, callerKey,
  validateRequest, selectToken, deriveTarget, buildServerCfg, BadRequest,
  verifyTurnstile, validatePublicRequest,
} from './server-config.mjs';
import {
  assignDemoName, DEMO_TTL_MS, DEMO_MAX_PER_IP_PER_HOUR, DEMO_MAX_GLOBAL_PER_HOUR, DEMO_MAX_CONCURRENT,
} from './shared.mjs';
import { checkDemoRate, bumpDemoRate, demoConcurrency, reapExpiredDemos } from './demo.mjs';

// Path A env. PROVISION_AUTH is enforced by authorize() (fail closed to 401).
// ONE restricted token (#214): the c1 'shop' path and its elevated token are gone,
// so the Worker holds no token-minting or Containers capability.
const PATH_A_ENV = ['CF_ACCOUNT_ID', 'WP_PROVISION_TOKEN', 'WFP_KV_ID', 'WFP_BASES', 'RATE_LIMITER', 'BUNDLES'];
// Path B env. NO operator token, NO SHOP token (the public path is never elevated),
// NO RATE_LIMITER (it uses the DEMO_KV counter). TURNSTILE_SECRET gates it.
const PATH_B_ENV = ['CF_ACCOUNT_ID', 'WP_PROVISION_TOKEN', 'WFP_KV_ID', 'WFP_BASES', 'BUNDLES', 'TURNSTILE_SECRET', 'DEMO_KV', 'DEMO_BASE'];

const json = (obj, status) => Response.json(obj, { status });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST') {
      return new Response('POST / (operator) or POST /demo (public demo), JSON\n', { status: 405 });
    }
    if (url.pathname === '/demo') return handleDemo(request, env);
    return handleOperator(request, env);
  },

  // The reaper: a cron/alarm fires this; it tears down every EXPIRED demo fully.
  async scheduled(event, env, ctx) {
    const run = reapExpiredDemos(env);
    if (ctx && ctx.waitUntil) ctx.waitUntil(run);
    return run;
  },
};

// ---- Path A: private operator provisioning ----------------------------------
async function handleOperator(request, env) {
  if (!(await authorize(request, env))) return json({ ok: false, error: 'unauthorized' }, 401);
  const missing = PATH_A_ENV.filter((k) => !env[k]);
  if (missing.length) return json({ ok: false, error: `the Worker is missing: ${missing.join(', ')}` }, 500);
  if (!(await enforceRateLimit(env, callerKey(request)))) return json({ ok: false, error: 'rate limited' }, 429);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'body is not JSON' }, 400); }
  let req;
  try { req = validateRequest(body); } catch (e) { return json({ ok: false, error: e.message }, 400); }

  try {
    const ctx = { acct: env.CF_ACCOUNT_ID, token: selectToken(env, req.kind), dispatcher: env.DISPATCHER };
    const target = deriveTarget(env, req);
    const existing = await readSite(ctx, { kvId: target.kvId, hostname: target.hostname });
    if (existing && typeof existing.script === 'string') {
      const admin = existing.adminUrl ? { url: existing.adminUrl, user: existing.adminUser || 'admin' } : undefined;
      return json({ ok: true, provisioned: existing.kind, name: req.name, script: existing.script, hostname: target.hostname, existing: true, installed: !!existing.installed, admin }, 200);
    }
    const cfg = await buildServerCfg(env, req);
    const r = await provisionSite(ctx, cfg);
    return json({ ok: true, provisioned: r.kind, name: r.name, script: r.script, hostname: r.hostname, existing: !!r.existing, installed: !!r.installed, admin: r.admin }, 200);
  } catch (e) {
    return json({ ok: false, error: e.message }, e instanceof BadRequest ? 400 : 500);
  }
}

// ---- Path B: public demo provisioning ---------------------------------------
// Turnstile-gated, demo-tier b-dosql only, worker-assigned name, rate + concurrency
// capped, ephemeral (TTL + reaper). It uses ONLY the restricted WP token and never
// the elevated SHOP token, so the public path cannot mint an account token.
async function handleDemo(request, env) {
  const missing = PATH_B_ENV.filter((k) => !env[k]);
  if (missing.length) return json({ ok: false, error: `the demo Worker is missing: ${missing.join(', ')}` }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'body is not JSON' }, 400); }
  const ip = callerKey(request);

  // 1. Turnstile, fail closed, BEFORE anything else.
  const token = (body && typeof body === 'object' && body.turnstileToken) || request.headers.get('cf-turnstile-response');
  if (!(await verifyTurnstile(env, token, ip))) return json({ ok: false, error: 'turnstile verification failed' }, 403);

  // 2. Kind cap: demo tier is b-dosql blog only.
  let pub;
  try { pub = validatePublicRequest(body); } catch (e) { return json({ ok: false, error: e.message }, 400); }

  // 3. Rate limit, per-IP AND global.
  const rate = await checkDemoRate(env, ip, { perIpPerHour: DEMO_MAX_PER_IP_PER_HOUR, globalPerHour: DEMO_MAX_GLOBAL_PER_HOUR });
  if (!rate.ok) return json({ ok: false, error: `rate limited (${rate.scope})` }, 429);

  // 4. Concurrency cap (the primary spend bound).
  const ctx = { acct: env.CF_ACCOUNT_ID, token: env.WP_PROVISION_TOKEN, dispatcher: env.DISPATCHER };
  const live = await demoConcurrency(ctx, { kvId: env.WFP_KV_ID });
  if (live >= DEMO_MAX_CONCURRENT) return json({ ok: false, error: 'demo capacity full' }, 503);

  // Commit: count this demo against the rate budget, then provision it.
  try {
    await bumpDemoRate(env, ip);
    const name = assignDemoName();            // worker-assigned, never the caller's
    const expiresAt = Date.now() + DEMO_TTL_MS;
    const cfg = await buildServerCfg(env, { kind: pub.kind, name, domain: env.DEMO_BASE, demo: true, expiresAt });
    const r = await provisionSite(ctx, cfg);
    return json({ ok: true, demo: true, name, hostname: r.hostname, expiresAt, ttlMs: DEMO_TTL_MS, installed: !!r.installed, admin: r.admin }, 200);
  } catch (e) {
    return json({ ok: false, error: e.message }, e instanceof BadRequest ? 400 : 500);
  }
}
