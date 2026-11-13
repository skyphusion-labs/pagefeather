// Tests for the live deploy steps (#419). Offline: a stub Cloudflare API.
//   node deploy/oneclick-live/tests/live-test.mjs
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig, client, prepare, workerId, ensureAccess, policyAllowsOnly, classify, strangerCheck } from '../live.mjs';
import { handle } from '../../oneclick/admin.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
let failed = 0, run = 0;
async function ok(name, fn) { run++; try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); } }
function assert(c, msg) { if (!c) throw new Error(msg); }
const ACCT = 'b'.repeat(32);
const WID = 'c'.repeat(32);
const EMAIL = 'owner@example.com';

function stub(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname.replace(`/client/v4/accounts/${ACCT}`, '');
    const key = `${init.method} ${p}`;
    calls.push({ key, body: init.body ? JSON.parse(init.body) : undefined });
    const r = routes[key] || routes[`${init.method} ${p}${u.search}`];
    if (!r) return new Response(JSON.stringify({ success: false, errors: [{ code: 0, message: `no route ${key}` }] }), { status: 599 });
    const v = typeof r === 'function' ? r(init) : r;
    return new Response(JSON.stringify({ success: (v.status || 200) < 400, errors: v.errors || [], result: v.result ?? null }), { status: v.status || 200 });
  };
  return { c: client({ token: 't', account: ACCT, fetchImpl }), calls };
}

await ok('readConfig reads the site manager config', async () => {
  const cfg = readConfig(await readFile(join(ROOT, 'deploy/oneclick/wrangler.toml'), 'utf8'));
  assert(cfg.name === 'pagefeather' && cfg.namespace === 'pagefeather' && cfg.bucket === 'pagefeather-bundles', JSON.stringify(cfg));
});

await ok('client refuses a missing token or a bad account id', async () => {
  let n = 0;
  try { client({ token: '', account: ACCT }); } catch { n++; }
  try { client({ token: 't', account: 'nope' }); } catch { n++; }
  assert(n === 2, `${n} of 2 refused`);
});

await ok('prepare: both there, nothing made (control)', async () => {
  const { c, calls } = stub({ 'GET /workers/dispatch/namespaces/pagefeather': { result: {} }, 'GET /r2/buckets/pagefeather-bundles': { result: {} } });
  const r = await prepare(c, { namespace: 'pagefeather', bucket: 'pagefeather-bundles' });
  assert(r.namespace === 'there' && r.bucket === 'there' && !calls.some((x) => x.key.startsWith('POST')), JSON.stringify(calls));
});

await ok('prepare: both missing, both made', async () => {
  const { c, calls } = stub({
    'GET /workers/dispatch/namespaces/pagefeather': { status: 404 }, 'POST /workers/dispatch/namespaces': { result: {} },
    'GET /r2/buckets/pagefeather-bundles': { status: 404 }, 'POST /r2/buckets': { result: {} },
  });
  const r = await prepare(c, { namespace: 'pagefeather', bucket: 'pagefeather-bundles' });
  assert(r.namespace === 'made' && r.bucket === 'made', JSON.stringify(r));
  assert(calls.find((x) => x.key === 'POST /workers/dispatch/namespaces').body.name === 'pagefeather', 'namespace body');
});

await ok('prepare: a refused read fails, and makes nothing', async () => {
  const { c, calls } = stub({ 'GET /workers/dispatch/namespaces/pagefeather': { status: 403, errors: [{ code: 10000, message: 'auth' }] } });
  let msg = ''; try { await prepare(c, { namespace: 'pagefeather', bucket: 'b' }); } catch (e) { msg = e.message; }
  assert(/read dispatch namespace/.test(msg) && !calls.some((x) => x.key.startsWith('POST')), msg);
});

await ok('workerId: the Workers API id, else the script tag', async () => {
  let s = stub({ 'GET /workers/workers/pagefeather': { result: { id: WID } } });
  assert((await workerId(s.c, 'pagefeather')).id === WID, 'workers/workers');
  s = stub({ 'GET /workers/workers/pagefeather': { status: 404 }, 'GET /workers/scripts': { result: [{ id: 'other', tag: 'd'.repeat(32) }, { id: 'pagefeather', tag: WID }] } });
  const r = await workerId(s.c, 'pagefeather');
  assert(r.id === WID && r.via === 'workers/scripts tag', JSON.stringify(r));
});

const appsRoute = (apps) => ({ 'GET /workers/workers/pagefeather': { result: { id: WID } }, 'GET /access/apps': { result: apps } });

await ok('ensureAccess: no application, so one is made for this Worker, owner only', async () => {
  const { c, calls } = stub({ ...appsRoute([]), 'POST /access/apps': (init) => ({ result: { id: 'app1', ...JSON.parse(init.body) } }) });
  const r = await ensureAccess(c, { name: 'pagefeather', email: EMAIL });
  assert(r.created === true && r.app === 'app1' && r.workerId === WID, JSON.stringify(r));
  const body = calls.find((x) => x.key === 'POST /access/apps').body;
  assert(body.type === 'self_hosted' && body.destinations.length === 1 && body.destinations[0].type === 'worker' && body.destinations[0].worker_id === WID, JSON.stringify(body.destinations));
  assert(body.policies.length === 1 && body.policies[0].decision === 'allow' && body.policies[0].include[0].email.email === EMAIL, JSON.stringify(body.policies));
});

