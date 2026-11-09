// Offline test of the provisioning core (#154). No network: fetchImpl is a stub
// that records each call and returns a canned response. Proves the ops build the
// right Cloudflare API calls, that the R2 secret is SHA-256(value) with NO
// trailing newline (the fresh-store finding), and that the shop deploy
// references a pushed image DIGEST (no build, the hinge).
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { sha256Hex, r2BucketResource } from '../cf.mjs';
import {
  createR2Bucket, mintScopedR2Token, putSecret, writeKVMapEntry,
  deployNamespaceScript, deployContainerWorkerFromDigest, scriptExists, installWordPress, ensureKVNamespace,
  createKvNamespace, createQueue, createVectorizeIndex,
} from '../ops.mjs';
import { upsertSite, readSite, listSites, removeSite } from '../registry.mjs';

const ACCT = 'fabcb25d9c7eb087110ec474a03e50d2';
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };

// A stub fetch: records calls, returns the next canned response (or a default 200).
function stub(responses = []) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const res = responses[i++] || { status: 200, body: '{"success":true,"result":{}}' };
    return { ok: res.status < 400, status: res.status, text: async () => res.body ?? '' };
  };
  return { fetchImpl, calls };
}
const ctxOf = (s) => ({ acct: ACCT, token: 'T', fetchImpl: s.fetchImpl });

// 1. sha256Hex: no trailing newline, and 'x' vs 'x\n' differ (the #154 guard).
{
  const want = createHash('sha256').update('abc').digest('hex');
  assert.equal(await sha256Hex('abc'), want);
  ok('sha256Hex matches a known hash (no newline added)', (await sha256Hex('abc')) === want);
  ok('sha256Hex("abc") != sha256Hex("abc\\n") (the newline trap)', (await sha256Hex('abc')) !== (await sha256Hex('abc\n')));
}

// 2. createR2Bucket: POST, and an existing bucket is idempotent success.
{
  const s = stub([{ status: 200, body: '{"success":true,"result":{}}' }]);
  const r = await createR2Bucket(ctxOf(s), 'wp-woo-c1b-db');
  ok('createR2Bucket POSTs the buckets endpoint', s.calls[0].method === 'POST' && s.calls[0].url.endsWith(`/accounts/${ACCT}/r2/buckets`));
  ok('createR2Bucket sends {name}', JSON.parse(s.calls[0].body).name === 'wp-woo-c1b-db' && r.created === true);
  const s2 = stub([{ status: 409, body: '{"success":false,"errors":[{"code":10004,"message":"exists"}]}' }]);
  const r2 = await createR2Bucket(ctxOf(s2), 'dup');
  ok('createR2Bucket treats an existing bucket as success', r2.existed === true);
}

// 3. mintScopedR2Token: idempotent by name. With no existing token it LISTS
// (empty) then CREATES, with the two groups + bucket resource; secret =
// SHA-256(value), no newline.
{
  const s = stub([
    { status: 200, body: '{"success":true,"result":[]}' }, // GET /tokens list: none
    { status: 200, body: '{"success":true,"result":{"id":"KID","value":"TOKVAL"}}' }, // POST create
  ]);
  const r = await mintScopedR2Token(ctxOf(s), { name: 'wp-woo-c1b-litestream', bucket: 'wp-woo-c1b-db' });
  ok('mint LISTS tokens first (idempotency by name)', s.calls[0].method === 'GET' && s.calls[0].url.endsWith(`/accounts/${ACCT}/tokens`));
  const create = s.calls[1];
  const body = JSON.parse(create.body);
  const groups = body.policies[0].permission_groups.map((g) => g.id).sort();
  ok('mintScopedR2Token POSTs /tokens to create when none exists', create.method === 'POST' && create.url.endsWith(`/accounts/${ACCT}/tokens`));
  ok('mint uses R2 item read+write groups', groups[0] === '2efd5506f9c8494dacb1fa10a3e7d5b6' && groups[1] === '6a018a9f2fc74eb6b293b0c548f38b39');
  ok('mint scopes to exactly the one bucket', Object.keys(body.policies[0].resources)[0] === r2BucketResource(ACCT, 'wp-woo-c1b-db'));
  ok('secret = SHA-256(value) with NO newline', r.secretAccessKey === createHash('sha256').update('TOKVAL').digest('hex'));
  ok('secret is NOT SHA-256(value + newline)', r.secretAccessKey !== createHash('sha256').update('TOKVAL\n').digest('hex'));
  ok('accessKeyId = token id', r.accessKeyId === 'KID');
}

