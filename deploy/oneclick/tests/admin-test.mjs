// Tests for the one-click site manager (#414). Offline: a stub Cloudflare API, a
// stub dispatch binding and a stub R2 bucket. No network, no account.
//   node deploy/oneclick/tests/admin-test.mjs
// Every refusal has a passing control next to it, so a guard that never fires
// cannot hide behind a green run.
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { handle } from '../admin.mjs';
import { reservedRule, JS, sitesScreen } from '../ui.mjs';
import { RESERVED_NAMES } from '../vendor/provision/shared.mjs';
import { deriveTarget } from '../vendor/provision/server-config.mjs';
import { buildManifest, sha256Hex } from '../vendor/release/bundle-manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
let failed = 0, run = 0;
async function ok(name, fn) {
  run++;
  try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}: ${e.stack || e.message}`); }
}
function assert(c, msg) { if (!c) throw new Error(msg); }

const ACCT = 'a'.repeat(32);
const OWNER = 'owner@example.com';
const DISPATCHER_SRC = await readFile(join(HERE, '..', 'vendor/wfp-dispatcher/worker.js'), 'utf8');

// ---- a small in-memory Cloudflare API -----------------------------------------
function fakeCloudflare({ foreignScripts = [], hyperdrive = {}, hyperdriveStatus = 0, failDispatchPut = false } = {}) {
  const calls = [];
  const kvNs = new Map();            // title -> id
  const kv = new Map();              // `${id}/${key}` -> string
  const plain = new Map(foreignScripts.map((n) => [n, { foreign: true }]));
  const nsScripts = new Map();
  const buckets = new Set();
  let nextId = 1;
  const ok = (result, status = 200) => new Response(JSON.stringify({ success: true, errors: [], result }), { status });
  const err = (status, code, message) => new Response(JSON.stringify({ success: false, errors: [{ code, message }], result: null }), { status });
  async function fetchImpl(url, init = {}) {
    const u = new URL(String(url));
    const method = (init.method || 'GET').toUpperCase();
    const p = u.pathname.replace('/client/v4', '');
    const call = { method, path: p, search: u.search };
    calls.push(call);
    if (method === 'GET' && p === '/accounts') return ok([{ id: ACCT, name: 'Owner' }]);
    const base = `/accounts/${ACCT}`;
    if (!p.startsWith(base)) return err(403, 9109, 'wrong account');
    const r = p.slice(base.length);
    if (method === 'GET' && r === '/workers/subdomain') return ok({ subdomain: 'acme' });
    if (method === 'POST' && r === '/storage/kv/namespaces') {
      const { title } = JSON.parse(init.body);
      if (kvNs.has(title)) return err(409, 10014, 'exists');
      const id = `kv${nextId++}`; kvNs.set(title, id); return ok({ id, title });
    }
    if (method === 'GET' && r === '/storage/kv/namespaces') return ok([...kvNs].map(([title, id]) => ({ id, title })));
    let m;
    if ((m = r.match(/^\/storage\/kv\/namespaces\/([^/]+)\/values\/(.+)$/))) {
      const k = `${m[1]}/${decodeURIComponent(m[2])}`;
      if (method === 'PUT') { kv.set(k, init.body); return ok(null); }
      if (method === 'GET') return kv.has(k) ? new Response(kv.get(k), { status: 200 }) : err(404, 10009, 'key not found');
    }
    if ((m = r.match(/^\/storage\/kv\/namespaces\/([^/]+)\/values\/(.+)$/)) && method === 'DELETE') {
      kv.delete(`${m[1]}/${decodeURIComponent(m[2])}`); return ok(null);
    }
    if ((m = r.match(/^\/storage\/kv\/namespaces\/([^/]+)\/keys$/)) && method === 'GET') {
      const prefix = m[1] + '/' + (u.searchParams.get('prefix') || '');
      return ok([...kv.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ name: k.slice(m[1].length + 1) })));
    }
    if ((m = r.match(/^\/storage\/kv\/namespaces\/([^/]+)$/)) && method === 'DELETE') {
      for (const [t, id] of kvNs) if (id === m[1]) kvNs.delete(t);
      return ok(null);
    }
    if ((m = r.match(/^\/hyperdrive\/configs\/([^/]+)$/)) && method === 'GET') {
      if (hyperdriveStatus) return err(hyperdriveStatus, 0, `refused ${SECRET_HD}`);
      return Object.hasOwn(hyperdrive, m[1]) ? ok(hyperdrive[m[1]]) : err(404, 0, 'not found');
    }
    if (r === '/hyperdrive/configs' && method === 'GET') return hyperdriveStatus ? err(hyperdriveStatus, 0, 'refused') : ok(Object.values(hyperdrive).slice(0, 1));
    if (method === 'POST' && r === '/r2/buckets') { buckets.add(JSON.parse(init.body).name); return ok({ name: JSON.parse(init.body).name }); }
    if ((m = r.match(/^\/r2\/buckets\/([^/]+)\/objects$/)) && method === 'GET') return buckets.has(m[1]) ? ok([]) : err(404, 10006, 'no bucket');
    if ((m = r.match(/^\/r2\/buckets\/([^/]+)$/)) && method === 'DELETE') { buckets.delete(m[1]); return ok(null); }
    if ((m = r.match(/^\/workers\/dispatch\/namespaces\/([^/]+)\/scripts\/([^/]+)$/))) {
      if (method === 'GET') return nsScripts.has(m[2]) ? ok({ script: { id: m[2] } }) : err(404, 10007, 'not found');
      if (method === 'PUT') {
        call.metadata = JSON.parse(await init.body.get('metadata').text());
        if (failDispatchPut) return err(500, 10000, `upload refused ${SECRET_HD}`);
        nsScripts.set(m[2], call.metadata); return ok({ id: m[2] });
      }
      if (method === 'DELETE') { nsScripts.delete(m[2]); return ok(null); }
    }
    if ((m = r.match(/^\/workers\/dispatch\/namespaces\/([^/]+)$/)) && method === 'GET') return ok({ namespace_name: m[1] });
    if ((m = r.match(/^\/workers\/scripts\/([^/]+)$/))) {
      if (method === 'GET') return plain.has(m[1]) ? ok({ id: m[1] }) : err(404, 10007, 'not found');
      if (method === 'DELETE') { plain.delete(m[1]); return ok(null); }
      if (method === 'PUT') {
        call.metadata = JSON.parse(await init.body.get('metadata').text());
        call.source = await init.body.get('worker.js').text();
        plain.set(m[1], call.metadata); return ok({ id: m[1] });
      }
    }
    if ((m = r.match(/^\/workers\/scripts\/([^/]+)\/subdomain$/)) && method === 'POST') return ok({ enabled: true });
    call.unknown = true;
    return err(599, 0, `stub has no route ${method} ${r}`);
  }
  return { fetchImpl, calls, kv, plain, nsScripts, kvNs, buckets };
}
const SECRET_HD = 'hd-upstream-' + 'Xy7'.repeat(8);

function bucket(files = {}) {
  const store = new Map(Object.entries(files));
  return {
    store,
    list: async ({ prefix, limit }) => ({ objects: [...store.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit || 1000).map((key) => ({ key })) }),
    get: async (key) => {
      if (!store.has(key)) return null;
      const v = store.get(key);
      const bytes = typeof v === 'string' ? new TextEncoder().encode(v) : v;
      return { text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.slice().buffer };
    },
    put: async (key, v) => { store.set(key, v); },
  };
}

function dispatcherStub() {
  const seen = [];
  return {
    seen,
    get: (script) => ({
      fetch: async (req) => {
        const u = new URL(req.url);
        seen.push({ script, path: u.pathname, search: u.search, token: req.headers.get('x-spike-token') });
        if (u.pathname === '/_install') return new Response(JSON.stringify({ out: '{"installed":true,"user_id":1}' }));
        if (u.pathname === '/_activate') return new Response(JSON.stringify({ out: JSON.stringify({ active: true, error: null, exited: false }) }));
        return new Response('no', { status: 404 });
      },
    }),
  };
}

function makeEnv(over = {}) {
  return {
    ADMIN_EMAIL: OWNER, PAGEFEATHER_KEY: 'test-key', CF_ACCOUNT_ID: ACCT,
    WFP_NAMESPACE: 'pagefeather', SITE_MAP_TITLE: 'pagefeather-sites', WFP_COMPAT: '2026-07-01',
    BUNDLE_VERSION: 'v0.1.0', BUNDLE_MANIFEST_SHA256: '',
    BUNDLES: bucket({ 'bundles/b-dosql/v0.1.0/index.js': 'export default { fetch(){} }', 'bundles/b-dosql/v0.1.0/php.wasm': new Uint8Array([0, 97, 115, 109]) }),
    DISPATCHER: dispatcherStub(),
    ...over,
  };
}
const access = (email = OWNER, aud = 'aud-1') => ({ access: { aud, getIdentity: async () => (email === null ? {} : { email }) } });
const get = (path, headers = {}) => new Request(`https://pagefeather.acme.workers.dev${path}`, { headers });
const post = (path, body, headers = { 'content-type': 'application/json', 'x-pagefeather': '1', origin: 'https://pagefeather.acme.workers.dev' }) =>
  new Request(`https://pagefeather.acme.workers.dev${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
const call = (req, env, ctx, cf) => handle(req, env, ctx, { fetchImpl: cf.fetchImpl, dispatcherSource: DISPATCHER_SRC });

// ---- fail closed ---------------------------------------------------------------
await ok('no Access identity: every screen and API is refused, and the account is never touched', async () => {
  const cf = fakeCloudflare();
  for (const req of [get('/'), get('/add'), get('/health'), get('/import'), post('/api/sites', { name: 'blog' }), post('/api/bundle', {})]) {
    const res = await call(req, makeEnv(), {}, cf);
    assert(res.status === 403, `${req.method} ${new URL(req.url).pathname} answered ${res.status}`);
  }
  assert(cf.calls.length === 0, `the API was called ${cf.calls.length} times`);
});

await ok('a forged Access header, with no Access identity, is refused', async () => {
  const cf = fakeCloudflare();
  const forged = { 'cf-access-jwt-assertion': 'forged-header.not-signed-by-access.x', 'cf-access-authenticated-user-email': OWNER };
  const res = await call(get('/', forged), makeEnv(), {}, cf);
  assert(res.status === 403, `GET / answered ${res.status}`);
  const res2 = await call(post('/api/sites', { name: 'blog' }, { 'content-type': 'application/json', 'x-pagefeather': '1', ...forged }), makeEnv(), { access: undefined }, cf);
  assert(res2.status === 403, `POST answered ${res2.status}`);
  assert(cf.calls.length === 0, 'the API was called');
});

await ok('no ADMIN_EMAIL: refused (503) even with a valid Access identity', async () => {
  const cf = fakeCloudflare();
  const res = await call(get('/'), makeEnv({ ADMIN_EMAIL: '' }), access(), cf);
  assert(res.status === 503, `answered ${res.status}`);
  assert(cf.calls.length === 0, 'the API was called');
});

await ok('a signed-in person who is not the owner, a wrong audience, no email, a failing identity: all refused', async () => {
  const cf = fakeCloudflare();
  assert((await call(get('/'), makeEnv(), access('someone@else.com'), cf)).status === 403, 'not owner passed');
  assert((await call(get('/'), makeEnv({ ACCESS_AUD: 'aud-1' }), access(OWNER, 'aud-2'), cf)).status === 403, 'wrong aud passed');
  assert((await call(get('/'), makeEnv(), access(null), cf)).status === 403, 'no email passed');
  const throwing = { access: { aud: 'x', getIdentity: async () => { throw new Error('boom'); } } };
  assert((await call(get('/'), makeEnv(), throwing, cf)).status === 403, 'throwing identity passed');
  assert(cf.calls.length === 0, 'the API was called');
});

await ok('control: the owner (any letter case, right audience) opens Sites, and the page carries the security headers', async () => {
  const cf = fakeCloudflare();
  const res = await call(get('/'), makeEnv({ ACCESS_AUD: 'aud-1' }), access('Owner@Example.com', 'aud-1'), cf);
  assert(res.status === 200, `answered ${res.status}`);
  const body = await res.text();
  assert(body.includes('<h1>Sites') && body.includes('No sites yet'), 'not the Sites screen');
  assert((res.headers.get('content-security-policy') || '').includes("script-src 'self'"), 'no CSP');
  assert(res.headers.get('cache-control') === 'no-store', 'cacheable');
});

await ok('the CSS and the script are served without sign-in, and they hold no account data', async () => {
  const cf = fakeCloudflare();
  const css = await call(get('/admin.css'), makeEnv(), {}, cf);
  const js = await call(get('/admin.js'), makeEnv(), {}, cf);
  assert(css.status === 200 && js.status === 200, 'not served');
  assert(cf.calls.length === 0, 'the API was called');
});

// ---- writes come only from this page ------------------------------------------
await ok('a write without the page header, from another origin, or not JSON is refused before any change', async () => {
  const cf = fakeCloudflare();
  const env = makeEnv();
  const bad = [
    { 'content-type': 'application/json', origin: 'https://pagefeather.acme.workers.dev' },
    { 'content-type': 'application/json', 'x-pagefeather': '1', origin: 'https://evil.example' },
    { 'content-type': 'text/plain', 'x-pagefeather': '1' },
  ];
  for (const h of bad) assert((await call(post('/api/sites', { name: 'blog' }, h), env, access(), cf)).status === 403, `allowed ${JSON.stringify(h)}`);
  assert(!cf.calls.some((c) => c.method !== 'GET'), 'something was written');
});

// ---- the reserved names --------------------------------------------------------
await ok('the page gets the same reserved names as the server, "shop" among them', async () => {
  const rule = reservedRule();
  assert(JSON.stringify(rule.names) === JSON.stringify([...RESERVED_NAMES].sort()), 'names differ from shared.mjs');
  assert(rule.names.includes('shop') && rule.prefixes.includes('demo-') && rule.prefixes.includes('site-'), 'missing entries');
  const cf = fakeCloudflare();
  const body = await (await call(get('/add'), makeEnv(), access(), cf)).text();
  assert(body.includes('data-rule="') && body.includes('&quot;shop&quot;'), 'the add form has no reserved rule');
  assert(body.includes('data-subdomain="acme"'), 'no subdomain on the form');
});

await ok('the page script warns before submit: reserved, reserved prefix, bad format; a good name passes', async () => {
  const sandbox = { window: {}, document: { getElementById: () => null } };
  vm.runInNewContext(JS, sandbox);
  const problem = sandbox.window.pagefeatherNameProblem;
  const rule = reservedRule();
  assert(/reserved/.test(problem('shop', rule)), 'shop not warned');
  assert(/reserved/.test(problem('admin', rule)), 'admin not warned');
  assert(/cannot start with "site-"/.test(problem('site-x', rule)), 'site- not warned');
  assert(/cannot start with "demo-"/.test(problem('demo-1', rule)), 'demo- not warned');
  assert(/lower case/.test(problem('-bad', rule)), 'leading hyphen not warned');
  assert(problem('my-shop', rule) === '' && problem('blog2', rule) === '', 'a good name was warned');
});

await ok('the server refuses a reserved name (400) and makes nothing', async () => {
  for (const name of ['shop', 'demo-abc', 'site-x', 'Blog', '']) {
    const cf = fakeCloudflare();
    const res = await call(post('/api/sites', { name }), makeEnv(), access(), cf);
    assert(res.status === 400, `${JSON.stringify(name)} answered ${res.status}`);
    assert(!cf.calls.some((c) => c.method !== 'GET'), `${name}: something was written`);
  }
});

// ---- add a site ----------------------------------------------------------------
await ok('add a site: deploy/provision makes it locked, on workers.dev, with its own front door', async () => {
  const cf = fakeCloudflare();
  const env = makeEnv();
  const res = await call(post('/api/sites', { name: 'blog' }), env, access(), cf);
  const r = await res.json();
  assert(res.status === 200 && r.ok, `answered ${res.status} ${JSON.stringify(r)}`);
  assert(r.url === 'https://wp-blog.acme.workers.dev/' && r.loginUrl === 'https://wp-blog.acme.workers.dev/wp-login.php', `url ${r.url}`);
  assert(r.user === 'admin' && typeof r.password === 'string' && r.password.length >= 12, 'no admin credential');
  assert(!cf.calls.some((c) => c.unknown), `unknown API call: ${JSON.stringify(cf.calls.filter((c) => c.unknown))}`);
  const site = cf.calls.find((c) => c.method === 'PUT' && c.path.endsWith('/workers/dispatch/namespaces/pagefeather/scripts/site-blog'));
  assert(site, 'no namespace script upload');
  const vars = Object.fromEntries(site.metadata.bindings.filter((b) => b.type === 'plain_text').map((b) => [b.name, b.text]));
  assert(vars.CODE_LOCK === 'on', 'the site is not code-locked');
  assert(!('DEMO_LOCK' in vars), 'a one-click site is not a demo');
  assert(vars.SITE_ORIGIN === 'https://wp-blog.acme.workers.dev', `SITE_ORIGIN ${vars.SITE_ORIGIN}`);
  assert(!('MAIL_FROM' in vars), 'MAIL_FROM set on a workers.dev site');
  assert(!cf.calls.some((c) => c.path.includes('/zones/')), 'a DNS call was made');
  const door = cf.calls.find((c) => c.method === 'PUT' && c.path.endsWith('/workers/scripts/wp-blog'));
  assert(door, 'no front door');
  assert(door.source === DISPATCHER_SRC, 'the front door is not deploy/wfp/dispatcher/worker.js');
  const names = door.metadata.bindings.map((b) => `${b.type}:${b.name}`).sort().join(',');
  assert(names === 'dispatch_namespace:DISPATCHER,kv_namespace:SITES', `front door bindings ${names}`);
  assert(cf.calls.some((c) => c.method === 'POST' && c.path.endsWith('/workers/scripts/wp-blog/subdomain')), 'workers.dev route not turned on');
  const entry = JSON.parse([...cf.kv].find(([k]) => k.endsWith('/wp-blog.acme.workers.dev'))[1]);
  assert(entry.script === 'site-blog' && entry.outbound === false && entry.installed === true, `entry ${JSON.stringify(entry)}`);
  assert(env.DISPATCHER.seen.some((s) => s.path === '/_install'), 'install not run');
  assert(!env.DISPATCHER.seen.some((s) => s.path === '/_activate'), 'WooCommerce turned on for a non-store');
  assert(!JSON.stringify(r).includes('test-key'), 'the key is in the response');
});

await ok('a store: WooCommerce is turned on through the site itself', async () => {
  const cf = fakeCloudflare();
  const env = makeEnv();
  const r = await (await call(post('/api/sites', { name: 'myshop', store: true }), env, access(), cf)).json();
  assert(r.ok && r.store === true && r.woo && r.woo.activated === true, JSON.stringify(r));
  const act = env.DISPATCHER.seen.find((s) => s.path === '/_activate');
  assert(act && act.script === 'site-myshop' && act.search.includes('woocommerce%2Fwoocommerce.php') && act.token, 'no activation');
});

await ok('a store whose activation does not report active: the result says so (control for the line above)', async () => {
  const cf = fakeCloudflare();
  const d = dispatcherStub();
  const inner = d.get;
  d.get = (script) => ({ fetch: async (req) => (new URL(req.url).pathname === '/_activate'
    ? new Response(JSON.stringify({ out: JSON.stringify({ active: false, error: 'x' }) }))
    : inner(script).fetch(req)) });
  const r = await (await call(post('/api/sites', { name: 'myshop', store: true }), makeEnv({ DISPATCHER: d }), access(), cf)).json();
  assert(r.ok && r.woo && r.woo.activated === false, JSON.stringify(r.woo));
});

await ok('a Worker named wp-<name> that is not ours: refused before anything is made', async () => {
  const cf = fakeCloudflare({ foreignScripts: ['wp-blog'] });
  const res = await call(post('/api/sites', { name: 'blog' }), makeEnv(), access(), cf);
  const r = await res.json();
  assert(res.status === 400 && /already exists/.test(r.error), `answered ${res.status} ${r.error}`);
  assert(!cf.calls.some((c) => c.method === 'PUT' || (c.method === 'POST' && c.path.endsWith('/r2/buckets'))), 'something was made');
});

await ok('adding the same site again returns it, with no second upload and no new password', async () => {
  const cf = fakeCloudflare();
  const env = makeEnv();
  await call(post('/api/sites', { name: 'blog' }), env, access(), cf);
  const before = cf.calls.filter((c) => c.method === 'PUT' && c.path.includes('/dispatch/')).length;
  const r = await (await call(post('/api/sites', { name: 'blog' }), env, access(), cf)).json();
  const after = cf.calls.filter((c) => c.method === 'PUT' && c.path.includes('/dispatch/')).length;
  assert(r.ok && r.existing === true && !r.password, JSON.stringify(r));
  assert(before === after, 'the site was uploaded again');
});

await ok('the Sites screen lists a made site, escaped', async () => {
  const cf = fakeCloudflare();
  const env = makeEnv();
  await call(post('/api/sites', { name: 'blog' }), env, access(), cf);
  const body = await (await call(get('/'), env, access(), cf)).text();
  assert(body.includes('wp-blog.acme.workers.dev') && body.includes('<b>blog</b>'), 'site not listed');
  const html = sitesScreen([{ name: '<x>', hostname: 'h"', installed: true, adminUrl: 'javascript:"' }]);
  assert(!html.includes('<x>') && html.includes('&lt;x&gt;') && !html.includes('h"'), 'not escaped');
});

await ok('Site Health checks the key, the plan, the address name and the files live', async () => {
  const cf = fakeCloudflare();
  const body = await (await call(get('/health'), makeEnv(), access(), cf)).text();
  assert((body.match(/badge ok/g) || []).length >= 4 && !body.includes('badge todo'), 'not all four checks are done');
  const empty = await (await call(get('/health'), makeEnv({ BUNDLES: bucket() }), access(), cf)).text();
  assert(empty.includes('Get WordPress files') && (empty.match(/badge todo/g) || []).length === 1, 'missing files not shown as to do');
  const noKey = await (await call(get('/health'), makeEnv({ PAGEFEATHER_KEY: '' }), access(), cf)).text();
  assert((noKey.match(/badge todo/g) || []).length >= 3, 'a missing key did not fail its checks');
});

// ---- the WordPress files -------------------------------------------------------
async function release() {
  const files = [
    { name: 'index.js', bytes: new TextEncoder().encode('export default {};') },
    { name: 'ab-php.wasm', bytes: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]) },
  ];
  const meta = { version: '0.1.0', gitSha: 'f'.repeat(40), buildId: 'x-wooprimed', wrangler: '4.107.0', wordpress: '7.1.4', woocommerce: '11.2.1', compatibilityDate: '2026-07-01', mainModule: 'index.js' };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(await buildManifest(files, meta)));
  const assets = new Map([['manifest.json', manifestBytes], ...files.map((f) => [f.name, f.bytes])]);
  return { assets, pin: await sha256Hex(manifestBytes) };
}
function releaseFetch(assets, cf) {
  return async (url, init) => {
    const s = String(url);
    const m = s.match(/\/releases\/download\/v0\.1\.0\/(.+)$/);
    if (m) return assets.has(m[1]) ? new Response(assets.get(m[1])) : new Response('nf', { status: 404 });
    return cf.fetchImpl(url, init);
  };
}

await ok('Get WordPress files: with no pin, nothing is downloaded', async () => {
  const cf = fakeCloudflare();
  const r = await (await handle(post('/api/bundle', {}), makeEnv({ BUNDLES: bucket() }), access(), { fetchImpl: cf.fetchImpl, dispatcherSource: DISPATCHER_SRC })).json();
  assert(!r.ok && /not available yet/.test(r.error), JSON.stringify(r));
});

await ok('Get WordPress files: a pinned, matching release is written to the bucket', async () => {
  const { assets, pin } = await release();
  const cf = fakeCloudflare();
  const b = bucket();
  const r = await (await handle(post('/api/bundle', {}), makeEnv({ BUNDLES: b, BUNDLE_MANIFEST_SHA256: pin }), access(), { fetchImpl: releaseFetch(assets, cf), dispatcherSource: DISPATCHER_SRC })).json();
  assert(r.ok && r.modules === 2, JSON.stringify(r));
  assert(b.store.has('bundles/b-dosql/v0.1.0/index.js') && b.store.has('bundles/b-dosql/v0.1.0/ab-php.wasm'), 'not written');
});

await ok('Get WordPress files: a changed module or a manifest that is not the pinned one writes nothing', async () => {
  const { assets, pin } = await release();
  const cf = fakeCloudflare();
  const tampered = new Map(assets); tampered.set('index.js', new TextEncoder().encode('export default {x:1};'));
  let b = bucket();
  let r = await (await handle(post('/api/bundle', {}), makeEnv({ BUNDLES: b, BUNDLE_MANIFEST_SHA256: pin }), access(), { fetchImpl: releaseFetch(tampered, cf), dispatcherSource: DISPATCHER_SRC })).json();
  assert(!r.ok && /does not match its manifest/.test(r.error) && b.store.size === 0, `tampered: ${JSON.stringify(r)}`);
  b = bucket();
  r = await (await handle(post('/api/bundle', {}), makeEnv({ BUNDLES: b, BUNDLE_MANIFEST_SHA256: '0'.repeat(64) }), access(), { fetchImpl: releaseFetch(assets, cf), dispatcherSource: DISPATCHER_SRC })).json();
  assert(!r.ok && /not the pinned/.test(r.error) && b.store.size === 0, `wrong pin: ${JSON.stringify(r)}`);
});

// ---- what an error may show (CodeQL js/stack-trace-exposure) -------------------
const SECRET = 'cfat_' + 'Zq9'.repeat(12);
async function capture(fn) {
  const orig = console.error; const lines = [];
  console.error = (...a) => lines.push(a.map((x) => String(x && x.stack ? x.stack : x)).join(' '));
  try { return { value: await fn(), lines }; } finally { console.error = orig; }
}
const leakyFetch = async () => { throw new Error(`upstream said Authorization: Bearer ${SECRET}`); };

await ok('an unexpected error with a secret-looking string never reaches the response; it is logged with a reference', async () => {
  for (const req of [post('/api/sites', { name: 'blog' }), get('/'), get('/health'), post('/api/bundle', {})]) {
    const env = makeEnv({ BUNDLE_MANIFEST_SHA256: 'a'.repeat(64) });
    const { value: res, lines } = await capture(() => handle(req, env, access(), { fetchImpl: leakyFetch, dispatcherSource: DISPATCHER_SRC }));
    const body = await res.text();
    const where = `${req.method} ${new URL(req.url).pathname}`;
    assert(!body.includes(SECRET) && !body.includes('upstream said'), `${where}: the error text is in the body`);
    const ref = (body.match(/reference ([0-9a-f]{12})/) || [])[1];
    assert(ref, `${where}: no reference in the body: ${body.slice(0, 200)}`);
    assert(lines.some((l) => l.includes(ref) && l.includes(SECRET)), `${where}: the log does not carry the reference and the real error`);
  }
});

await ok('control: a BadRequest message is shown as it is', async () => {
  const cf = fakeCloudflare();
  const r = await (await call(post('/api/sites', { name: 'shop' }), makeEnv(), access(), cf)).json();
  assert(!r.ok && /name is reserved/.test(r.error), JSON.stringify(r));
  const b = await (await call(post('/api/bundle', {}), makeEnv({ BUNDLES: bucket() }), access(), cf)).json();
  assert(/not available yet/.test(b.error), JSON.stringify(b));
});

await ok('a failed WooCommerce activation and a failed install show a reference, never the upstream text', async () => {
  const cf = fakeCloudflare();
  const d = dispatcherStub();
  d.get = (script) => ({ fetch: async (req) => {
    const p = new URL(req.url).pathname;
    if (p === '/_install') return new Response(JSON.stringify({ out: JSON.stringify({ error: `db said ${SECRET}` }) }));
    throw new Error(`activate blew up ${SECRET}`);
  } });
  const { value: res } = await capture(() => call(post('/api/sites', { name: 'myshop', store: true }), makeEnv({ DISPATCHER: d }), access(), cf));
  const body = await res.text();
  assert(!body.includes(SECRET), 'the upstream text is in the body');
  const r = JSON.parse(body);
  assert(r.ok && /reference [0-9a-f]{12}/.test(r.note || '') && r.woo && r.woo.activated === false && /^[0-9a-f]{12}$/.test(r.woo.ref), JSON.stringify(r));
});

// ---- the Hyperdrive store (#431) -----------------------------------------------
const HD = 'f'.repeat(31) + '1';
const HD2 = 'e'.repeat(31) + '2';
// What the Cloudflare API returns for a config: never a password (write-only).
// A planted field stands in for any extra the API might add: it must not be stored.
const hdConfig = (over = {}) => ({ id: HD, name: 'shopdb', origin: { scheme: 'mysql', host: 'db.example.mysql.database.azure.com', port: 3306, database: 'wp', user: 'wpuser', planted: SECRET_HD }, caching: { disabled: true }, ...over });
const aBundle = () => ({
  'bundles/b-dosql/v0.1.0/index.js': 'export default { fetch(){} }',
  'bundles/a/v0.1.0/index-a-lean.js': 'export default { fetch(){} }',
  'bundles/a/v0.1.0/php.wasm': new Uint8Array([0, 97, 115, 109]),
});
const connect = (env, cf, body) => call(post('/api/databases', body), env, access(), cf);

await ok('connect a database: refused for a bad ID, an unknown ID, a key that cannot read, a non-MySQL origin, caching on, no provider; nothing is stored', async () => {
  const cases = [
    [{ hyperdriveId: 'not-an-id', provider: 'azure' }, {}, 0, /not a Hyperdrive configuration ID/],
    [{ hyperdriveId: HD2, provider: 'azure' }, { [HD]: hdConfig() }, 0, /No Hyperdrive configuration has that ID/],
    [{ hyperdriveId: HD, provider: 'azure' }, { [HD]: hdConfig() }, 403, /cannot read Hyperdrive/],
    [{ hyperdriveId: HD, provider: 'azure' }, { [HD]: hdConfig({ origin: { scheme: 'postgres', host: 'h', database: 'd' } }) }, 0, /postgres, not MySQL/],
    [{ hyperdriveId: HD, provider: 'azure' }, { [HD]: hdConfig({ caching: { disabled: false } }) }, 0, /Caching is on/],
    [{ hyperdriveId: HD, provider: 'azure' }, { [HD]: hdConfig({ caching: undefined }) }, 0, /Caching is on/],
    [{ hyperdriveId: HD, provider: 'planetscale' }, { [HD]: hdConfig() }, 0, /Choose where the database runs/],
  ];
  for (const [body, hyperdrive, hyperdriveStatus, re] of cases) {
    const cf = fakeCloudflare({ hyperdrive, hyperdriveStatus });
    const res = await connect(makeEnv(), cf, body);
    const t = await res.text();
    assert(res.status === 400 && re.test(t), `${JSON.stringify(body)} answered ${res.status} ${t}`);
    assert(!t.includes(SECRET_HD), 'upstream text shown');
    assert(![...cf.kv.keys()].some((k) => k.includes('/_db/')), `${JSON.stringify(body)}: a database was stored`);
  }
});

await ok('control: a MySQL config with caching off connects; only id, name, host, database, provider are stored; it lists on Databases', async () => {
  const cf = fakeCloudflare({ hyperdrive: { [HD]: hdConfig() } });
  const env = makeEnv();
  const r = await (await connect(env, cf, { hyperdriveId: HD.toUpperCase(), provider: 'azure' })).json();
  assert(r.ok && r.database.id === HD, JSON.stringify(r));
  const stored = [...cf.kv].find(([k]) => k.endsWith(`/_db/${HD}`));
  assert(stored, 'not stored under _db/');
  const e = JSON.parse(stored[1]);
  assert(JSON.stringify(Object.keys(e).sort()) === JSON.stringify(['connectedAt', 'database', 'host', 'id', 'name', 'provider']), `stored keys ${Object.keys(e)}`);
  assert(!stored[1].includes(SECRET_HD) && !stored[1].includes('wpuser'), 'a field beyond the allowed ones was stored');
  const page = await (await call(get('/databases'), env, access(), cf)).text();
  assert(page.includes('shopdb') && page.includes('db.example.mysql.database.azure.com') && page.includes('Azure Database for MySQL'), 'not listed');
  assert(!/type="password"/.test(page), 'the Databases page has a password field');
  // A database entry is not a site.
  const sites = await (await call(get('/'), env, access(), cf)).text();
  assert(sites.includes('No sites yet'), 'the database shows as a site');
});

async function connectedEnv(over = {}) {
  const cf = fakeCloudflare({ hyperdrive: { [HD]: hdConfig() }, ...over });
  const env = makeEnv({ BUNDLES: bucket(aBundle()) });
  const c = await (await connect(env, cf, { hyperdriveId: HD, provider: 'azure' })).json();
  assert(c.ok, `connect: ${JSON.stringify(c)}`);
  return { cf, env };
}

await ok('add a Hyperdrive store: approach-A code, the connected Hyperdrive ID, a table prefix from the name, no SQLite class, its own cache, WooCommerce on', async () => {
  const { cf, env } = await connectedEnv();
  const res = await call(post('/api/sites', { name: 'big-shop', tier: 'a', database: HD, hyperdriveId: HD2 }), env, access(), cf);
  const r = await res.json();
  assert(res.status === 200 && r.ok && r.tier === 'a' && r.store === true && r.tablePrefix === 'wp_big_shop_', JSON.stringify(r));
  assert(r.woo && r.woo.activated === true, 'WooCommerce not turned on');
  assert(!cf.calls.some((c) => c.unknown), `unknown API call: ${JSON.stringify(cf.calls.filter((c) => c.unknown))}`);
  const site = cf.calls.find((c) => c.method === 'PUT' && c.path.endsWith('/workers/dispatch/namespaces/pagefeather/scripts/site-big-shop'));
  assert(site, 'no namespace script upload');
  assert(site.metadata.main_module === 'index-a-lean.js', `main ${site.metadata.main_module}`);
  const hd = site.metadata.bindings.filter((b) => b.type === 'hyperdrive');
  assert(hd.length === 1 && hd[0].id === HD, `hyperdrive binding ${JSON.stringify(hd)} (the body's hyperdriveId must be ignored)`);
  const vars = Object.fromEntries(site.metadata.bindings.filter((b) => b.type === 'plain_text').map((b) => [b.name, b.text]));
  assert(JSON.parse(vars.PHP_ENV).WP_TABLE_PREFIX === 'wp_big_shop_', `vars ${JSON.stringify(vars)}`);
  // The code lock (#461): on for every site by default; the render carries NO
  // CODE_LOCK, and the runtime's own rule gives this env the full lock defines.
  assert(!site.metadata.bindings.some((b) => b.name === 'CODE_LOCK'), 'the a-store render carries CODE_LOCK');
  const { lockDefines } = await import(join(ROOT, 'spikes/b2-wordpress/site-lock.mjs'));
  const defs = lockDefines(vars);
  for (const d of ["define('DISALLOW_FILE_MODS', true);", "define('DISALLOW_FILE_EDIT', true);", "define('SKYPHUSION_CODE_LOCK', true);"]) assert(defs.includes(d), `the a-store env does not lock: ${JSON.stringify(defs)}`);
  assert(!(site.metadata.migrations && site.metadata.migrations.new_sqlite_classes || []).length, 'a SQLite class was declared');
  const oc = site.metadata.bindings.find((b) => b.type === 'kv_namespace' && b.name === 'OC_KV');
  assert(oc && oc.namespace_id && cf.kvNs.get('wp-wfp-big-shop-oc') === oc.namespace_id, 'no own object cache');
  const entry = JSON.parse([...cf.kv].find(([k]) => k.endsWith('/wp-big-shop.acme.workers.dev'))[1]);
  assert(entry.kind === 'a' && entry.database === HD && entry.tablePrefix === 'wp_big_shop_', `entry ${JSON.stringify(entry)}`);
  const list = await (await call(get('/'), env, access(), cf)).text();
  assert(list.includes('Hyperdrive store'), 'the site list does not show the store type');
});