await ok('ensureAccess: an existing owner-only application is verified, not made again (control)', async () => {
  const app = { id: 'app1', destinations: [{ type: 'worker', worker_id: WID }], policies: [{ decision: 'allow', include: [{ email: { email: 'Owner@Example.com' } }] }] };
  const { c, calls } = stub(appsRoute([{ id: 'x', destinations: [{ type: 'worker', worker_id: 'e'.repeat(32) }] }, app]));
  const r = await ensureAccess(c, { name: 'pagefeather', email: EMAIL });
  assert(r.created === false && r.app === 'app1' && !calls.some((x) => x.key.startsWith('POST')), JSON.stringify(r));
});

await ok('ensureAccess: an existing application that lets in more than the owner fails, and is not overwritten', async () => {
  for (const policies of [
    [{ decision: 'allow', include: [{ everyone: {} }] }],
    [{ decision: 'bypass', include: [{ everyone: {} }] }],
    [{ decision: 'allow', include: [{ email: { email: EMAIL } }, { email_domain: { domain: 'example.com' } }] }],
    [],
  ]) {
    const { c, calls } = stub(appsRoute([{ id: 'app1', destinations: [{ type: 'worker', worker_id: WID }], policies }]));
    let msg = ''; try { await ensureAccess(c, { name: 'pagefeather', email: EMAIL }); } catch (e) { msg = e.message; }
    assert(/does not allow only/.test(msg) && !calls.some((x) => x.key.startsWith('POST') || x.key.startsWith('PUT')), `${JSON.stringify(policies)}: ${msg}`);
  }
});

await ok('ensureAccess: two applications for the Worker, or a bad email, fail', async () => {
  const two = [1, 2].map((i) => ({ id: `a${i}`, destinations: [{ type: 'worker', worker_id: WID }], policies: [{ decision: 'allow', include: [{ email: { email: EMAIL } }] }] }));
  let { c } = stub(appsRoute(two));
  let msg = ''; try { await ensureAccess(c, { name: 'pagefeather', email: EMAIL }); } catch (e) { msg = e.message; }
  assert(/2 Access applications/.test(msg), msg);
  ({ c } = stub(appsRoute([])));
  msg = ''; try { await ensureAccess(c, { name: 'pagefeather', email: '' }); } catch (e) { msg = e.message; }
  assert(/ADMIN_EMAIL/.test(msg), msg);
});

await ok('policyAllowsOnly: exactly the owner email passes', async () => {
  assert(policyAllowsOnly({ policies: [{ decision: 'allow', include: [{ email: { email: EMAIL } }] }] }, EMAIL).ok, 'owner rejected');
  assert(!policyAllowsOnly({ policies: [{ decision: 'allow', include: [{ email: { email: 'x@y.z' } }] }] }, EMAIL).ok, 'other email passed');
});

await ok('classify: only an Access login redirect passes', async () => {
  assert(classify({ status: 302, location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/x' }).pass, 'Access redirect failed');
  assert(!classify({ status: 200, body: 'css' }).pass, '200 passed');
  assert(!classify({ status: 403, body: '<h1>Sign in required</h1>' }).pass, 'the Worker own 403 passed');
  assert(!classify({ status: 302, location: 'https://evil.example/cloudflareaccess.com' }).pass, 'a lookalike redirect passed');
  assert(!classify({ status: 302, location: 'https://cloudflareaccess.com.evil.example/' }).pass, 'a suffix lookalike passed');
  assert(!classify({ status: 401 }).pass, '401 passed');
});

await ok('control: the REAL site manager with no Access in front fails the stranger check', async () => {
  // The site manager's own handler, as a stranger reaches it when Access is missing.
  const env = { ADMIN_EMAIL: EMAIL };
  const fetchImpl = (url) => handle(new Request(url), env, {}, { fetchImpl: () => { throw new Error('no API'); }, dispatcherSource: 'x' });
  const r = await strangerCheck('https://pagefeather.acme.workers.dev', { fetchImpl, tries: 2, sleep: async () => {} });
  assert(!r.pass, 'passed with no Access');
  const css = r.results.find((x) => x.path === '/admin.css');
  assert(css.status === 200 && /Access is not in front/.test(css.why), JSON.stringify(css));
  const root = r.results.find((x) => x.path === '/');
  assert(root.status === 403 && /its own 403/.test(root.why), JSON.stringify(root));
});

await ok('strangerCheck: passes when every probe is redirected to Access, after a propagation delay', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n <= 3) return new Response('css', { status: 200 });
    return new Response(null, { status: 302, headers: { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/pagefeather' } });
  };
  const r = await strangerCheck('https://pagefeather.acme.workers.dev', { fetchImpl, tries: 3, sleep: async () => {} });
  assert(r.pass && r.tries === 2, JSON.stringify(r));
});

console.log(`cases_run=${run} failed=${failed}`);
process.exit(failed ? 1 : 0);
