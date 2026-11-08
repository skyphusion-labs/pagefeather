// Offline test of the hardened provisioning Worker (#182). It stubs the GLOBAL
// fetch (the Worker's ops use it) plus the Worker's own bindings (BUNDLES R2,
// RATE_LIMITER) and env, and drives the default fetch handler. The point of the
// change is a security boundary, so these are security assertions: no auth is a
// 401; an injected modules/namespace/kvId/saasZoneId/secrets is IGNORED; a bad
// name or unknown domain is a 400; idempotency returns the existing site; and wp
// vs shop build the correct SERVER-side cfg (never the caller's).
import worker from '../worker.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };

const SECRET = 'super-secret-operator-token';
const IMG = `registry.cloudflare.com/ACCT/wp-woo-c1@sha256:${'a'.repeat(64)}`;

// A trusted bundle in the Worker's own R2 bucket. wp ships a JS module and a
// binary .wasm; c1 ships a JS module. The caller can never name or write this.
function bundleStub() {
  const files = {
    'bundles/b-dosql/current/index.js': { text: 'export default { fetch(){} }' },
    'bundles/b-dosql/current/php.wasm': { bin: new Uint8Array([0, 97, 115, 109]) },
    'bundles/c1/current/worker.js': { text: 'export default { fetch(){} }' },
  };
  return {
    list: async ({ prefix }) => ({ objects: Object.keys(files).filter((k) => k.startsWith(prefix)).map((k) => ({ key: k })) }),
    get: async (key) => {
      const f = files[key];
      if (!f) return null;
      return { text: async () => f.text || '', arrayBuffer: async () => (f.bin ? f.bin.buffer : new ArrayBuffer(0)) };
    },
  };
}

function makeEnv(overrides = {}) {
  return {
    CF_ACCOUNT_ID: 'ACCT', PROVISION_AUTH: SECRET,
    WP_PROVISION_TOKEN: 'wp-tok', SHOP_PROVISION_TOKEN: 'shop-tok',
    WFP_KV_ID: 'SERVERKV', WFP_NAMESPACE: 'wp-wfp',
    WFP_BASES: JSON.stringify({ 'skyphusionwp.dev': { saasZoneId: 'SERVERZONE', workersSubdomain: 'skyphusionwp' } }),
    C1_IMAGE_REF: IMG,
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    BUNDLES: bundleStub(),
    ...overrides,
  };
}

// Install a fresh global-fetch recorder for one call. The idempotency read (GET
// on a KV value) is 404 unless opts.existing is set.
function withFetch(opts = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    if (init.method === 'GET' && /\/storage\/kv\/namespaces\/[^/]+\/values\//.test(url)) {
      if (opts.existing) return { ok: true, status: 200, text: async () => JSON.stringify(opts.existing) };
      return { ok: false, status: 404, text: async () => '{"success":false,"errors":[{"code":10009}]}' };
    }
    if (init.method === 'GET' && /\/scripts\/[^/]+$/.test(url)) {
      if (opts.scriptExists) return { ok: true, status: 200, text: async () => '{"success":true,"result":{"id":"existing"}}' };
      return { ok: false, status: 404, text: async () => '{"success":false,"errors":[{"code":10090}]}' };
    }
    if (init.method === 'GET' && url.endsWith('/tokens')) {
      return { ok: true, status: 200, text: async () => '{"success":true,"result":[]}' };
    }
    let body = '{"success":true,"result":{}}';
    if (init.method === 'POST' && url.endsWith('/tokens')) body = '{"success":true,"result":{"id":"TKID","value":"TKVAL"}}';
    else if (url.endsWith('/settings')) body = '{"success":true,"result":{"bindings":[{"type":"durable_object_namespace","class_name":"Store","name":"STORE","namespace_id":"NSID"}]}}';
    else if (url.endsWith('/containers/applications')) body = '{"success":true,"result":[]}';
    return { ok: true, status: 200, text: async () => body };
  };
  return { impl, calls };
}

function req(bodyObj, { auth = SECRET } = {}) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' };
  if (auth !== null) headers.authorization = `Bearer ${auth}`;
  return new Request('https://p/', { method: 'POST', headers, body: JSON.stringify(bodyObj) });
}

async function run(env, request, opts) {
  const rec = withFetch(opts);
  const real = globalThis.fetch;
  globalThis.fetch = rec.impl;
  try {
    const res = await worker.fetch(request, env);
    const json = await res.clone().json().catch(() => null);
    return { res, json, calls: rec.calls };
  } finally { globalThis.fetch = real; }
}
const metaOf = async (call) => JSON.parse(await call.body.get('metadata').text());

