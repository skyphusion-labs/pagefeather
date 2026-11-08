// Offline test of the orchestration (#154 stage 2, hardened #182). Stubs
// fetchImpl, routes by URL + method, and asserts provisionSite drives the right
// ops in the right order for each kind, with the live-proven guards carried end
// to end (the shop Litestream secret is SHA-256(token value) with no newline,
// the shop image is the pushed digest), PLUS the #182 server-side guards: name
// validation, reserved-name refusal, anti-clobber, and idempotency live in the
// core, not only the CLI.
import { createHash } from 'node:crypto';
import { provisionSite } from '../provision.mjs';

const ACCT = 'fabcb25d9c7eb087110ec474a03e50d2';
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };

// A stub routed by URL + method.
//  - GET a KV value   = the idempotency read; 404 (not provisioned) unless opts.existing.
//  - GET a script path = the anti-clobber check; 404 (absent) unless opts.scriptExists.
//  - GET /tokens       = the mint reuse list; [] unless opts.existingToken.
//  - POST /tokens      = create, returns {id,value}.
function recorder(opts = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    if (init.method === 'GET' && /\/storage\/kv\/namespaces\/[^/]+\/values\//.test(url)) {
      if (opts.existing) return { ok: true, status: 200, text: async () => JSON.stringify(opts.existing) };
      return { ok: false, status: 404, text: async () => '{"success":false,"errors":[{"code":10009,"message":"key not found"}]}' };
    }
    if (init.method === 'GET' && /\/scripts\/[^/]+$/.test(url)) {
      if (opts.scriptExists) return { ok: true, status: 200, text: async () => '{"success":true,"result":{"id":"existing"}}' };
      return { ok: false, status: 404, text: async () => '{"success":false,"errors":[{"code":10090}]}' };
    }
    if (init.method === 'GET' && url.endsWith('/tokens')) {
      const body = opts.existingToken ? '{"success":true,"result":[{"id":"OLDID","name":"c1-store-litestream"}]}' : '{"success":true,"result":[]}';
      return { ok: true, status: 200, text: async () => body };
    }
    let body = '{"success":true,"result":{}}';
    if (init.method === 'POST' && url.endsWith('/tokens')) body = '{"success":true,"result":{"id":"TKID","value":"TKVAL"}}';
    else if (url.endsWith('/tokens/OLDID/value')) body = '{"success":true,"result":{"value":"ROLLED"}}';
    else if (url.endsWith('/settings')) body = '{"success":true,"result":{"bindings":[{"type":"durable_object_namespace","class_name":"Store","name":"STORE","namespace_id":"NSID"}]}}';
    else if (url.endsWith('/containers/applications')) body = '{"success":true,"result":[]}';
    return { ok: true, status: 200, text: async () => body };
  };
  return { fetchImpl, calls };
}
const metaOf = async (call) => JSON.parse(await call.body.get('metadata').text());
// Ops that MUTATE the account are everything but the read pre-checks (all GET).
const mutating = (calls) => calls.filter((c) => c.method !== 'GET');

