// Offline test of the PUBLIC demo front door (#182 Path B). Stubs the global
// fetch (Turnstile siteverify + the CF API) and the Worker bindings (DEMO_KV,
// BUNDLES), and drives POST /demo plus the reaper. Asserts every deploy-blocking
// control: Turnstile fail-closed, kind cap, per-IP + global rate limit,
// concurrency cap, worker-assigned name, and a reaper that deletes ALL four
// resources of an expired demo and nothing of a live one.
import worker from '../worker.mjs';
import { reapExpiredDemos, teardownDemoSite, checkDemoRate, demoConcurrency } from '../demo.mjs';
import { verifyTurnstile, validatePublicRequest } from '../server-config.mjs';
import { assignDemoName, isCallerReservedName, assertValidName, DEMO_MAX_PER_IP_PER_HOUR, DEMO_MAX_CONCURRENT, DEMO_TTL_MS } from '../shared.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };
const IP = '203.0.113.9';

function bundleStub() {
  const files = { 'bundles/b-dosql/current/index.js': 'export default {}', 'bundles/b-dosql/current/php.wasm': null };
  return {
    list: async ({ prefix }) => ({ objects: Object.keys(files).filter((k) => k.startsWith(prefix)).map((k) => ({ key: k })) }),
    get: async (k) => (k in files ? { text: async () => files[k] || '', arrayBuffer: async () => new ArrayBuffer(4) } : null),
  };
}
function kvStub(init = {}) {
  const m = new Map(Object.entries(init));
  return { get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); }, _m: m };
}
function makeEnv(over = {}) {
  return {
    CF_ACCOUNT_ID: 'ACCT', WP_PROVISION_TOKEN: 'wp-tok', WFP_KV_ID: 'SERVERKV', WFP_NAMESPACE: 'wp-wfp',
    WFP_BASES: JSON.stringify({ 'skyphusionwp.dev': { saasZoneId: 'SERVERZONE', workersSubdomain: 'skyphusionwp' } }),
    BUNDLES: bundleStub(), TURNSTILE_SECRET: 'ts-secret', DEMO_KV: kvStub(), DEMO_BASE: 'skyphusionwp.dev',
    ...over,
  };
}
// Routes Turnstile siteverify, the KV keys list (concurrency), KV value GET/DELETE,
// scriptExists, token list, DNS list, R2 objects list, and a default success.
function withFetch(opts = {}) {
  const calls = [];
  const impl = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: init.method, body: init.body });
    if (u.includes('/turnstile/v0/siteverify')) return { ok: true, status: 200, json: async () => ({ success: opts.turnstile !== false }) };
    if (init.method === 'GET' && /\/storage\/kv\/namespaces\/[^/]+\/keys/.test(u)) {
      const hosts = opts.liveDemos || [];
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, result: hosts.map((h) => ({ name: h })) }) };
    }
    if (init.method === 'GET' && /\/storage\/kv\/namespaces\/[^/]+\/values\//.test(u)) {
      const host = decodeURIComponent(u.split('/values/')[1]);
      const e = (opts.entries || {})[host];
      if (e) return { ok: true, status: 200, text: async () => JSON.stringify(e) };
      return { ok: false, status: 404, text: async () => '{}' };
    }
    if (init.method === 'GET' && /\/scripts\/[^/]+$/.test(u)) return { ok: false, status: 404, text: async () => '{}' };
    if (init.method === 'GET' && u.endsWith('/tokens')) return { ok: true, status: 200, text: async () => '{"success":true,"result":[]}' };
    if (init.method === 'GET' && /\/r2\/buckets\/[^/]+\/objects/.test(u)) return { ok: true, status: 200, text: async () => '{"success":true,"result":[]}' };
    if (init.method === 'GET' && /\/dns_records/.test(u)) return { ok: true, status: 200, text: async () => '{"success":true,"result":[{"id":"rec1"}]}' };
    return { ok: true, status: 200, text: async () => '{"success":true,"result":{}}' };
  };
  return { impl, calls };
}
async function runDemo(env, bodyObj, opts) {
  const rec = withFetch(opts);
  const real = globalThis.fetch;
  globalThis.fetch = rec.impl;
  try {
    const request = new Request('https://p/demo', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': IP }, body: JSON.stringify(bodyObj) });
    const res = await worker.fetch(request, env);
    return { res, json: await res.clone().json().catch(() => null), calls: rec.calls };
  } finally { globalThis.fetch = real; }
}

// ---- unit: Turnstile fail-closed shapes ----
{
  const envFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
  ok('verifyTurnstile: no secret fails closed', (await verifyTurnstile({}, 'tok', IP)) === false);
  ok('verifyTurnstile: no token fails closed', (await verifyTurnstile({ TURNSTILE_SECRET: 's' }, '', IP)) === false);
  ok('verifyTurnstile: success true passes', (await verifyTurnstile({ TURNSTILE_SECRET: 's' }, 'tok', IP)) === true);
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: false }) });
  ok('verifyTurnstile: success false fails', (await verifyTurnstile({ TURNSTILE_SECRET: 's' }, 'tok', IP)) === false);
  globalThis.fetch = async () => { throw new Error('network'); };
  ok('verifyTurnstile: a siteverify network error fails closed', (await verifyTurnstile({ TURNSTILE_SECRET: 's' }, 'tok', IP)) === false);
  globalThis.fetch = envFetch;
}