// --- method + auth ---
{
  const g = await run(makeEnv(), new Request('https://p/', { method: 'GET' }));
  ok('GET is 405', g.res.status === 405);

  const noauth = await run(makeEnv(), req({ kind: 'wp', name: 'blog', domain: 'skyphusionwp.dev' }, { auth: null }));
  ok('no Authorization is 401 (and NOTHING was called)', noauth.res.status === 401 && noauth.calls.length === 0);

  const badauth = await run(makeEnv(), req({ kind: 'wp', name: 'blog', domain: 'skyphusionwp.dev' }, { auth: 'wrong' }));
  ok('wrong bearer is 401', badauth.res.status === 401 && badauth.calls.length === 0);
}

// --- missing config is 500, only AFTER auth ---
{
  const r = await run(makeEnv({ WFP_KV_ID: '' }), req({ kind: 'wp', name: 'blog', domain: 'skyphusionwp.dev' }));
  ok('missing required env is 500', r.res.status === 500 && /WFP_KV_ID/.test(r.json.error));
}

// --- rate limit ---
{
  const env = makeEnv({ RATE_LIMITER: { limit: async () => ({ success: false }) } });
  const r = await run(env, req({ kind: 'wp', name: 'blog', domain: 'skyphusionwp.dev' }));
  ok('over the rate limit is 429 (no provisioning calls)', r.res.status === 429 && r.calls.length === 0);
}

// --- name + domain validation ---
{
  const bad = await run(makeEnv(), req({ kind: 'wp', name: 'Bad_Name', domain: 'skyphusionwp.dev' }));
  ok('a bad name is 400 (no calls)', bad.res.status === 400 && bad.calls.length === 0);

  const dom = await run(makeEnv(), req({ kind: 'wp', name: 'blog', domain: 'evil.example.com' }));
  ok('an unowned domain is 400 (no calls)', dom.res.status === 400 && /not an owned base/.test(dom.json.error) && dom.calls.length === 0);

  const kind = await run(makeEnv(), req({ kind: 'db', name: 'blog', domain: 'skyphusionwp.dev' }));
  ok('an unknown kind is 400', kind.res.status === 400);
}

// --- grok residual 2 + 5: reserved names and prototype-key domains are 400 ---
{
  const resv = await run(makeEnv(), req({ kind: 'wp', name: 'www', domain: 'skyphusionwp.dev' }));
  ok('a reserved name (www) is 400 (no calls)', resv.res.status === 400 && /reserved/.test(resv.json.error) && resv.calls.length === 0);

  const demoName = await run(makeEnv(), req({ kind: 'wp', name: 'demo-abc123def45678', domain: 'skyphusionwp.dev' }));
  ok('Path A: a caller-chosen demo-lane name is 400 (keeps the demo lane clean)', demoName.res.status === 400 && /reserved/.test(demoName.json.error) && demoName.calls.length === 0);

  const proto = await run(makeEnv(), req({ kind: 'wp', name: 'blog', domain: '__proto__' }));
  ok('a prototype key as domain is 400, not treated as a base (Object.hasOwn)', proto.res.status === 400 && proto.calls.length === 0);

  const ctor = await run(makeEnv(), req({ kind: 'wp', name: 'blog', domain: 'constructor' }));
  ok('domain=constructor is 400, not a base', ctor.res.status === 400 && ctor.calls.length === 0);
}

