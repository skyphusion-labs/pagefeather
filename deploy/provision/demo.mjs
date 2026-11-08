// Public demo lane (#182 Path B): the controls that make the public front door
// safe to operate. Rate limit (per-IP + global), a hard concurrency ceiling, and
// the reaper that tears every expired demo down FULLY. All offline-testable with
// a stubbed KV binding and a stubbed fetchImpl; the lead owns the deploy gate.
import { listSites, readSite, removeSite } from './registry.mjs';
import { deleteNamespaceScript, deleteR2Bucket, deleteProxiedHostname } from './ops.mjs';
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
// Order matters: delete the serving script FIRST, then the bucket, then the DNS
// record, and remove the KV entry LAST, so a partial failure leaves the entry in
// place for the next run to retry (idempotent). One site's failure never stops
// the others.
export async function teardownDemoSite(ctx, env, hostname, entry) {
  const ns = env.WFP_NAMESPACE || 'wp-wfp';
  const done = { hostname, script: false, bucket: false, dns: false, kv: false };
  if (entry.script) { await deleteNamespaceScript(ctx, { ns, name: entry.script }); done.script = true; }
  if (entry.mediaBucket) { await deleteR2Bucket(ctx, entry.mediaBucket); done.bucket = true; }
  if (entry.saasZoneId) { await deleteProxiedHostname(ctx, { zoneId: entry.saasZoneId, hostname }); done.dns = true; }
  await removeSite(ctx, { kvId: env.WFP_KV_ID, hostname }); done.kv = true;
  return done;
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