await ok('a Hyperdrive store is refused (400, nothing made) for no database, an unconnected database, and a config that changed since connect', async () => {
  for (const [label, body, mutate] of [
    ['no database', { name: 'bigshop', tier: 'a' }, null],
    ['not connected', { name: 'bigshop', tier: 'a', database: HD2 }, null],
    ['caching turned on since', { name: 'bigshop', tier: 'a', database: HD }, (cfg) => { cfg.caching.disabled = false; }],
  ]) {
    const hyperdrive = { [HD]: hdConfig() };
    const { cf, env } = await connectedEnv({ hyperdrive });
    if (mutate) mutate(hyperdrive[HD]);
    const before = cf.calls.length;
    const res = await call(post('/api/sites', body), env, access(), cf);
    assert(res.status === 400, `${label} answered ${res.status}`);
    // The site-map ensure POSTs and gets 409 (it exists); that makes nothing.
    const writes = cf.calls.slice(before).filter((c) => c.method !== 'GET' && !(c.method === 'POST' && c.path.endsWith('/storage/kv/namespaces')));
    assert(!writes.length, `${label}: something was made ${JSON.stringify(writes.map((c) => c.method + c.path))}`);
  }
});

await ok('a Hyperdrive store that fails part way is undone: front door, entry, code, cache, bucket gone; the database record stays', async () => {
  const { cf, env } = await connectedEnv({ failDispatchPut: true });
  const { value: res } = await capture(() => call(post('/api/sites', { name: 'bigshop', tier: 'a', database: HD }), env, access(), cf));
  const r = await res.json();
  assert(res.status === 400 && /was not made \(reference [0-9a-f]{12}\)/.test(r.error) && /Everything it had made in Cloudflare was removed/.test(r.error) && r.error.includes('wp_bigshop_'), r.error);
  assert(!JSON.stringify(r).includes(SECRET_HD), 'upstream text shown');
  assert(!cf.buckets.size, `buckets left: ${[...cf.buckets]}`);
  assert(!cf.kvNs.has('wp-wfp-bigshop-oc'), 'the object cache namespace is left');
  assert(![...cf.kv.keys()].some((k) => k.endsWith('/wp-bigshop.acme.workers.dev')), 'the site entry is left');
  assert(!cf.plain.has('wp-bigshop') && !cf.nsScripts.has('site-bigshop'), 'code is left');
  assert([...cf.kv.keys()].some((k) => k.endsWith(`/_db/${HD}`)), 'the database record was removed');
  assert(!cf.calls.some((c) => c.path.includes('/hyperdrive/') && c.method !== 'GET'), 'the Hyperdrive config was changed');
});

