// The Workers static-assets upload the one-click core did not make (#1036).
// Offline: fetchImpl is a stub. No Cloudflare call.
// Hash: SHA-256 of base64(file bytes) plus the extension, first 32 hex characters.
// That is the programmatic example on
// https://developers.cloudflare.com/workers/static-assets/direct-upload/ (read 2026-11-20).
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { assetContentHash, uploadDispatchAssets, deployNamespaceScript } from '../ops.mjs';

const ACCT = 'fabcb25d9c7eb087110ec474a03e50d2';
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };

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
const ctxOf = (s) => ({ acct: ACCT, token: 'ACCOUNT_TOKEN', fetchImpl: s.fetchImpl });

function localHash(bytes, name) {
  const base = name.split('/').pop();
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
  const b64 = Buffer.from(bytes).toString('base64');
  return createHash('sha256').update(b64 + ext).digest('hex').slice(0, 32);
}

const pack = new TextEncoder().encode('pack-bytes');
const path = '/_pf/bid/oc-0.zip';
const hash = await assetContentHash(pack, path);
ok('asset hash of pack-bytes is the documented 32 hex characters', hash === 'bc9a15fa0e2ee54c38bbca4ab2c1d6dc');
const bin = new Uint8Array([0, 255, 10]);
ok('asset hash matches base64 of arbitrary bytes, not a utf8 reading', (await assetContentHash(bin, 'a.zip')) === localHash(bin, 'a.zip'));

{
  const s = stub([{ status: 200, body: JSON.stringify({ success: true, result: { jwt: 'only-jwt', buckets: [] } }) }]);
  const r = await uploadDispatchAssets(ctxOf(s), { ns: 'pagefeather', name: 'site-blog', files: [{ path, bytes: pack }] });
  ok('an empty bucket list uploads nothing and keeps the session jwt', s.calls.length === 1 && r.jwt === 'only-jwt');
  ok('the session is the dispatch-namespace assets-upload-session', s.calls[0].method === 'POST' && s.calls[0].url.endsWith(`/accounts/${ACCT}/workers/dispatch/namespaces/pagefeather/scripts/site-blog/assets-upload-session`));
  const body = JSON.parse(s.calls[0].body);
  ok('the manifest path, hash and size are the pack', body.manifest[path].hash === hash && body.manifest[path].size === pack.byteLength);
  ok('the session uses the account token', (s.calls[0].headers.authorization || '').includes('ACCOUNT_TOKEN'));
  ok('run_worker_first is /_pf/*', JSON.stringify(r.runWorkerFirst) === JSON.stringify(['/_pf/*']));
}

{
  const s = stub([
    { status: 200, body: JSON.stringify({ success: true, result: { jwt: 'upload-jwt', buckets: [[hash]] } }) },
    { status: 201, body: JSON.stringify({ success: true, result: { jwt: 'completion-jwt' } }) },
  ]);
  const r = await uploadDispatchAssets(ctxOf(s), { ns: 'pagefeather', name: 'site-blog', files: [{ path, bytes: pack, hash }] });
  ok('a bucket is uploaded, and the completion jwt replaces the session jwt', r.jwt === 'completion-jwt' && s.calls.length === 2);
  const up = s.calls[1];
  ok('the upload is workers/assets/upload?base64=true', up.method === 'POST' && up.url.endsWith(`/accounts/${ACCT}/workers/assets/upload?base64=true`));
  ok('the upload bearer is the session jwt, not the account token', (up.headers.authorization || '') === 'Bearer upload-jwt');
  const part = await up.body.get(hash).text();
  ok('the part is the base64 of the pack bytes', part === Buffer.from(pack).toString('base64'));
}

{
  const s = stub([]);
  let threw = false;
  try { await uploadDispatchAssets(ctxOf(s), { ns: 'pagefeather', name: 'site-blog', files: [{ path: '/etc/passwd', bytes: pack }] }); }
  catch (e) { threw = /bad path/.test(e.message); }
  ok('a path outside /_pf/ is refused before any call', threw && s.calls.length === 0);
}

{
  const s = stub([{ status: 200, body: '{"success":true,"result":{"id":"site-blog"}}' }]);
  await deployNamespaceScript(ctxOf(s), {
    ns: 'pagefeather', name: 'site-blog', mainModule: 'index.js',
    modules: [{ name: 'index.js', content: 'export default {}' }],
    bindings: [{ type: 'plain_text', name: 'SITE_ORIGIN', text: 'https://x' }],
    compatibilityDate: '2026-07-01',
    assets: { jwt: 'completion-jwt', runWorkerFirst: ['/_pf/*'] },
  });
  const meta = JSON.parse(await s.calls[0].body.get('metadata').text());
  ok('the script metadata carries the completion jwt', meta.assets && meta.assets.jwt === 'completion-jwt');
  ok('run_worker_first is /_pf/* and a missing asset is not served', JSON.stringify(meta.assets.config.run_worker_first) === JSON.stringify(['/_pf/*']) && meta.assets.config.not_found_handling === 'none');
  ok('the ASSETS binding is on the script', meta.bindings.some((b) => b.type === 'assets' && b.name === 'ASSETS'));
}

{
  const s = stub([{ status: 200, body: '{"success":true,"result":{"id":"site-blog"}}' }]);
  await deployNamespaceScript(ctxOf(s), {
    ns: 'pagefeather', name: 'site-blog', mainModule: 'index.js',
    modules: [{ name: 'index.js', content: 'export default {}' }],
    bindings: [], compatibilityDate: '2026-07-01',
  });
  const meta = JSON.parse(await s.calls[0].body.get('metadata').text());
  ok('a script with no packs has no assets block (the opt-out and every older bundle)', !meta.assets);
}

console.log(fail === 0 ? `all passed (${pass})` : `${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
