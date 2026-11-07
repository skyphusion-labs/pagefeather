// Offline test of the provisioning Worker entry (#154 stage 3). It stubs the
// GLOBAL fetch (the Worker's ops use it, not an injected one) and calls the
// default fetch handler, proving the same core runs in a Worker shape.
import worker from '../worker.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };

const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { calls.push({ url, method: init.method }); return { ok: true, status: 200, text: async () => '{"success":true,"result":{}}' }; };

try {
  // Non-POST is rejected.
  const g = await worker.fetch(new Request('https://p/', { method: 'GET' }), { CF_ACCOUNT_ID: 'A', PROVISION_TOKEN: 'T' });
  ok('GET is 405', g.status === 405);

  // Missing env is a clean 500, not a throw.
  const noenv = await worker.fetch(new Request('https://p/', { method: 'POST', body: '{}' }), {});
  ok('missing env is 500', noenv.status === 500);

  // A wp provision runs through provisionSite using the global fetch.
  const cfg = {
    kind: 'wp', name: 'blog', namespace: 'wp-wfp', kvId: 'KV', hostname: 'wp-blog.sub.workers.dev',
    compatibilityDate: '2026-07-01', mainModule: 'index.js',
    modules: [{ name: 'index.js', content: 'export default {}' }],
    resourceBindings: [], secrets: { WP_SALT: 's' }, buckets: { media: 'wp-wfp-blog-media' },
  };
  const r = await worker.fetch(new Request('https://p/', { method: 'POST', body: JSON.stringify(cfg) }), { CF_ACCOUNT_ID: 'A', PROVISION_TOKEN: 'T' });
  const j = await r.json();
  ok('POST a wp cfg provisions through the core', r.status === 200 && j.ok === true && j.script === 'site-blog');
  ok('the Worker drove CF API calls via the global fetch', calls.some((c) => c.url.includes('/r2/buckets')) && calls.some((c) => c.url.includes('/workers/dispatch/namespaces/wp-wfp/scripts/site-blog')));
} finally {
  globalThis.fetch = realFetch;
}

console.log(fail === 0 ? `all passed (${pass})` : `${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