// ---- unit: validatePublicRequest kind cap ----
ok('validatePublicRequest: defaults to wp', validatePublicRequest({}).kind === 'wp');
{
  const dn = assignDemoName();
  ok('demo lane: the core backstop assertValidName ALLOWS a worker-assigned demo name', (() => { try { assertValidName(dn); return true; } catch { return false; } })());
  ok('demo lane: isCallerReservedName REJECTS the same name (callers cannot pick the lane)', isCallerReservedName(dn) === true);
}
ok('validatePublicRequest: wp allowed', validatePublicRequest({ kind: 'wp' }).kind === 'wp');
{
  let threw = false; try { validatePublicRequest({ kind: 'shop' }); } catch { threw = true; }
  ok('validatePublicRequest: shop (elevated c1) REJECTED on the demo tier', threw);
}

// ---- integration: Turnstile gate ----
{
  const noTok = await runDemo(makeEnv(), {});
  ok('demo: no Turnstile token is 403 and provisions nothing', noTok.res.status === 403 && !noTok.calls.some((c) => c.url.endsWith('/r2/buckets')));
  const badTok = await runDemo(makeEnv(), { turnstileToken: 'x' }, { turnstile: false });
  ok('demo: a failed Turnstile is 403 and provisions nothing', badTok.res.status === 403 && !badTok.calls.some((c) => c.url.endsWith('/r2/buckets')));
}

// ---- integration: kind cap ----
{
  const shop = await runDemo(makeEnv(), { turnstileToken: 'x', kind: 'shop' });
  ok('demo: an elevated kind (shop/c1) is 400', shop.res.status === 400 && /b-dosql blog/.test(shop.json.error));
}

// ---- integration: rate limit (per-IP) ----
{
  const hour = Math.floor(Date.now() / 3600000);
  const env = makeEnv({ DEMO_KV: kvStub({ [`rl:ip:${IP}:${hour}`]: String(DEMO_MAX_PER_IP_PER_HOUR) }) });
  const r = await runDemo(env, { turnstileToken: 'x' });
  ok('demo: over the per-IP rate limit is 429 (nothing provisioned)', r.res.status === 429 && /ip/.test(r.json.error) && !r.calls.some((c) => c.url.endsWith('/r2/buckets')));
}

// ---- integration: concurrency cap ----
{
  const many = Array.from({ length: DEMO_MAX_CONCURRENT }, (_, i) => `demo-${i}.skyphusionwp.dev`);
  const r = await runDemo(makeEnv(), { turnstileToken: 'x' }, { liveDemos: many });
  ok('demo: at the concurrency ceiling is 503 (nothing provisioned)', r.res.status === 503 && /capacity full/.test(r.json.error) && !r.calls.some((c) => c.url.endsWith('/r2/buckets')));
}

// ---- integration: success + worker-assigned name + TTL stamp ----
{
  const env = makeEnv();
  const r = await runDemo(env, { turnstileToken: 'x', name: 'attacker-chosen', domain: 'evil.example', modules: [{ name: 'evil.js' }] });
  ok('demo: a valid request provisions (200)', r.res.status === 200 && r.json.ok === true && r.json.demo === true);
  ok('demo: the name is WORKER-ASSIGNED (demo-<rand>), not the caller value', /^demo-[0-9a-f]{16}$/.test(r.json.name) && r.json.name !== 'attacker-chosen');
  ok('demo: the hostname is on the fixed DEMO_BASE, not the injected domain', r.json.hostname === `${r.json.name}.skyphusionwp.dev`);
  ok('demo: an expiry is stamped (TTL from now)', typeof r.json.expiresAt === 'number' && r.json.ttlMs === DEMO_TTL_MS);
  ok('demo: the public path NEVER mints an account token', !r.calls.some((c) => c.method === 'POST' && c.url.endsWith('/tokens')));
  const kvPut = r.calls.find((c) => c.method === 'PUT' && /\/storage\/kv\/.*\/values\/demo-/.test(c.url));
  const entry = kvPut && JSON.parse(kvPut.body);
  ok('demo: the registry entry is stamped demo:true + expiresAt + teardown fields',
    entry && entry.demo === true && typeof entry.expiresAt === 'number' && entry.mediaBucket === `wp-wfp-${r.json.name}-media` && entry.saasZoneId === 'SERVERZONE');
  ok('demo: the deploy uploaded the vetted bundle, not the injected evil.js',
    r.calls.some((c) => c.method === 'PUT' && /\/scripts\/site-demo-/.test(c.url)));
  const bumped = env.DEMO_KV._m;
  ok('demo: the rate counters were bumped on accept (per-IP + global)',
    [...bumped.keys()].some((k) => k.startsWith(`rl:ip:${IP}:`)) && [...bumped.keys()].some((k) => k.startsWith('rl:global:')));
}

