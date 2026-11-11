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
import { DemoGate } from '../demo-gate.mjs';

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
function kvStub(init = {}, latencyMs = 0) {
  const m = new Map(Object.entries(init));
  const wait = () => (latencyMs ? new Promise((r) => setTimeout(r, 1 + Math.floor(Math.random() * latencyMs))) : Promise.resolve());
  return {
    get: async (k) => { await wait(); return m.has(k) ? m.get(k) : null; },
    put: async (k, v) => { await wait(); m.set(k, v); },
    _m: m,
  };
}
// A DEMO_GATE namespace backed by ONE real DemoGate over a fake storage. With
// latencyMs, every storage get and put waits a random 1..latencyMs ms, so calls
// would interleave if the gate did not run them one after another.
function gateNs(latencyMs = 0) {
  const store = kvStub({}, latencyMs);
  const gate = new DemoGate({ storage: { get: store.get, put: store.put } }, {});
  return {
    idFromName: (n) => n,
    get: () => ({ fetch: (url, init) => gate.fetch(new Request(url, init)) }),
    _gate: gate,
  };
}
function makeEnv(over = {}) {
  return {
    CF_ACCOUNT_ID: 'ACCT', WP_PROVISION_TOKEN: 'wp-tok', WFP_KV_ID: 'SERVERKV', WFP_NAMESPACE: 'wp-wfp',
    WFP_BASES: JSON.stringify({ 'skyphusionwp.dev': { saasZoneId: 'SERVERZONE', workersSubdomain: 'skyphusionwp' } }),
    BUNDLES: bundleStub(), TURNSTILE_SECRET: 'ts-secret', DEMO_KV: kvStub(), DEMO_GATE: gateNs(), DEMO_BASE: 'skyphusionwp.dev',
    DISPATCHER: { get: () => ({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ out: '{"installed":true,"user_id":1}' }) }) }) },
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
    if (init.method === 'POST' && u.endsWith('/_install')) return { ok: true, status: 200, json: async () => ({ out: '{"installed":true,"user_id":1}', ms: 5 }) };
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
    if (init.method === 'POST' && /\/storage\/kv\/namespaces$/.test(u)) return { ok: true, status: 200, text: async () => '{"success":true,"result":{"id":"OCKVID","title":"oc"}}' };
    if (init.method === 'POST' && /\/queues$/.test(u)) return { ok: true, status: 200, text: async () => '{"success":true,"result":{"queue_id":"EMAILQID","queue_name":"q"}}' };
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
  ok('demo install (#215): the response includes the throwaway admin login for the session',
    r.json.installed === true && r.json.admin && r.json.admin.user === 'admin' && typeof r.json.admin.password === 'string');
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