// 3b. mint reuse-or-roll (#182 grok residual 4): an existing token with the name
// is ROLLED (same id) and reused, never a second create (no zombie).
{
  const s = stub([
    { status: 200, body: '{"success":true,"result":[{"id":"OLDID","name":"wp-woo-c1b-litestream"}]}' }, // GET list: exists
    { status: 200, body: '{"success":true,"result":{"value":"ROLLEDVAL"}}' }, // PUT roll value
  ]);
  const r = await mintScopedR2Token(ctxOf(s), { name: 'wp-woo-c1b-litestream', bucket: 'wp-woo-c1b-db' });
  ok('mint reuse: NO create POST when a token with the name exists', !s.calls.some((c) => c.method === 'POST'));
  ok('mint reuse: rolls PUT .../OLDID/value and reuses the id',
    s.calls.some((c) => c.method === 'PUT' && c.url.endsWith('/tokens/OLDID/value')) && r.tokenId === 'OLDID');
  ok('mint reuse: secret = SHA-256(rolled value)', r.secretAccessKey === createHash('sha256').update('ROLLEDVAL').digest('hex'));
}

// 3c. scriptExists (#182 grok residual 2): 404 is absent, 200 is present.
{
  const s404 = stub([{ status: 404, body: '{"success":false,"errors":[{"code":10090}]}' }]);
  ok('scriptExists is false on 404 (standalone path)', (await scriptExists(ctxOf(s404), { name: 'c1-none' })) === false && s404.calls[0].url.endsWith('/workers/scripts/c1-none'));
  const s200 = stub([{ status: 200, body: '{"success":true,"result":{"id":"x"}}' }]);
  ok('scriptExists is true on 200 (namespace path)',
    (await scriptExists(ctxOf(s200), { name: 'site-x', ns: 'wp-wfp' })) === true && s200.calls[0].url.includes('/dispatch/namespaces/wp-wfp/scripts/site-x'));
}

// 4. putSecret: namespace vs standalone path, type secret_text.
{
  const s = stub();
  await putSecret(ctxOf(s), { ns: 'wp-wfp', script: 'site-blog', name: 'WP_SALT', text: 'x' });
  ok('putSecret (namespace) targets the dispatch script secrets', s.calls[0].url.endsWith(`/workers/dispatch/namespaces/wp-wfp/scripts/site-blog/secrets`) && JSON.parse(s.calls[0].body).type === 'secret_text');
  const s2 = stub();
  await putSecret(ctxOf(s2), { script: 'c1-shop', name: 'WP_SALT', text: 'x' });
  ok('putSecret (standalone) targets the worker secrets', s2.calls[0].url.endsWith(`/workers/scripts/c1-shop/secrets`));
}

// 5. writeKVMapEntry: raw JSON string value (not double-encoded).
{
  const s = stub();
  await writeKVMapEntry(ctxOf(s), { kvId: 'KV', key: 'blog.example.com', value: { script: 'site-blog', kind: 'wp' } });
  ok('writeKVMapEntry PUTs the value endpoint', s.calls[0].method === 'PUT' && s.calls[0].url.endsWith('/storage/kv/namespaces/KV/values/blog.example.com'));
  ok('KV value is the verbatim JSON string', s.calls[0].body === JSON.stringify({ script: 'site-blog', kind: 'wp' }));
}