// wp: bucket, deploy namespace script with secret_text bindings, registry entry.
{
  const rec = recorder();
  const r = await provisionSite({ acct: ACCT, token: 'T', fetchImpl: rec.fetchImpl }, {
    kind: 'wp', name: 'blog', namespace: 'wp-wfp', kvId: 'KV', hostname: 'wp-blog.sub.workers.dev',
    compatibilityDate: '2026-07-01', mainModule: 'index.js',
    modules: [{ name: 'index.js', content: 'export default {}' }],
    resourceBindings: [{ type: 'durable_object_namespace', name: 'PHP', class_name: 'PhpRuntime' }],
    secrets: { WP_SALT: 's1', SPIKE_TOKEN: 's2' },
    buckets: { media: 'wp-wfp-blog-media' },
  });
  const u = mutating(rec.calls).map((c) => `${c.method} ${c.url.split('/client/v4')[1]}`);
  ok('wp: bucket then namespace script then KV entry, in order',
    u[0].startsWith('POST /accounts/') && u[0].endsWith('/r2/buckets') &&
    /PUT .*\/workers\/dispatch\/namespaces\/wp-wfp\/scripts\/site-blog$/.test(u[1]) &&
    /PUT .*\/storage\/kv\/namespaces\/KV\/values\/wp-blog/.test(u[2]));
  const deploy = rec.calls.find((c) => c.method === 'PUT' && /\/scripts\/site-blog$/.test(c.url));
  const meta = await metaOf(deploy);
  const secretNames = meta.bindings.filter((b) => b.type === 'secret_text').map((b) => b.name).sort();
  ok('wp: secrets are secret_text bindings in the deploy (atomic)', secretNames.join(',') === 'SPIKE_TOKEN,WP_SALT');
  ok('wp: resource binding carried too', meta.bindings.some((b) => b.type === 'durable_object_namespace' && b.name === 'PHP'));
  ok('wp: migration declares the SQLite DO class (fixes live 10061)', meta.migrations && meta.migrations.new_sqlite_classes.includes('PhpRuntime'));
  ok('wp: registry entry kind wp', r.entry.kind === 'wp' && r.script === 'site-blog');
  ok('wp: an idempotency read happened before any create', rec.calls[0].method === 'GET' && /\/values\/wp-blog/.test(rec.calls[0].url));
  ok('wp: an anti-clobber script check happened before any create', rec.calls.some((c) => c.method === 'GET' && /\/scripts\/site-blog$/.test(c.url)));
}

// wp with a SaaS zone: the core also places the proxied routing record.
{
  const rec = recorder();
  await provisionSite({ acct: ACCT, token: 'T', fetchImpl: rec.fetchImpl }, {
    kind: 'wp', name: 'shopfront', namespace: 'wp-wfp', kvId: 'KV',
    hostname: 'shopfront.skyphusionwp.dev', saasZoneId: 'ZONE',
    compatibilityDate: '2026-07-01', mainModule: 'index.js',
    modules: [{ name: 'index.js', content: 'export default {}' }],
    sqliteClasses: ['PhpRuntime'],
    secrets: { WP_SALT: 's1', SPIKE_TOKEN: 's2' }, buckets: { media: 'wp-wfp-shopfront-media' },
  });
  const u = rec.calls.map((c) => `${c.method} ${c.url.split('/client/v4')[1]}`);
  ok('wp+saas: a proxied routing record is placed on the SaaS zone',
    u.some((c) => /POST \/zones\/ZONE\/dns_records$/.test(c)));
}