// ---- the gate holds under parallel requests (demo-gate.mjs) ----
// 10 POST /demo at once from ONE IP, with KV and gate storage that both have real
// latency. The fetch stub is swapped once around all 10, so they share it.
async function runDemoMany(env, n) {
  const rec = withFetch();
  const real = globalThis.fetch;
  globalThis.fetch = rec.impl;
  try {
    const mk = () => new Request('https://p/demo', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': IP }, body: JSON.stringify({ turnstileToken: 'x' }) });
    return await Promise.all(Array.from({ length: n }, () => worker.fetch(mk(), env).then((r) => r.status)));
  } finally { globalThis.fetch = real; }
}
{
  const statuses = await runDemoMany(makeEnv({ DEMO_KV: kvStub({}, 20), DEMO_GATE: gateNs(20) }), 10);
  const accepted = statuses.filter((x) => x === 200).length;
  ok(`gate: 10 parallel demos from one IP accept at most ${DEMO_MAX_PER_IP_PER_HOUR} (got ${accepted})`, accepted <= DEMO_MAX_PER_IP_PER_HOUR);
  ok('gate: the rest are 429 (rate limited)', statuses.filter((x) => x === 429).length === 10 - accepted);
  // Control: the same race with a gate that admits everything, so only the KV
  // counters stand. They are read before they are written, so more than the cap
  // get through. This proves the harness can see the race the gate closes.
  const open = { idFromName: (n) => n, get: () => ({ fetch: async () => Response.json({ ok: true, slot: 's' }) }) };
  const ctl = await runDemoMany(makeEnv({ DEMO_KV: kvStub({}, 20), DEMO_GATE: open }), 10);
  const ctlAccepted = ctl.filter((x) => x === 200).length;
  ok(`gate control: with only the KV counters, the race admits more than ${DEMO_MAX_PER_IP_PER_HOUR} (got ${ctlAccepted})`, ctlAccepted > DEMO_MAX_PER_IP_PER_HOUR);
}

// ---- unit: the gate's caps, release and fail-closed ----
{
  const ns = gateNs();
  const g = ns._gate;
  const res = [];
  for (let i = 0; i < DEMO_MAX_PER_IP_PER_HOUR + 1; i++) res.push(await g.reserve({ ip: '198.51.100.1' }));
  ok('gate: per-IP cap refuses the next one with scope ip', res.slice(0, -1).every((r) => r.ok) && res.at(-1).ok === false && res.at(-1).scope === 'ip');
  const cap = gateNs()._gate;
  const slots = [];
  for (let i = 0; i < DEMO_MAX_CONCURRENT; i++) slots.push(await cap.reserve({ ip: `198.51.100.${i + 10}` }));
  const full = await cap.reserve({ ip: '198.51.100.250' });
  ok('gate: every slot taken refuses with scope capacity', slots.every((r) => r.ok) && full.ok === false && full.scope === 'capacity');
  const rel = await cap.release({ slot: slots[0].slot });
  const again = await cap.reserve({ ip: '198.51.100.251' });
  ok('gate: a released slot can be reserved again', rel.released === true && again.ok === true);
  const broken = new DemoGate({ storage: { get: async () => { throw new Error('storage'); }, put: async () => {} } }, {});
  const br = await (await broken.fetch(new Request('https://g/reserve', { method: 'POST', body: '{}' }))).json();
  ok('gate: a storage error fails CLOSED', br.ok === false && br.scope === 'error');
  const noGate = await runDemo(makeEnv({ DEMO_GATE: { idFromName: () => 'x', get: () => ({ fetch: async () => { throw new Error('down'); } }) } }), { turnstileToken: 'x' });
  ok('demo: an unreachable gate is 503 and provisions nothing', noGate.res.status === 503 && !noGate.calls.some((c) => c.url.endsWith('/r2/buckets')));
  const missing = await runDemo(makeEnv({ DEMO_GATE: undefined }), { turnstileToken: 'x' });
  ok('demo: a worker without DEMO_GATE refuses (500, missing binding)', missing.res.status === 500 && /DEMO_GATE/.test(missing.json.error));
}

// A demo site is built locked: no send_email binding without a fixed destination,
// and the DEMO_LOCK runtime var (spikes/b2-wordpress/site-lock.mjs). A site that is
// not a demo is the control: it keeps its EMAIL binding and has no lock var.
{
  const { buildServerCfg } = await import('../server-config.mjs');
  const env = makeEnv();
  const demoCfg = await buildServerCfg(env, { kind: 'wp', name: assignDemoName(), domain: 'skyphusionwp.dev', demo: true, expiresAt: 1 });
  const plainCfg = await buildServerCfg(env, { kind: 'wp', name: 'blog', domain: 'skyphusionwp.dev' });
  const openMail = (cfg) => cfg.resourceBindings.some((b) => b.type === 'send_email' && !b.destination_address);
  const lockVar = (cfg) => cfg.resourceBindings.some((b) => b.type === 'plain_text' && b.name === 'DEMO_LOCK' && b.text === 'on');
  ok('demo lock: a demo site has no send_email binding without a destination', !openMail(demoCfg));
  ok('demo lock: a demo site carries DEMO_LOCK=on in its runtime vars', lockVar(demoCfg));
  ok('demo lock: a site that is not a demo keeps its EMAIL binding (control)', openMail(plainCfg));
  ok('demo lock: a site that is not a demo has no DEMO_LOCK var (control)', !lockVar(plainCfg));
}

// ---- reaper: the per-site KV namespace and both email queues are deleted ----
{
  const rec = withFetch({});
  const calls = [];
  const impl = async (url, init) => {
    const u = String(url);
    if (init.method === 'GET' && /\/storage\/kv\/namespaces\?/.test(u)) { calls.push(`GET kvlist`); return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, result: [{ id: 'OCOLD', title: 'wp-wfp-demo-ddd-oc' }, { id: 'OTHER', title: 'wp-wfp-demo-ddx-oc' }] }) }; }
    if (init.method === 'GET' && /\/queues\?/.test(u)) { calls.push(`GET qlist`); return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, result: [{ queue_id: 'Q1', queue_name: 'wp-wfp-demo-ddd-email' }, { queue_id: 'Q2', queue_name: 'wp-wfp-demo-ddd-email-dlq' }] }) }; }
    if (init.method === 'DELETE') calls.push(`DELETE ${u.split('/client/v4')[1]}`);
    return rec.impl(url, init);
  };
  const real = globalThis.fetch; globalThis.fetch = impl;
  let done;
  try {
    done = await teardownDemoSite({ acct: 'ACCT', token: 'wp-tok' }, makeEnv(), 'demo-ddd.skyphusionwp.dev',
      { name: 'demo-ddd', script: 'site-demo-ddd', mediaBucket: 'wp-wfp-demo-ddd-media', saasZoneId: 'SERVERZONE' });
  } finally { globalThis.fetch = real; }
  ok('teardownDemoSite: DELETEs the site KV namespace by its id', calls.includes('DELETE /accounts/ACCT/storage/kv/namespaces/OCOLD'));
  ok('teardownDemoSite: never touches another site namespace', !calls.some((c) => c.endsWith('/storage/kv/namespaces/OTHER')));
  ok('teardownDemoSite: DELETEs the email queue and its dead-letter queue', calls.includes('DELETE /accounts/ACCT/queues/Q1') && calls.includes('DELETE /accounts/ACCT/queues/Q2'));
  ok('teardownDemoSite: reports the namespace and queues handled', done.kvNamespace && done.queues && done.kv);
  const kvDel = calls.indexOf('DELETE /accounts/ACCT/storage/kv/namespaces/OCOLD');
  const mapDel = calls.findIndex((c) => /\/storage\/kv\/namespaces\/[^/]+\/values\//.test(c));
  ok('teardownDemoSite: the map entry goes LAST, after the namespace', mapDel > kvDel && kvDel >= 0);
}

// ---- reaper: a refused namespace list is NOT read as "already gone" ----
{
  const rec = withFetch({});
  const impl = async (url, init) => {
    if (init.method === 'GET' && /\/storage\/kv\/namespaces\?/.test(String(url))) return { ok: false, status: 403, text: async () => '{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}' };
    return rec.impl(url, init);
  };
  const real = globalThis.fetch; globalThis.fetch = impl;
  let threw = false;
  try {
    await teardownDemoSite({ acct: 'ACCT', token: 'wp-tok' }, makeEnv(), 'demo-eee.skyphusionwp.dev',
      { name: 'demo-eee', script: 'site-demo-eee', mediaBucket: 'wp-wfp-demo-eee-media' });
  } catch { threw = true; } finally { globalThis.fetch = real; }
  ok('teardownDemoSite: a refused list throws, so the map entry stays for the next run', threw &&
    !rec.calls.some((c) => c.method === 'DELETE' && /\/values\/demo-eee/.test(c.url)));
}

console.log(fail === 0 ? `all passed (${pass})` : `${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