// 6. deployContainerWorkerFromDigest: PUTs the script with the migration, then
// CREATES the container application against the class's DO namespace with the
// digest image. The app-create is the step a raw PUT omits (the #158 500).
{
  const NSID = 'ns0123456789abcdef0123456789abcd';
  const s = stub([
    { status: 200, body: '{"success":true,"result":{}}' }, // PUT script
    { status: 200, body: JSON.stringify({ success: true, result: { bindings: [{ type: 'durable_object_namespace', class_name: 'Store', name: 'STORE', namespace_id: NSID }] } }) }, // GET settings
    { status: 200, body: '{"success":true,"result":[]}' }, // GET apps (none -> create)
    { status: 200, body: '{"success":true,"result":{"id":"app-123"}}' }, // POST app
  ]);
  const ref = `registry.cloudflare.com/${ACCT}/wp-woo-c1@sha256:${'8'.repeat(64)}`;
  const r = await deployContainerWorkerFromDigest(ctxOf(s), {
    name: 'c1-shop', mainModule: 'worker.js', modules: [{ name: 'worker.js', content: 'export default {}' }],
    bindings: [], compatibilityDate: '2026-07-01', containerClass: 'Store', imageRef: ref, instanceType: 'basic',
  });
  const meta = JSON.parse(await s.calls[0].body.get('metadata').text());
  ok('shop deploy PUTs a standalone worker', s.calls[0].method === 'PUT' && s.calls[0].url.endsWith(`/accounts/${ACCT}/workers/scripts/c1-shop`));
  ok('migration declares the SQLite DO class', meta.migrations.new_sqlite_classes[0] === 'Store');
  ok('script metadata CONTAINER-ENABLES the DO class (avoids 1607)', meta.containers && meta.containers[0].class_name === 'Store' && meta.containers[0].image === ref);
  ok('reads the script settings to resolve the DO namespace', s.calls[1].method === 'GET' && s.calls[1].url.endsWith('/workers/scripts/c1-shop/settings'));
  const appCall = s.calls.find((c) => c.method === 'POST' && c.url.endsWith('/containers/applications'));
  ok('CREATES the container application (the step a raw PUT omits, #158)', !!appCall);
  const appBody = JSON.parse(appCall.body);
  ok('app binds the class DO namespace + the pushed DIGEST image', appBody.durable_objects.namespace_id === NSID && appBody.configuration.image === ref);
  ok('app sets instance_type + tier constraints + instances 0 (wrangler shape)', appBody.configuration.instance_type === 'basic' && appBody.constraints.tiers.join(',') === '1,2' && appBody.instances === 0);
  ok('deploy returns the application name + namespace', r.application === 'c1-shop-store' && r.namespaceId === NSID);
  let threw = false;
  try { await deployContainerWorkerFromDigest(ctxOf(stub()), { name: 'x', mainModule: 'w.js', modules: [], containerClass: 'Store', imageRef: './container/Dockerfile' }); } catch { threw = true; }
  ok('shop deploy REJECTS a Dockerfile image (must be a pushed digest)', threw);
}
// 6b. an EXISTING application is updated (PATCH), not recreated (idempotent).
{
  const NSID = 'ns0123456789abcdef0123456789abcd';
  const s = stub([
    { status: 200, body: '{"success":true,"result":{}}' },
    { status: 200, body: JSON.stringify({ success: true, result: { bindings: [{ type: 'durable_object_namespace', class_name: 'Store', namespace_id: NSID }] } }) },
    { status: 200, body: '{"success":true,"result":[{"id":"app-existing","name":"c1-shop-store"}]}' }, // app exists
    { status: 200, body: '{"success":true,"result":{"id":"app-existing"}}' }, // PATCH
  ]);
  const ref = `registry.cloudflare.com/${ACCT}/wp-woo-c1@sha256:${'7'.repeat(64)}`;
  await deployContainerWorkerFromDigest(ctxOf(s), {
    name: 'c1-shop', mainModule: 'worker.js', modules: [{ name: 'worker.js', content: 'export default {}' }],
    compatibilityDate: '2026-07-01', containerClass: 'Store', imageRef: ref,
  });
  const patch = s.calls.find((c) => c.method === 'PATCH' && /\/containers\/applications\/app-existing$/.test(c.url));
  ok('an existing application is PATCHed to roll the image, not recreated', !!patch && JSON.parse(patch.body).configuration.image === ref);
}