// --- the core security property: injection is IGNORED ---
{
  const injected = {
    kind: 'wp', name: 'inject', domain: 'skyphusionwp.dev',
    // All of these MUST be ignored:
    modules: [{ name: 'evil.js', content: 'export default { fetch(){ return new Response("pwned") } }', type: 'application/javascript+module' }],
    resourceBindings: [{ type: 'r2_bucket', name: 'STEAL', bucket_name: 'another-tenant-bucket' }],
    namespace: 'evil-ns', kvId: 'EVILKV', hostname: 'anything.evil', saasZoneId: 'EVILZONE',
    secrets: { EVIL: 'leak' }, sqliteClasses: ['Evil'],
  };
  const r = await run(makeEnv(), req(injected));
  ok('injection: the request still provisions (200)', r.res.status === 200 && r.json.ok === true);
  ok('injection: hostname is server-built name.domain, not the injected one', r.json.hostname === 'inject.skyphusionwp.dev');

  const deploy = r.calls.find((c) => c.method === 'PUT' && /\/dispatch\/namespaces\/[^/]+\/scripts\//.test(c.url));
  ok('injection: the deploy uses the SERVER namespace wp-wfp, not evil-ns',
    /\/dispatch\/namespaces\/wp-wfp\/scripts\/site-inject$/.test(deploy.url) && !/evil-ns/.test(deploy.url));
  ok('injection: the uploaded modules are the vetted BUNDLE, not evil.js',
    deploy.body.get('index.js') !== null && deploy.body.get('php.wasm') !== null && deploy.body.get('evil.js') === null);
  const meta = await metaOf(deploy);
  ok('injection: no injected STEAL binding and no EVIL secret are present',
    !meta.bindings.some((b) => b.name === 'STEAL') && !meta.bindings.some((b) => b.name === 'EVIL'));
  ok('injection: the server generated WP_SALT + SPIKE_TOKEN secrets itself',
    meta.bindings.filter((b) => b.type === 'secret_text').map((b) => b.name).sort().join(',') === 'SPIKE_TOKEN,WP_SALT');
  ok('injection: the KV write is to the SERVER kv id, not EVILKV',
    r.calls.some((c) => c.method === 'PUT' && /\/namespaces\/SERVERKV\/values\//.test(c.url)) &&
    !r.calls.some((c) => /\/namespaces\/EVILKV\//.test(c.url)));
  ok('injection: the routing record is on the SERVER zone, not EVILZONE',
    r.calls.some((c) => /\/zones\/SERVERZONE\/dns_records$/.test(c.url)) &&
    !r.calls.some((c) => /EVILZONE/.test(c.url)));
}

// --- wp builds the correct server cfg end to end ---
{
  const r = await run(makeEnv(), req({ kind: 'wp', name: 'blog', domain: 'skyphusionwp.dev' }));
  ok('wp: 200 with server script name site-blog and hostname blog.skyphusionwp.dev',
    r.res.status === 200 && r.json.script === 'site-blog' && r.json.hostname === 'blog.skyphusionwp.dev');
  ok('wp: it drove the namespace deploy + bucket via the SERVER token path',
    r.calls.some((c) => c.url.endsWith('/r2/buckets')) &&
    r.calls.some((c) => /\/dispatch\/namespaces\/wp-wfp\/scripts\/site-blog$/.test(c.url)));
  ok('wp: NO account-token mint on the wp path (least privilege)',
    !r.calls.some((c) => c.method === 'POST' && c.url.endsWith('/tokens')));
  ok('wp: NO plain /workers/scripts write on the wp path',
    !r.calls.some((c) => /\/workers\/scripts\/site-blog$/.test(c.url)));

  const wpDeploy = r.calls.find((c) => c.method === 'PUT' && /\/dispatch\/namespaces\/wp-wfp\/scripts\/site-blog$/.test(c.url));
  const wpMeta = await metaOf(wpDeploy);
  const names = (t) => wpMeta.bindings.filter((b) => b.type === t).map((b) => b.name);
  ok('wp: the deploy carries IMAGES, MEDIA, PHP_RUNTIME and EMAIL bindings (a WORKING site)',
    names('images').includes('IMAGES') && names('r2_bucket').includes('MEDIA') &&
    names('durable_object_namespace').includes('PHP_RUNTIME') && names('send_email').includes('EMAIL'));
  const v = (n) => (wpMeta.bindings.find((b) => b.type === 'plain_text' && b.name === n) || {}).text;
  ok('wp: the deploy carries the runtime vars (deployNamespaceScript passes vars)',
    v('PHP_IN_DO') === 'on' && v('DB_IN_DO') === 'on' && v('PHP_DO_POOL') === '1' && v('PHP_ENV') === '{"USE_ZEND_ALLOC":"0"}');
  ok('wp: SITE_ORIGIN is the site own origin, issue #33', v('SITE_ORIGIN') === 'https://blog.skyphusionwp.dev');
  ok('wp: the MEDIA bucket binding matches the created bucket wp-wfp-blog-media',
    wpMeta.bindings.find((b) => b.type === 'r2_bucket' && b.name === 'MEDIA').bucket_name === 'wp-wfp-blog-media');
}

// --- shop builds the correct server cfg end to end ---
{
  const r = await run(makeEnv(), req({ kind: 'shop', name: 'store', domain: 'skyphusionwp.dev' }));
  ok('shop: 200 with server script c1-store and a workers.dev hostname',
    r.res.status === 200 && r.json.script === 'c1-store' && r.json.hostname === 'c1-store.skyphusionwp.workers.dev');
  ok('shop: two R2 buckets created', r.calls.filter((c) => c.url.endsWith('/r2/buckets')).length === 2);
  ok('shop: the elevated path DOES mint the Litestream token', r.calls.some((c) => c.method === 'POST' && c.url.endsWith('/tokens')));
  const deploy = r.calls.find((c) => c.method === 'PUT' && /\/workers\/scripts\/c1-store$/.test(c.url));
  const meta = await metaOf(deploy);
  ok('shop: the container image is the SERVER C1_IMAGE_REF digest (no caller image)',
    deploy && meta.containers && meta.containers[0].image === IMG);
}

// --- idempotency ---
{
  const r = await run(makeEnv(), req({ kind: 'wp', name: 'blog', domain: 'skyphusionwp.dev' }),
    { existing: { script: 'site-blog', kind: 'wp', outbound: true } });
  ok('idempotent: an existing site returns 200 existing:true', r.res.status === 200 && r.json.existing === true && r.json.script === 'site-blog');
  const mutating = r.calls.filter((c) => !(c.method === 'GET'));
  ok('idempotent: only the read happened, no create/deploy/overwrite', mutating.length === 0);
}

console.log(fail === 0 ? `all passed (${pass})` : `${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