await ok('control for the undo: a failed install is undone too; a STANDARD store with a failed install is kept (unchanged behaviour)', async () => {
  const d = dispatcherStub();
  d.get = () => ({ fetch: async () => new Response(JSON.stringify({ out: JSON.stringify({ error: 'cannot reach the database' }) })) });
  const { cf, env } = await connectedEnv();
  env.DISPATCHER = d;
  const { value: res } = await capture(() => call(post('/api/sites', { name: 'bigshop', tier: 'a', database: HD }), env, access(), cf));
  assert(res.status === 400, `answered ${res.status}`);
  assert(!cf.nsScripts.has('site-bigshop') && !cf.buckets.size, 'not undone');
  const cf2 = fakeCloudflare();
  const { value: res2 } = await capture(() => call(post('/api/sites', { name: 'myshop', store: true }), makeEnv({ DISPATCHER: d }), access(), cf2));
  const r2 = await res2.json();
  assert(res2.status === 200 && r2.ok && cf2.nsScripts.has('site-myshop'), `standard store ${res2.status} ${JSON.stringify(r2)}`);
});

await ok('disconnect: refused while a site uses the database; allowed when none does', async () => {
  const { cf, env } = await connectedEnv();
  const r = await (await call(post('/api/sites', { name: 'bigshop', tier: 'a', database: HD }), env, access(), cf)).json();
  assert(r.ok, JSON.stringify(r));
  const res = await call(post('/api/databases/remove', { id: HD }), env, access(), cf);
  const t = await res.json();
  assert(res.status === 400 && /used by a site \(wp-bigshop\.acme\.workers\.dev\)/.test(t.error), `${res.status} ${t.error}`);
  assert([...cf.kv.keys()].some((k) => k.endsWith(`/_db/${HD}`)), 'removed while in use');
  const cf2 = fakeCloudflare({ hyperdrive: { [HD]: hdConfig() } });
  const env2 = makeEnv();
  await connect(env2, cf2, { hyperdriveId: HD, provider: 'mysql' });
  const ok2 = await (await call(post('/api/databases/remove', { id: HD }), env2, access(), cf2)).json();
  assert(ok2.ok && ![...cf2.kv.keys()].some((k) => k.includes('/_db/')), JSON.stringify(ok2));
});