// shop: two buckets, mint (before deploy), container deploy with digest + the
// no-newline Litestream secret, registry entry with resources.
{
  const rec = recorder();
  const ref = `registry.cloudflare.com/${ACCT}/wp-woo-c1@sha256:${'a'.repeat(64)}`;
  const r = await provisionSite({ acct: ACCT, token: 'T', fetchImpl: rec.fetchImpl }, {
    kind: 'shop', name: 'store', namespace: 'wp-wfp', kvId: 'KV', hostname: 'c1-store.sub.workers.dev',
    compatibilityDate: '2026-07-01', mainModule: 'worker.js',
    modules: [{ name: 'worker.js', content: 'export default {}' }],
    resourceBindings: [{ type: 'r2_bucket', name: 'MEDIA', bucket_name: 'wp-woo-store-media' }],
    secrets: { WP_SALT: 's1', ADMIN_PASSWORD: 's2', SPIKE_TOKEN: 's3' },
    buckets: { db: 'wp-woo-store-db', media: 'wp-woo-store-media' },
    imageRef: ref, containerClass: 'Store', instanceType: 'basic',
  });
  const u = mutating(rec.calls).map((c) => `${c.method} ${c.url.split('/client/v4')[1]}`);
  ok('shop: two buckets, then /tokens, then the worker deploy, then KV, in order',
    u.filter((x) => x.endsWith('/r2/buckets')).length === 2 &&
    u.findIndex((x) => x.endsWith('/tokens')) < u.findIndex((x) => /\/workers\/scripts\/c1-store$/.test(x)) &&
    /PUT .*\/workers\/scripts\/c1-store$/.test(u.find((x) => /\/workers\/scripts\/c1-store$/.test(x))) &&
    u.some((x) => /\/storage\/kv\/namespaces\/KV\/values\/c1-store/.test(x)));
  const deploy = rec.calls.find((c) => c.method === 'PUT' && /\/workers\/scripts\/c1-store$/.test(c.url));
  const meta = await metaOf(deploy);
  const appCreate = rec.calls.find((c) => c.method === 'POST' && c.url.endsWith('/containers/applications'));
  ok('shop: the container application is created against the DO namespace', appCreate && JSON.parse(appCreate.body).durable_objects.namespace_id === 'NSID');
  ok('shop: container image is the pushed digest (no build)', appCreate && JSON.parse(appCreate.body).configuration.image === ref);
  ok('shop: the workers.dev subdomain is enabled (reachable)', rec.calls.some((c) => c.method === 'POST' && /\/workers\/scripts\/c1-store\/subdomain$/.test(c.url)));
  const litestreamSecret = meta.bindings.find((b) => b.type === 'secret_text' && b.name === 'LITESTREAM_SECRET_ACCESS_KEY');
  ok('shop: LITESTREAM_SECRET_ACCESS_KEY = SHA-256(token value), NO newline',
    litestreamSecret && litestreamSecret.text === createHash('sha256').update('TKVAL').digest('hex'));
  ok('shop: that secret is NOT SHA-256(value + newline)',
    litestreamSecret.text !== createHash('sha256').update('TKVAL\n').digest('hex'));
  ok('shop: LITESTREAM_ACCESS_KEY_ID = the token id', meta.bindings.some((b) => b.name === 'LITESTREAM_ACCESS_KEY_ID' && b.text === 'TKID'));
  ok('shop: registry entry kind shop with resources (token id, not value)',
    r.entry.kind === 'shop' && r.entry.resources.litestreamTokenId === 'TKID' && r.entry.resources.dbBucket === 'wp-woo-store-db');
}

// #182 grok residual 4: mint is idempotent by name. An existing token with the
// site's litestream name is ROLLED (same id) and reused, not re-created.
{
  const rec = recorder({ existingToken: true });
  const ref = `registry.cloudflare.com/${ACCT}/wp-woo-c1@sha256:${'b'.repeat(64)}`;
  const r = await provisionSite({ acct: ACCT, token: 'T', fetchImpl: rec.fetchImpl }, {
    kind: 'shop', name: 'store', namespace: 'wp-wfp', kvId: 'KV', hostname: 'c1-store2.sub.workers.dev',
    compatibilityDate: '2026-07-01', mainModule: 'worker.js',
    modules: [{ name: 'worker.js', content: 'export default {}' }],
    secrets: {}, buckets: { db: 'wp-woo-store-db', media: 'wp-woo-store-media' },
    imageRef: ref, containerClass: 'Store', tokenName: 'c1-store-litestream',
  });
  ok('mint reuse: NO new token is POSTed when one with the name exists',
    !rec.calls.some((c) => c.method === 'POST' && c.url.endsWith('/tokens')));
  ok('mint reuse: the existing token is ROLLED (PUT .../OLDID/value) and its id reused',
    rec.calls.some((c) => c.method === 'PUT' && c.url.endsWith('/tokens/OLDID/value')) &&
    r.entry.resources.litestreamTokenId === 'OLDID');
  const deploy = rec.calls.find((c) => c.method === 'PUT' && /\/workers\/scripts\/c1-store$/.test(c.url));
  const meta = await metaOf(deploy);
  ok('mint reuse: the rolled value is the Litestream secret',
    meta.bindings.find((b) => b.name === 'LITESTREAM_SECRET_ACCESS_KEY').text === createHash('sha256').update('ROLLED').digest('hex'));
}

