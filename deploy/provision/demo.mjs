// Public demo lane (#182 Path B): the controls that make the public front door
// safe to operate. Rate limit (per-IP + global), a hard concurrency ceiling, and
// the reaper that tears every expired demo down FULLY. All offline-testable with
// a stubbed KV binding and a stubbed fetchImpl; the lead owns the deploy gate.
import { listSites, readSite } from './registry.mjs';
import { removeNamespaceSite } from './provision.mjs';
import { DEMO_NAME_PREFIX } from './shared.mjs';

// ---- Rate limit: per-IP AND global, hour-bucketed KV counters ----------------
// env.DEMO_KV is a KV binding. FAIL CLOSED on a KV error: a spend-bounded public
// path denies rather than admits when it cannot measure.
export async function checkDemoRate(env, ip, { perIpPerHour, globalPerHour }) {
  const hour = Math.floor(Date.now() / 3600000);
  try {
    const ipN = Number(await env.DEMO_KV.get(`rl:ip:${ip}:${hour}`)) || 0;
    if (ipN >= perIpPerHour) return { ok: false, scope: 'ip' };
    const gN = Number(await env.DEMO_KV.get(`rl:global:${hour}`)) || 0;
    if (gN >= globalPerHour) return { ok: false, scope: 'global' };
    return { ok: true };
  } catch { return { ok: false, scope: 'error' }; }
}

// Bump both counters after a demo is ACCEPTED (post-Turnstile, post-caps). Hour
// buckets expire on their own (TTL), so no cleanup is needed.
export async function bumpDemoRate(env, ip) {
  const hour = Math.floor(Date.now() / 3600000);
  const bump = async (key) => {
    const n = Number(await env.DEMO_KV.get(key)) || 0;
    await env.DEMO_KV.put(key, String(n + 1), { expirationTtl: 7200 });
  };
  await bump(`rl:ip:${ip}:${hour}`);
  await bump(`rl:global:${hour}`);
}

// ---- Concurrency: count live demo sites in the registry ---------------------
// The primary SPEND bound. Demo hostnames start with the demo lane prefix, so a
// prefix list of the site map counts them.
export async function demoConcurrency(ctx, { kvId }) {
  const hosts = await listSites(ctx, { kvId, prefix: DEMO_NAME_PREFIX });
  return hosts.length;
}

// ---- Reaper: tear down every EXPIRED demo, FULLY ----------------------------
// One removal for every core-path site (#782, provision.mjs removeNamespaceSite): traffic first (the DNS record),
// then the script, the per-site KV namespace, the queues, the search index and the bucket, and the KV entry LAST,
// so a partial failure leaves the entry in place for the next run to retry (idempotent). One site's failure never
// stops the others. The resource names derive from the site name (wp-site-config.mjs), so the entry does not need
// to carry ids; each delete treats "not there" as done.
export async function teardownDemoSite(ctx, env, hostname, entry) {
  const ns = env.WFP_NAMESPACE || 'wp-wfp';
  const name = entry.name || (typeof entry.script === 'string' ? entry.script.replace(/^site-/, '') : '');
  const r = await removeNamespaceSite(ctx, { ns, kvId: env.WFP_KV_ID, hostname, name, entry, saasZoneId: entry.saasZoneId, deleteData: true });
  const did = (part) => r.done.some((d) => d.part === part);
  return {
    hostname, script: did('site code and database'), bucket: did('media bucket'), kvNamespace: did('object cache'),
    queues: did('email queues'), dns: did('DNS record'), kv: did('site entry'),
  };
}

export async function reapExpiredDemos(env, now = Date.now()) {
  const ctx = { acct: env.CF_ACCOUNT_ID, token: env.WP_PROVISION_TOKEN };
  const hosts = await listSites(ctx, { kvId: env.WFP_KV_ID, prefix: DEMO_NAME_PREFIX });
  const reaped = [], failed = [];
  for (const hostname of hosts) {
    const entry = await readSite(ctx, { kvId: env.WFP_KV_ID, hostname });
    if (!entry || !entry.demo || typeof entry.expiresAt !== 'number' || entry.expiresAt > now) continue;
    try { reaped.push(await teardownDemoSite(ctx, env, hostname, entry)); }
    catch (e) { failed.push({ hostname, error: e.message }); }
  }
  return { reaped: reaped.length, failed: failed.length, details: { reaped, failed } };
}