await ok('the add form: store questions, the recommendation, and the database select; no password field', async () => {
  const { cf, env } = await connectedEnv();
  const body = await (await call(get('/add'), env, access(), cf)).text();
  for (const s of ['name="busy" value="more"', 'name="tier" value="a"', `<option value="${HD}">shopdb`, 'how many people check out at the same moment']) assert(body.includes(s), `missing ${s}`);
  assert(!/type="password"/.test(body), 'a password field');
  const cf2 = fakeCloudflare();
  const empty = await (await call(get('/add'), makeEnv(), access(), cf2)).text();
  assert(empty.includes('No database is connected yet') && !empty.includes('<select id="database"'), 'no-database text missing');
});

await ok('Site Health: the Hyperdrive rows are optional, so a blog-only owner still reads Everything is ready', async () => {
  const cf = fakeCloudflare({ hyperdriveStatus: 403 });
  const body = await (await call(get('/health'), makeEnv(), access(), cf)).text();
  assert(body.includes('Optional') && body.includes('Everything is ready'), 'optional rows block ready');
  const cf2 = fakeCloudflare({ hyperdrive: { [HD]: hdConfig() } });
  const body2 = await (await call(get('/health'), makeEnv({ BUNDLES: bucket(aBundle()) }), access(), cf2)).text();
  assert(!body2.includes('Optional</span>'), 'rows not done when they should be');
});