// 7. deployNamespaceScript: dispatch-namespace path + metadata main_module.
{
  const s = stub();
  await deployNamespaceScript(ctxOf(s), {
    ns: 'wp-wfp', name: 'site-blog', mainModule: 'index.js',
    modules: [{ name: 'index.js', content: 'export default {}' }],
    bindings: [{ type: 'kv_namespace', name: 'SITES', namespace_id: 'KV' }], compatibilityDate: '2026-07-01',
    migrations: { new_sqlite_classes: ['PhpRuntime'] },
  });
  const meta = JSON.parse(await s.calls[0].body.get('metadata').text());
  ok('wp deploy PUTs the namespace script', s.calls[0].url.endsWith(`/workers/dispatch/namespaces/wp-wfp/scripts/site-blog`));
  ok('wp metadata carries main_module + bindings', meta.main_module === 'index.js' && meta.bindings[0].name === 'SITES');
  // A SQLite DO binding without a migration is API 10061 (measured #158).
  ok('wp metadata carries the SQLite migration', meta.migrations && meta.migrations.new_tag === 'v1' && meta.migrations.new_sqlite_classes[0] === 'PhpRuntime');
}
// 7b. deployNamespaceScript with no SQLite classes omits migrations entirely.
{
  const s = stub();
  await deployNamespaceScript(ctxOf(s), {
    ns: 'wp-wfp', name: 'site-plain', mainModule: 'index.js',
    modules: [{ name: 'index.js', content: 'export default {}' }], compatibilityDate: '2026-07-01',
  });
  const meta = JSON.parse(await s.calls[0].body.get('metadata').text());
  ok('a site with no DO class sends no migrations key', !('migrations' in meta));
}

// 7c. ensureKVNamespace (#241): approach A binds a per-site OC_KV namespace. The
// create POSTs {title} and returns the assigned id; an already-existing title is
// idempotent (found in the list by title, reused, never a duplicate).
{
  const s = stub([{ status: 200, body: '{"success":true,"result":{"id":"OCKVID","title":"wp-wfp-blog-oc"}}' }]);
  const r = await ensureKVNamespace(ctxOf(s), 'wp-wfp-blog-oc');
  ok('ensureKVNamespace POSTs the namespaces endpoint with {title}',
    s.calls[0].method === 'POST' && s.calls[0].url.endsWith('/storage/kv/namespaces') && JSON.parse(s.calls[0].body).title === 'wp-wfp-blog-oc');
  ok('ensureKVNamespace returns the assigned id (created)', r.id === 'OCKVID' && r.created === true);
  // Idempotent by title: a 10014 "already exists" falls back to the list + reuse.
  const s2 = stub([
    { status: 409, body: '{"success":false,"errors":[{"code":10014,"message":"namespace already exists"}]}' },
    { status: 200, body: '{"success":true,"result":[{"id":"OTHER","title":"wp-wfp-other-oc"},{"id":"OCKVID","title":"wp-wfp-blog-oc"}]}' },
  ]);
  const r2 = await ensureKVNamespace(ctxOf(s2), 'wp-wfp-blog-oc');
  ok('ensureKVNamespace reuses an existing namespace by title (idempotent, no duplicate POST)',
    r2.id === 'OCKVID' && r2.existed === true && !s2.calls.slice(1).some((c) => c.method === 'POST'));
}

