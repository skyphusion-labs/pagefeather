// One-click ships the remote packs (#1036). Offline: a stub Cloudflare API and a
// stub dispatch binding. No network.
// A bundle that carries the packs (the release default) makes a site whose Worker
// config has OPCACHE_REMOTE=on, SITE_REMOTE=on and run_worker_first ["/_pf/*"],
// and the packs are uploaded as that Worker's assets. Approach A is the primed
// index (OPCACHE_A's trace). The fixture Worker uses the real pack imports from
// spikes/b2-wordpress/index.js. A bundle that carries the pack index refuses
// OPCACHE_REMOTE=0 and SITE_REMOTE=0: those knobs are the build's, and a
// site-add that turned them off would answer 503 (empty zips, no ASSETS).
// A release with no pack index (a bundle built opted out, or any older release)
// is unchanged, knobs included.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addSite, connectDatabase } from '../sites.mjs';
import { installBundle } from '../bundle.mjs';
import { buildManifest, sha256Hex } from '../vendor/release/bundle-manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DISPATCHER_SRC = await readFile(join(HERE, '../vendor/wfp-dispatcher/worker.js'), 'utf8');
const ACCT = 'a'.repeat(32);
const HD = 'f'.repeat(32);
let failed = 0, run = 0;
async function ok(name, fn) {
  run++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}: ${e.stack || e.message}`); }
}
function assert(c, msg) { if (!c) throw new Error(msg); }

// The asset hash from the direct-upload example (read 2026-11-20): SHA-256 of
// base64(bytes) plus the file extension, first 32 hex characters.
function assetHash(bytes, name) {
  const base = name.split('/').pop();
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
  return createHash('sha256').update(Buffer.from(bytes).toString('base64') + ext).digest('hex').slice(0, 32);
}
function sha256Buf(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function packSet(id) {
  const oc = new TextEncoder().encode('oc-' + id);
  const st = new TextEncoder().encode('st-' + id);
  const files = [
    { asset: 'oc-0.zip', path: `/_pf/${id}/oc-0.zip`, bytes: oc, size: oc.byteLength, sha256: sha256Buf(oc), hash: assetHash(oc, 'oc-0.zip'), kind: 'opcache' },
    { asset: 'st-0.zip', path: `/_pf/${id}/st-0.zip`, bytes: st, size: st.byteLength, sha256: sha256Buf(st), hash: assetHash(st, 'st-0.zip'), kind: 'site' },
  ];
  const index = {
    schema: 1, buildId: id,
    opcache: { id, packs: [{ name: 'oc-0.zip', bytes: oc.byteLength, sha256: files[0].sha256 }], files: { 'a.php': [0, 1] } },
    site: { id, packs: [{ name: 'st-0.zip', bytes: st.byteLength, sha256: files[1].sha256 }], files: { 'b.php': [0, 2] }, hot: null, dirs: [] },
    files: files.map(({ asset, path, size, sha256, hash, kind }) => ({ asset, path, size, sha256, hash, kind })),
  };
  const indexBytes = new TextEncoder().encode(JSON.stringify(index));
  return { id, files, index, indexBytes };
}

function fakeCloudflare({ hyperdrive = {} } = {}) {
  const calls = [];
  const kvNs = new Map();
  const kv = new Map();
  const nsScripts = new Map();
  const plain = new Map();
  let nextId = 1;
  const ok = (result, status = 200) => new Response(JSON.stringify({ success: true, errors: [], result }), { status });
  const err = (status, code, message) => new Response(JSON.stringify({ success: false, errors: [{ code, message }], result: null }), { status });
  async function fetchImpl(url, init = {}) {
    const u = new URL(String(url));
    const method = (init.method || 'GET').toUpperCase();
    const p = u.pathname.replace('/client/v4', '');
    const call = { method, path: p, search: u.search, authorization: (init.headers && init.headers.authorization) || '' };
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
    if ((m = r.match(/^\/storage\/kv\/namespaces\/([^/]+)\/keys$/)) && method === 'GET') {
      const prefix = u.searchParams.get('prefix') || '';
      return ok([...kv.keys()].filter((k) => k.startsWith(m[1] + '/' + prefix)).map((k) => ({ name: k.slice(m[1].length + 1) })));
    }
    if ((m = r.match(/^\/hyperdrive\/configs\/([^/]+)$/)) && method === 'GET') {
      return Object.hasOwn(hyperdrive, m[1]) ? ok(hyperdrive[m[1]]) : err(404, 0, 'not found');
    }
    if (method === 'POST' && r === '/r2/buckets') return ok({ name: JSON.parse(init.body).name });
    if ((m = r.match(/^\/workers\/dispatch\/namespaces\/([^/]+)\/scripts\/([^/]+)\/assets-upload-session$/)) && method === 'POST') {
      call.manifest = JSON.parse(init.body).manifest;
      const hashes = Object.values(call.manifest).map((x) => x.hash);
      return ok({ jwt: 'upload-jwt', buckets: hashes.length ? [hashes] : [] });
    }
    if (r === '/workers/assets/upload' && method === 'POST') {
      call.parts = [];
      if (init.body && typeof init.body.entries === 'function') {
        for (const [k, v] of init.body.entries()) call.parts.push({ name: k, text: typeof v.text === 'function' ? await v.text() : String(v) });
      }
      return ok({ jwt: 'completion-jwt' }, 201);
    }
    if ((m = r.match(/^\/workers\/dispatch\/namespaces\/([^/]+)\/scripts\/([^/]+)$/))) {
      if (method === 'GET') return nsScripts.has(m[2]) ? ok({ script: { id: m[2] } }) : err(404, 10007, 'not found');
      if (method === 'PUT') {
        call.metadata = JSON.parse(await init.body.get('metadata').text());
        call.parts = [...init.body.keys()];
        nsScripts.set(m[2], call.metadata);
        return ok({ id: m[2] });
      }
    }
    if ((m = r.match(/^\/workers\/dispatch\/namespaces\/([^/]+)$/)) && method === 'GET') return ok({ namespace_name: m[1] });
    if ((m = r.match(/^\/workers\/scripts\/([^/]+)$/))) {
      if (method === 'GET') return plain.has(m[1]) ? ok({ id: m[1] }) : err(404, 10007, 'not found');
      if (method === 'PUT') {
        call.metadata = JSON.parse(await init.body.get('metadata').text());
        plain.set(m[1], call.metadata);
        return ok({ id: m[1] });
      }
    }
    if ((m = r.match(/^\/workers\/scripts\/([^/]+)\/subdomain$/)) && method === 'POST') return ok({ enabled: true });
    call.unknown = true;
    return err(599, 0, `stub has no route ${method} ${r}`);
  }
  return { fetchImpl, calls, kv };
}

function bucket(files = {}) {
  const store = new Map(Object.entries(files));
  return {
    store,
    list: async ({ prefix, limit }) => ({ objects: [...store.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit || 1000).map((key) => ({ key })) }),
    get: async (key) => {
      if (!store.has(key)) return null;
      const v = store.get(key);
      const bytes = typeof v === 'string' ? new TextEncoder().encode(v) : v;
      return { text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    },
    put: async (key, v) => { store.set(key, v instanceof Uint8Array ? v : new Uint8Array(v)); },
  };
}
function dispatcherStub() {
  return { get: () => ({ fetch: async (req) => {
    const p = new URL(req.url).pathname;
    if (p === '/_install') return new Response(JSON.stringify({ out: '{"installed":true,"user_id":1}' }));
    if (p === '/_activate') return new Response(JSON.stringify({ out: JSON.stringify({ active: true, error: null, exited: false, installed: true }) }));
    return new Response('no', { status: 404 });
  } }) };
}
function envWith(files, over = {}) {
  return {
    ADMIN_EMAIL: 'owner@example.com', PAGEFEATHER_KEY: 'test-key', CF_ACCOUNT_ID: ACCT,
    WFP_NAMESPACE: 'pagefeather', SITE_MAP_TITLE: 'pagefeather-sites', WFP_COMPAT: '2026-07-01',
    BUNDLE_VERSION: 'v0.1.0',
    BUNDLES: bucket(files), DISPATCHER: dispatcherStub(), ...over,
  };
}

// Seed the R2 layout installBundle writes: the index, and each pack under assets<path>.
function seeded(prefix, mainName, mainBody, set) {
  const files = { [prefix + mainName]: mainBody };
  files[prefix + 'remote-packs-index.json'] = set.indexBytes;
  for (const f of set.files) files[prefix + 'assets' + f.path] = f.bytes;
  return files;
}
const dosql = packSet('bid-dosql-wooprimed');
const approach = packSet('bid-a-wooprimed');
// The lines the built Worker actually ships (index.js). A stub `export default`
// hides the 503: the real module imports the pack indexes, and the zips are empty.
const REAL_IMPORTS = [
  "import OPCACHE_REMOTE from './build/opcache-remote-index.js';",
  "import SITE_REMOTE from './build/site-remote-index.js';",
];
const indexSrc = await readFile(join(HERE, '..', '..', '..', 'spikes', 'b2-wordpress', 'index.js'), 'utf8');
if (!REAL_IMPORTS.every((line) => indexSrc.includes(line))) {
  console.log('FAIL spikes/b2-wordpress/index.js no longer has the pack import shape');
  process.exit(1);
}
const realMain = REAL_IMPORTS.join('\n') + '\nexport default { fetch() {} }\n';
const dosqlFiles = seeded('bundles/b-dosql/v0.1.0/', 'index.js', realMain, dosql);
const aFiles = seeded('bundles/a/v0.1.0/', 'index-a-lean.js', realMain, approach);

function varsOf(meta) {
  return Object.fromEntries((meta.bindings || []).filter((b) => b.type === 'plain_text').map((b) => [b.name, b.text]));
}
function sitePut(cf, script) {
  return cf.calls.find((c) => c.method === 'PUT' && c.path.endsWith(`/scripts/${script}`) && c.metadata);
}

await ok('a b-dosql one-click site renders the packs: OPCACHE_REMOTE, SITE_REMOTE, /_pf/* first, assets uploaded', async () => {
  const cf = fakeCloudflare();
  const r = await addSite(envWith(dosqlFiles), { body: { name: 'blog' }, fetchImpl: cf.fetchImpl, dispatcherSource: DISPATCHER_SRC });
  assert(r.ok, JSON.stringify(r));
  assert(!cf.calls.some((c) => c.unknown), `unknown ${JSON.stringify(cf.calls.filter((c) => c.unknown).map((c) => c.method + ' ' + c.path))}`);
  const site = sitePut(cf, 'site-blog');
  assert(site, 'no script upload');
  const vars = varsOf(site.metadata);
  assert(vars.OPCACHE_REMOTE === 'on', `OPCACHE_REMOTE ${vars.OPCACHE_REMOTE}`);
  assert(vars.SITE_REMOTE === 'on', `SITE_REMOTE ${vars.SITE_REMOTE}`);
  assert(JSON.stringify(site.metadata.assets && site.metadata.assets.config && site.metadata.assets.config.run_worker_first) === JSON.stringify(['/_pf/*']), `run_worker_first ${JSON.stringify(site.metadata.assets)}`);
  assert(site.metadata.assets.jwt === 'completion-jwt', `jwt ${site.metadata.assets && site.metadata.assets.jwt}`);
  assert(site.metadata.assets.config.not_found_handling === 'none', 'a missing asset would be served');
  assert(site.metadata.bindings.some((b) => b.type === 'assets' && b.name === 'ASSETS'), 'no ASSETS binding');
  const session = cf.calls.find((c) => c.path.endsWith('/assets-upload-session'));
  assert(session && session.manifest[dosql.files[0].path].hash === dosql.files[0].hash, 'the opcache pack is not in the asset manifest');
  assert(session.manifest[dosql.files[1].path].hash === dosql.files[1].hash, 'the site pack is not in the asset manifest');
  assert(!site.parts.some((n) => n.includes('_pf') || n.endsWith('oc-0.zip')), `a pack was uploaded as a Worker module: ${site.parts}`);
});

await ok('OPCACHE_REMOTE=0 on a bundle that carries the pack index is refused (real import shape, nothing deployed)', async () => {
  assert(dosqlFiles['bundles/b-dosql/v0.1.0/index.js'].includes(REAL_IMPORTS[0]) && dosqlFiles['bundles/b-dosql/v0.1.0/index.js'].includes(REAL_IMPORTS[1]), 'the fixture Worker is not the real import shape');
  const cf = fakeCloudflare();
  let msg = '';
  try {
    await addSite(envWith(dosqlFiles, { OPCACHE_REMOTE: '0' }), { body: { name: 'blog' }, fetchImpl: cf.fetchImpl, dispatcherSource: DISPATCHER_SRC });
  } catch (e) { msg = e.message; }
  assert(/cannot be turned off/.test(msg), `not refused: ${msg}`);
  assert(!cf.calls.some((c) => c.method === 'PUT' && /\/scripts\/site-blog$/.test(c.path)), 'the site script was uploaded');
  assert(!cf.calls.some((c) => c.path.includes('assets-upload')), 'an asset upload was made');
});

await ok('SITE_REMOTE=0 on a bundle that carries the pack index is refused the same way', async () => {
  const cf = fakeCloudflare();
  let msg = '';
  try {
    await addSite(envWith(dosqlFiles, { SITE_REMOTE: '0' }), { body: { name: 'blog' }, fetchImpl: cf.fetchImpl, dispatcherSource: DISPATCHER_SRC });
  } catch (e) { msg = e.message; }
  assert(/cannot be turned off/.test(msg), `not refused: ${msg}`);
  assert(!cf.calls.some((c) => c.method === 'PUT' && /\/scripts\/site-blog$/.test(c.path)), 'the site script was uploaded');
  assert(!cf.calls.some((c) => c.path.includes('assets-upload')), 'an asset upload was made');
});

await ok('OPCACHE_REMOTE=0 on a bundle with no pack index (the build opt-out) still adds the site', async () => {
  const cf = fakeCloudflare();
  const files = { 'bundles/b-dosql/v0.1.0/index.js': realMain };
  const r = await addSite(envWith(files, { OPCACHE_REMOTE: '0', SITE_REMOTE: '0' }), { body: { name: 'plain' }, fetchImpl: cf.fetchImpl, dispatcherSource: DISPATCHER_SRC });
  assert(r.ok, JSON.stringify(r));
  const site = sitePut(cf, 'site-plain');
  const vars = varsOf(site.metadata);
  assert(!('OPCACHE_REMOTE' in vars) && !('SITE_REMOTE' in vars) && !site.metadata.assets, 'packs were rendered');
});

await ok('manifest.json names assetsIndexSha256 but the pack index is missing: refused, nothing deployed', async () => {
  const cf = fakeCloudflare();
  const files = { ...seeded('bundles/b-dosql/v0.1.0/', 'index.js', realMain, dosql) };
  delete files['bundles/b-dosql/v0.1.0/remote-packs-index.json'];
  files['bundles/b-dosql/v0.1.0/manifest.json'] = new TextEncoder().encode(JSON.stringify({ assetsIndexSha256: 'a'.repeat(64) }));
  let msg = '';
  try {
    await addSite(envWith(files), { body: { name: 'blog' }, fetchImpl: cf.fetchImpl, dispatcherSource: DISPATCHER_SRC });
  } catch (e) { msg = e.message; }
  assert(/remote-packs-index.json is missing/.test(msg), `not refused: ${msg}`);
  assert(!cf.calls.some((c) => c.method === 'PUT' && /\/scripts\/site-blog$/.test(c.path)), 'the site script was uploaded');
});

await ok('a re-add does not read the packs, so a bad index does not fail it', async () => {
  const cf = fakeCloudflare();
  const reads = [];
  const b = bucket(dosqlFiles);
  const orig = b.get;
  b.get = async (key) => { reads.push(key); return orig(key); };
  const env = envWith(dosqlFiles, { BUNDLES: b });
  const first = await addSite(env, { body: { name: 'blog' }, fetchImpl: cf.fetchImpl, dispatcherSource: DISPATCHER_SRC });
  assert(first.ok && !first.existing, JSON.stringify(first));
  b.store.set('bundles/b-dosql/v0.1.0/remote-packs-index.json', new TextEncoder().encode('not-json'));
  reads.length = 0;
  const second = await addSite(env, { body: { name: 'blog' }, fetchImpl: cf.fetchImpl, dispatcherSource: DISPATCHER_SRC });
  assert(second.ok && second.existing === true && !second.password, JSON.stringify(second));
  const packReads = reads.filter((k) => k.endsWith('remote-packs-index.json') || k.includes('/assets/_pf/'));
  assert(packReads.length === 0, `packs were read on re-add: ${packReads.join(', ')}`);
});

await ok('a bundle with no pack index (the opt-out build, and every older release) renders no packs', async () => {
  const cf = fakeCloudflare();
  const files = { 'bundles/b-dosql/v0.1.0/index.js': 'export default { fetch(){} }' };
  const r = await addSite(envWith(files), { body: { name: 'plain' }, fetchImpl: cf.fetchImpl, dispatcherSource: DISPATCHER_SRC });
  assert(r.ok, JSON.stringify(r));
  const site = sitePut(cf, 'site-plain');
  const vars = varsOf(site.metadata);
  assert(!('OPCACHE_REMOTE' in vars) && !site.metadata.assets, 'packs were rendered for a bundle that has none');
});

const hdConfig = { id: HD, name: 'shopdb', origin: { scheme: 'mysql', host: 'db.example', port: 3306, database: 'wp', user: 'wp' }, caching: { disabled: true } };

await ok('an approach A one-click store renders the primed packs (OPCACHE_A index) the same way', async () => {
  const cf = fakeCloudflare({ hyperdrive: { [HD]: hdConfig } });
  const env = envWith({ ...dosqlFiles, ...aFiles });
  const c = await connectDatabase(env, { body: { hyperdriveId: HD, provider: 'azure' }, fetchImpl: cf.fetchImpl });
  assert(c.ok, JSON.stringify(c));
  const r = await addSite(env, { body: { name: 'bigshop', tier: 'a', database: HD }, fetchImpl: cf.fetchImpl, dispatcherSource: DISPATCHER_SRC });
  assert(r.ok && r.tier === 'a', JSON.stringify(r));
  assert(!cf.calls.some((c) => c.unknown), `unknown ${JSON.stringify(cf.calls.filter((c) => c.unknown).map((c) => c.method + ' ' + c.path))}`);
  const site = sitePut(cf, 'site-bigshop');
  assert(site && site.metadata.main_module === 'index-a-lean.js', 'not the approach A module');
  const vars = varsOf(site.metadata);
  assert(vars.OPCACHE_REMOTE === 'on' && vars.SITE_REMOTE === 'on', JSON.stringify(vars));
  assert(JSON.stringify(site.metadata.assets.config.run_worker_first) === JSON.stringify(['/_pf/*']), 'no /_pf/*');
  const session = cf.calls.find((c) => c.path.includes('/site-bigshop/assets-upload-session'));
  assert(session && session.manifest[approach.files[0].path] && session.manifest[approach.files[0].path].hash === approach.files[0].hash, 'the primed opcache pack was not uploaded');
  assert(approach.index.opcache && approach.index.opcache.id === 'bid-a-wooprimed', 'the approach A index is not the primed build');
});

await ok('Get WordPress files stores the pack index and the packs next to the modules', async () => {
  const modules = [{ name: 'index.js', bytes: new TextEncoder().encode('export default {};') }];
  const meta = { version: '0.1.0', gitSha: 'f'.repeat(40), buildId: dosql.id, wrangler: '4.107.0', wordpress: '7.1.4', woocommerce: '11.2.1', compatibilityDate: '2026-07-01', mainModule: 'index.js' };
  const manifest = await buildManifest(modules, meta);
  manifest.assetsIndexSha256 = await sha256Hex(dosql.indexBytes);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const pin = await sha256Hex(manifestBytes);
  const assets = new Map([
    ['manifest.json', manifestBytes],
    ['index.js', modules[0].bytes],
    ['remote-packs-index.json', dosql.indexBytes],
    ...dosql.files.map((f) => [f.asset, f.bytes]),
  ]);
  const fetchImpl = async (url) => {
    const m = String(url).match(/\/releases\/download\/v0\.1\.0\/(.+)$/);
    if (!m || !assets.has(m[1])) return new Response('nf', { status: 404 });
    return new Response(assets.get(m[1]));
  };
  const b = bucket();
  const r = await installBundle({ BUNDLE_VERSION: 'v0.1.0', BUNDLE_MANIFEST_SHA256: pin, BUNDLES: b }, { fetchImpl });
  assert(r.ok, JSON.stringify(r));
  const prefix = 'bundles/b-dosql/v0.1.0/';
  assert(b.store.has(prefix + 'index.js'), 'module not stored');
  assert(b.store.has(prefix + 'remote-packs-index.json'), 'pack index not stored');
  for (const f of dosql.files) assert(b.store.has(prefix + 'assets' + f.path), `pack ${f.path} not stored`);
});

console.log(failed === 0 ? `all passed (${run})` : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