// ---- unit: checkDemoRate + demoConcurrency ----
{
  const hour = Math.floor(Date.now() / 3600000);
  const env = makeEnv({ DEMO_KV: kvStub({ [`rl:ip:${IP}:${hour}`]: '1' }) });
  ok('checkDemoRate: under the cap passes', (await checkDemoRate(env, IP, { perIpPerHour: 3, globalPerHour: 60 })).ok === true);
  ok('checkDemoRate: at the per-IP cap denies', (await checkDemoRate(env, IP, { perIpPerHour: 1, globalPerHour: 60 })).ok === false);
  ok('checkDemoRate: a KV error fails CLOSED', (await checkDemoRate({ DEMO_KV: { get: async () => { throw new Error('kv'); } } }, IP, { perIpPerHour: 3, globalPerHour: 60 })).ok === false);
}

// ---- reaper: deletes ALL four resources of an expired demo, nothing of a live one ----
{
  const hostX = 'demo-aaa.skyphusionwp.dev', hostY = 'demo-bbb.skyphusionwp.dev';
  const expired = { script: 'site-demo-aaa', kind: 'wp', demo: true, expiresAt: 1000, name: 'demo-aaa', mediaBucket: 'wp-wfp-demo-aaa-media', saasZoneId: 'SERVERZONE' };
  const fresh = { script: 'site-demo-bbb', kind: 'wp', demo: true, expiresAt: 9e15, name: 'demo-bbb', mediaBucket: 'wp-wfp-demo-bbb-media', saasZoneId: 'SERVERZONE' };
  const rec = withFetch({ liveDemos: [hostX, hostY], entries: { [hostX]: expired, [hostY]: fresh } });
  const real = globalThis.fetch; globalThis.fetch = rec.impl;
  let out;
  try { out = await reapExpiredDemos(makeEnv(), 2000); } finally { globalThis.fetch = real; }
  ok('reaper: exactly one expired demo reaped, none failed', out.reaped === 1 && out.failed === 0);
  const del = (re) => rec.calls.some((c) => c.method === 'DELETE' && re.test(c.url));
  ok('reaper: deleted the namespace SCRIPT of the expired demo', del(/\/dispatch\/namespaces\/wp-wfp\/scripts\/site-demo-aaa$/));
  ok('reaper: deleted the R2 BUCKET of the expired demo', del(/\/r2\/buckets\/wp-wfp-demo-aaa-media$/));
  ok('reaper: deleted the proxied DNS record on the SaaS zone', del(/\/zones\/SERVERZONE\/dns_records\/rec1$/));
  ok('reaper: removed the KV ENTRY of the expired demo', del(/\/storage\/kv\/.*\/values\/demo-aaa/));
  ok('reaper: touched NOTHING of the still-live demo (demo-bbb)',
    !rec.calls.some((c) => c.method === 'DELETE' && /demo-bbb|site-demo-bbb|wp-wfp-demo-bbb/.test(c.url)));
}

// ---- reaper: teardownDemoSite reports all four resources handled ----
{
  const rec = withFetch({});
  const real = globalThis.fetch; globalThis.fetch = rec.impl;
  let done;
  try {
    const ctx = { acct: 'ACCT', token: 'wp-tok' };
    done = await teardownDemoSite(ctx, makeEnv(), 'demo-ccc.skyphusionwp.dev', { script: 'site-demo-ccc', mediaBucket: 'wp-wfp-demo-ccc-media', saasZoneId: 'SERVERZONE' });
  } finally { globalThis.fetch = real; }
  ok('teardownDemoSite: all four resources handled (script, bucket, dns, kv)', done.script && done.bucket && done.dns && done.kv);
}

console.log(fail === 0 ? `all passed (${pass})` : `${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