// 8. registry: upsert (PUT), list (keys), read (value), remove (DELETE).
{
  const s = stub();
  await upsertSite(ctxOf(s), { kvId: 'KV', hostname: 'shop.example.com', entry: { script: 'c1-shop', kind: 'shop' } });
  ok('upsertSite writes the map entry', s.calls[0].method === 'PUT');
  const s2 = stub([{ status: 200, body: '{"success":true,"result":[{"name":"a"},{"name":"b"}]}' }]);
  const names = await listSites(ctxOf(s2), { kvId: 'KV' });
  ok('listSites returns the hostnames', names.join(',') === 'a,b' && s2.calls[0].url.endsWith('/storage/kv/namespaces/KV/keys'));
  const s3 = stub([{ status: 200, body: '{"script":"c1-shop","kind":"shop"}' }]);
  const site = await readSite(ctxOf(s3), { kvId: 'KV', hostname: 'shop.example.com' });
  ok('readSite parses the entry', site && site.kind === 'shop');
  const s4 = stub([{ status: 404, body: '{"success":false,"errors":[{"code":10009}]}' }]);
  ok('readSite returns null for a missing key', (await readSite(ctxOf(s4), { kvId: 'KV', hostname: 'nope' })) === null);
  const s5 = stub();
  await removeSite(ctxOf(s5), { kvId: 'KV', hostname: 'shop.example.com' });
  ok('removeSite DELETEs the value', s5.calls[0].method === 'DELETE');
}


// 9. installWordPress (#215): HTTP install against the site, idempotent server-side.
{
  let n = 0;
  const f = async (url, init) => { n++; return { ok: true, status: 200, json: async () => ({ out: '{"installed":true,"user_id":7}' }) }; };
  const r = await installWordPress({ hostname: 'x.dev', spikeToken: 'tok', adminPassword: 'abcdefghijkl', fetchImpl: f });
  ok('installWordPress: success parses installed:true + user id, one call', r.installed === true && r.userId === 7 && n === 1);
  const r2 = await installWordPress({ hostname: 'x.dev', spikeToken: 'tok', adminPassword: 'abcdefghijkl', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ out: '{"installed":"already"}' }) }) });
  ok('installWordPress: already-installed is idempotent success', r2.installed === true && r2.already === true);
  let threw = false; try { await installWordPress({ hostname: 'x.dev', adminPassword: 'abcdefghijkl', fetchImpl: async () => ({}) }); } catch { threw = true; }
  ok('installWordPress: no SPIKE_TOKEN throws (needs the site secret to authorize)', threw);
  threw = false; try { await installWordPress({ hostname: 'x.dev', spikeToken: 'tok', adminPassword: 'short', fetchImpl: async () => ({}) }); } catch { threw = true; }
  ok('installWordPress: an admin password under 12 chars throws', threw);
  let m = 0; const retryF = async () => { m++; if (m < 2) return { ok: false, status: 403, json: async () => ({}) }; return { ok: true, status: 200, json: async () => ({ out: '{"installed":true}' }) }; };
  const r3 = await installWordPress({ hostname: 'x.dev', spikeToken: 'tok', adminPassword: 'abcdefghijkl', fetchImpl: retryF, retries: 3, intervalMs: 1 });
  ok('installWordPress: retries a transient failure then succeeds', r3.installed === true && m === 2);
  // the dispatch-binding path routes via env.DISPATCHER.get(scriptName).fetch(), no public HTTP
  let got = null;
  const dispatcher = { get: (name) => { got = name; return { fetch: async (req) => { const h = req.headers.get('x-spike-token'); return { ok: true, status: 200, json: async () => ({ out: h === 'tok' ? '{"installed":true,"user_id":9}' : '{"installed":false,"error":"forbidden"}' }) }; } }; } };
  const rd = await installWordPress({ dispatcher, scriptName: 'site-blog', spikeToken: 'tok', adminPassword: 'abcdefghijkl' });
  ok('installWordPress: dispatch binding routes to site-<name> with x-spike-token (no public HTTP)', rd.installed === true && rd.userId === 9 && rd.via === 'dispatch' && got === 'site-blog');
}

// 7d. createKvNamespace (#201 Phase 1): the stable op name the next wave's b-dosql
// L2 KV descriptor reaches; it is the ensureKVNamespace implementation (one source).
{
  ok('createKvNamespace is the ensureKVNamespace op (alias, no second implementation)', createKvNamespace === ensureKVNamespace);
  const s = stub([{ status: 200, body: '{"success":true,"result":{"id":"L2KVID","title":"wp-wfp-blog-l2"}}' }]);
  const r = await createKvNamespace(ctxOf(s), 'wp-wfp-blog-l2');
  ok('createKvNamespace POSTs the namespaces endpoint and returns the id', s.calls[0].method === 'POST' && s.calls[0].url.endsWith(`/accounts/${ACCT}/storage/kv/namespaces`) && r.id === 'L2KVID');
}