await ok('the bundle download: the a. bundle is fetched only with its pin, checked, and written under bundles/a/<version>/', async () => {
  const mk = async (prefix) => {
    const mods = [{ name: 'index-a-lean.js', bytes: new TextEncoder().encode('export default {}') }];
    const manifest = await buildManifest(mods.map((m) => ({ name: m.name, bytes: m.bytes })), { version: '0.1.0', gitSha: 'c'.repeat(40), buildId: 'x-a-wooprimed', wrangler: '4', wordpress: '6', woocommerce: '9', compatibilityDate: '2026-07-01', mainModule: 'index-a-lean.js' });
    return { mods, bytes: new TextEncoder().encode(JSON.stringify(manifest)) };
  };
  const b = await mk(''); const a = await mk('a.');
  const files = new Map([['manifest.json', b.bytes], ['index-a-lean.js', b.mods[0].bytes], ['a.manifest.json', a.bytes], ['a.index-a-lean.js', a.mods[0].bytes]]);
  const fetchImpl = async (url) => { const n = String(url).split('/').pop(); return files.has(n) ? new Response(files.get(n)) : new Response('no', { status: 404 }); };
  const { installBundle } = await import('../bundle.mjs');
  const env = makeEnv({ BUNDLES: bucket(), BUNDLE_MANIFEST_SHA256: await sha256Hex(b.bytes) });
  const r1 = await installBundle(env, { fetchImpl });
  assert(r1.ok && !r1.storeModules && ![...env.BUNDLES.store.keys()].some((k) => k.startsWith('bundles/a/')), 'a bundle fetched with no pin');
  const env2 = makeEnv({ BUNDLES: bucket(), BUNDLE_MANIFEST_SHA256: await sha256Hex(b.bytes), A_BUNDLE_MANIFEST_SHA256: await sha256Hex(a.bytes) });
  const r2 = await installBundle(env2, { fetchImpl });
  assert(r2.storeModules === 1 && env2.BUNDLES.store.has('bundles/a/v0.1.0/index-a-lean.js') && env2.BUNDLES.store.has('bundles/a/v0.1.0/manifest.json'), JSON.stringify(r2));
  const env3 = makeEnv({ BUNDLES: bucket(), BUNDLE_MANIFEST_SHA256: await sha256Hex(b.bytes), A_BUNDLE_MANIFEST_SHA256: 'b'.repeat(64) });
  let msg = '';
  try { await installBundle(env3, { fetchImpl }); } catch (e) { msg = e.message; }
  assert(/a\.manifest\.json sha256 .* not the pinned/.test(msg) && !env3.BUNDLES.store.size, `wrong pin: ${msg} ${env3.BUNDLES.store.size}`);
});