// #182: server-side name validation. A bad name is rejected in the CORE.
{
  const bad = { kind: 'wp', name: 'Bad_Name', namespace: 'wp-wfp', kvId: 'KV', hostname: 'x.sub.workers.dev',
    compatibilityDate: '2026-07-01', modules: [{ name: 'index.js', content: 'x' }], secrets: {}, buckets: { media: 'm' } };
  let threw = false;
  try { await provisionSite({ acct: ACCT, token: 'T', fetchImpl: recorder().fetchImpl }, bad); } catch (e) { threw = /invalid site name/.test(e.message); }
  ok('wp: provisionSite rejects a bad name server-side (not only the CLI)', threw);
  const recOk = recorder();
  await provisionSite({ acct: ACCT, token: 'T', fetchImpl: recOk.fetchImpl }, { ...bad, name: 'good-name', hostname: 'good.sub.workers.dev' });
  ok('wp: the same path ACCEPTS a valid name (the check can pass, not always-throw)', recOk.calls.some((c) => c.method === 'POST' && c.url.endsWith('/r2/buckets')));
}

// #182 grok residual 2: a RESERVED name is refused server-side.
{
  let threw = false;
  try {
    await provisionSite({ acct: ACCT, token: 'T', fetchImpl: recorder().fetchImpl }, {
      kind: 'wp', name: 'www', namespace: 'wp-wfp', kvId: 'KV', hostname: 'www.skyphusionwp.dev',
      compatibilityDate: '2026-07-01', modules: [{ name: 'index.js', content: 'x' }], secrets: {}, buckets: { media: 'm' },
    });
  } catch (e) { threw = /reserved site name/.test(e.message); }
  ok('wp: provisionSite refuses a reserved name (www) server-side', threw);
}

// #182 grok residual 2: anti-clobber. A script that already exists for a hostname
// NOT in the registry is refused (never overwritten).
{
  const rec = recorder({ scriptExists: true });
  let threw = false;
  try {
    await provisionSite({ acct: ACCT, token: 'T', fetchImpl: rec.fetchImpl }, {
      kind: 'wp', name: 'blog', namespace: 'wp-wfp', kvId: 'KV', hostname: 'brand-new.sub.workers.dev',
      compatibilityDate: '2026-07-01', modules: [{ name: 'index.js', content: 'x' }], secrets: {}, buckets: { media: 'm' },
    });
  } catch (e) { threw = /refusing to clobber/.test(e.message); }
  ok('wp: refuses to clobber an existing script not in the registry', threw);
  ok('anti-clobber: nothing was created (no bucket/deploy/KV write)', mutating(rec.calls).length === 0);
}

// #182: idempotency. A hostname already in the registry returns the existing
// site with NO second create, deploy or overwrite.
{
  const rec = recorder({ existing: { script: 'site-blog', kind: 'wp', outbound: true } });
  const r = await provisionSite({ acct: ACCT, token: 'T', fetchImpl: rec.fetchImpl }, {
    kind: 'wp', name: 'blog', namespace: 'wp-wfp', kvId: 'KV', hostname: 'wp-blog.sub.workers.dev',
    compatibilityDate: '2026-07-01', modules: [{ name: 'index.js', content: 'x' }],
    secrets: { WP_SALT: 's1' }, buckets: { media: 'wp-wfp-blog-media' },
  });
  ok('idempotent: an existing site is returned, flagged existing', r.existing === true && r.script === 'site-blog' && r.entry.kind === 'wp');
  ok('idempotent: NO mutating call happened (no second create/deploy/overwrite)', mutating(rec.calls).length === 0);
}

console.log(fail === 0 ? `all passed (${pass})` : `${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