// 7e. createQueue (#201 Phase 1): a Cloudflare Queue for the next wave's durable
// async-email descriptor (#190). POST, idempotent by name on a create conflict.
{
  const s = stub([{ status: 200, body: '{"success":true,"result":{"queue_id":"QID","queue_name":"b2-email"}}' }]);
  const r = await createQueue(ctxOf(s), 'b2-email');
  ok('createQueue POSTs /queues with {queue_name}', s.calls[0].method === 'POST' && s.calls[0].url.endsWith(`/accounts/${ACCT}/queues`) && JSON.parse(s.calls[0].body).queue_name === 'b2-email');
  ok('createQueue returns the created id', r.id === 'QID' && r.created === true);
  // A create conflict (409) falls back to a name lookup and reuses the queue.
  const s2 = stub([
    { status: 409, body: '{"success":false,"errors":[{"code":10019,"message":"queue already exists"}]}' },
    { status: 200, body: '{"success":true,"result":[{"queue_id":"EXIST","queue_name":"b2-email"}]}' },
  ]);
  const r2 = await createQueue(ctxOf(s2), 'b2-email');
  ok('createQueue treats an existing queue as idempotent success (found by name)', r2.id === 'EXIST' && r2.existed === true && s2.calls[1].method === 'GET');
  // A hard failure with no matching queue throws (the instrument can fail).
  const s3 = stub([
    { status: 403, body: '{"success":false,"errors":[{"code":9109,"message":"forbidden"}]}' },
  ]);
  let threw = false; try { await createQueue(ctxOf(s3), 'b2-email'); } catch { threw = true; }
  ok('createQueue throws on a non-conflict error', threw);
}

// 7f. createVectorizeIndex (#201 Phase 2): a per-site Vectorize index for the
// semantic-search descriptor. POST /vectorize/v2/indexes with the model preset,
// idempotent by name on a create conflict, throws on any other error.
{
  const s = stub([{ status: 200, body: '{"success":true,"result":{"name":"wp-wfp-blog-search"}}' }]);
  const r = await createVectorizeIndex(ctxOf(s), 'wp-wfp-blog-search', { preset: '@cf/baai/bge-large-en-v1.5' });
  ok('createVectorizeIndex POSTs /vectorize/v2/indexes with {name, config.preset}',
    s.calls[0].method === 'POST' && s.calls[0].url.endsWith(`/accounts/${ACCT}/vectorize/v2/indexes`) &&
    JSON.parse(s.calls[0].body).name === 'wp-wfp-blog-search' &&
    JSON.parse(s.calls[0].body).config.preset === '@cf/baai/bge-large-en-v1.5');
  ok('createVectorizeIndex returns created on a fresh index', r.created === true && r.name === 'wp-wfp-blog-search');
  const s2 = stub([
    { status: 409, body: '{"success":false,"errors":[{"code":1000,"message":"index already exists"}]}' },
    { status: 200, body: '{"success":true,"result":[{"name":"wp-wfp-blog-search"}]}' },
  ]);
  const r2 = await createVectorizeIndex(ctxOf(s2), 'wp-wfp-blog-search', { preset: '@cf/baai/bge-large-en-v1.5' });
  ok('createVectorizeIndex treats an existing index as idempotent success (found by name)',
    r2.created === false && r2.existed === true && s2.calls[1].method === 'GET');
  const s3 = stub([{ status: 403, body: '{"success":false,"errors":[{"code":9109,"message":"forbidden"}]}' }]);
  let threw = false; try { await createVectorizeIndex(ctxOf(s3), 'wp-wfp-blog-search', { preset: '@cf/baai/bge-large-en-v1.5' }); } catch { threw = true; }
  ok('createVectorizeIndex throws on a non-conflict error', threw);
}

console.log(fail === 0 ? `all passed (${pass})` : `${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