await ok('the recommendation: more than 5 recommends the Hyperdrive store; 1 to 5 and I do not know do not', async () => {
  const { recommendTier, CONCURRENT_CHECKOUT_CUT } = await import('../sites.mjs');
  assert(recommendTier('more') === 'a' && recommendTier('few') === 'wp' && recommendTier('unknown') === 'wp' && CONCURRENT_CHECKOUT_CUT === 5, 'wrong');
});

// ---- the core change: a workers.dev base ---------------------------------------
await ok('deriveTarget: a workers.dev base gives wp-<name>.<sub>.workers.dev and no zone; a bad subdomain throws', async () => {
  const env = { WFP_KV_ID: 'kv', WFP_BASES: JSON.stringify({ 'workers.dev': { workersDev: true, subdomain: 'acme' } }) };
  const t = deriveTarget(env, { kind: 'wp', name: 'blog', domain: 'workers.dev' });
  assert(t.hostname === 'wp-blog.acme.workers.dev' && t.workersDev === true && !t.saasZoneId && t.script === 'site-blog', JSON.stringify(t));
  let threw = false;
  try { deriveTarget({ ...env, WFP_BASES: JSON.stringify({ 'workers.dev': { workersDev: true, subdomain: 'a.b' } }) }, { kind: 'wp', name: 'blog', domain: 'workers.dev' }); } catch { threw = true; }
  assert(threw, 'a dotted subdomain was accepted');
});

console.log(`cases_run=${run} failed=${failed}`);
process.exit(failed ? 1 : 0);
