// Minimal provisioning Worker (#154, stage 3): proves the SAME core runs inside
// a Worker. It POSTs a provision cfg and calls provisionSite, exactly as the
// CLI does, using the Worker's own fetch and Web Crypto (no node, no build).
// env.PROVISION_TOKEN is a Cloudflare API token with the scopes the ops need
// (Workers scripts, KV, R2, account tokens); env.CF_ACCOUNT_ID the account.
// The caller sends the cfg (including the PRE-BUILT bundle modules) in the body.
import { provisionSite } from './provision.mjs';

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('POST a provision cfg (JSON)\n', { status: 405 });
    }
    if (!env.CF_ACCOUNT_ID || !env.PROVISION_TOKEN) {
      return Response.json({ ok: false, error: 'the Worker is missing CF_ACCOUNT_ID or PROVISION_TOKEN' }, { status: 500 });
    }
    let cfg;
    try { cfg = await request.json(); } catch { return Response.json({ ok: false, error: 'body is not JSON' }, { status: 400 }); }
    const ctx = { acct: env.CF_ACCOUNT_ID, token: env.PROVISION_TOKEN };
    try {
      const r = await provisionSite(ctx, cfg);
      return Response.json({ ok: true, provisioned: r.kind, name: r.name, script: r.script, hostname: r.hostname });
    } catch (e) {
      return Response.json({ ok: false, error: e.message }, { status: 500 });
    }
  },
};
