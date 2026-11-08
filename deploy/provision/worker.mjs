// Provisioning Worker, the hardened front door (#182). The old version POSTed a
// whole caller-supplied cfg to provisionSite with NO auth, holding a token that
// can mint account tokens: an unauthenticated POST was account takeover. This
// version is the opposite shape. The authenticated caller sends ONLY
// { kind, name, domain }; the Worker builds everything else (modules, bindings,
// namespace, kv id, zone, secrets) from its OWN trusted config, so a caller can
// neither upload code nor target another tenant's resources. See server-config.mjs
// for the security boundary and HARDENING.md for the design and the two token
// policies. Still NOT routed; the lead owns the deploy gate.
import { provisionSite } from './provision.mjs';
import { readSite } from './registry.mjs';
import {
  authorize, enforceRateLimit, callerKey,
  validateRequest, selectToken, deriveTarget, buildServerCfg, BadRequest,
} from './server-config.mjs';

// Bindings and vars the Worker must have to run. PROVISION_AUTH is enforced by
// authorize() (a missing secret fails closed to 401), so it is checked there,
// not here. RATE_LIMITER and BUNDLES are bindings; the token VALUES are secrets.
const REQUIRED_ENV = ['CF_ACCOUNT_ID', 'WP_PROVISION_TOKEN', 'SHOP_PROVISION_TOKEN', 'WFP_KV_ID', 'WFP_BASES', 'RATE_LIMITER', 'BUNDLES'];

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('POST { "kind": "wp"|"shop", "name": "...", "domain": "..." } (JSON)\n', { status: 405 });
    }
    // Auth first, so a misconfigured Worker never leaks its config state to an
    // unauthenticated caller. authorize() fails closed when PROVISION_AUTH is absent.
    if (!(await authorize(request, env))) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
    const missing = REQUIRED_ENV.filter((k) => !env[k]);
    if (missing.length) {
      return Response.json({ ok: false, error: `the Worker is missing: ${missing.join(', ')}` }, { status: 500 });
    }
    // Rate limit per caller (binding guaranteed present by the check above).
    if (!(await enforceRateLimit(env, callerKey(request)))) {
      return Response.json({ ok: false, error: 'rate limited' }, { status: 429 });
    }
    let body;
    try { body = await request.json(); } catch { return Response.json({ ok: false, error: 'body is not JSON' }, { status: 400 }); }
    let req;
    try { req = validateRequest(body); } catch (e) { return Response.json({ ok: false, error: e.message }, { status: 400 }); }

    try {
      const ctx = { acct: env.CF_ACCOUNT_ID, token: selectToken(env, req.kind) };
      // Idempotency pre-check: derive the hostname cheaply and return an existing
      // site WITHOUT loading the bundle or touching the account. provisionSite
      // guards this again (defense in depth), but the pre-check avoids the bundle
      // read on a duplicate request.
      const target = deriveTarget(env, req);
      const existing = await readSite(ctx, { kvId: target.kvId, hostname: target.hostname });
      if (existing && typeof existing.script === 'string') {
        return Response.json({ ok: true, provisioned: existing.kind, name: req.name, script: existing.script, hostname: target.hostname, existing: true });
      }
      const cfg = await buildServerCfg(env, req);
      const r = await provisionSite(ctx, cfg);
      return Response.json({ ok: true, provisioned: r.kind, name: r.name, script: r.script, hostname: r.hostname, existing: !!r.existing });
    } catch (e) {
      const status = e instanceof BadRequest ? 400 : 500;
      return Response.json({ ok: false, error: e.message }, { status });
    }
  },
};
