// #782: site update for a core-path site, and the remove checks that are not already
// pinned in remove-site-test.mjs. A stand-in account only: no live Cloudflare call.
// Run: node deploy/provision/tests/update-site-test.mjs
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, removeCommand } from '../cli.mjs';
import { teardownDemoSite } from '../demo.mjs';
import * as sites from '../../oneclick/sites.mjs';

const cli = await import('../cli.mjs');
const updateCommand = cli.updateCommand;

let fails = 0;
function ok(label, cond) { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) fails++; }
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
const okJ = (result) => res(200, { success: true, result });

const ENV = {
  WFP_SAAS_ZONE_ID: 'ZONE', WFP_KV_ID: 'MAP', WFP_NAMESPACE: 'NS',
  WP_HOSTNAME: 'acme.skyphusionwp.dev', WFP_COMPAT: '2026-07-01',
};
const ENTRY = { script: 'site-acme', kind: 'wp', customHostnameId: 'CH1' };
const SECRET_VALUE = 'super-secret-value-not-for-payload';
const LIVE = [
  { type: 'r2_bucket', name: 'MEDIA', bucket_name: 'wp-wfp-acme-media' },
  { type: 'durable_object_namespace', name: 'PHP_RUNTIME', class_name: 'PhpRuntime' },
  { type: 'kv_namespace', name: 'OC_KV', namespace_id: 'oc-1' },
  { type: 'plain_text', name: 'SITE_ORIGIN', text: 'https://acme.skyphusionwp.dev' },
  { type: 'plain_text', name: 'PLANTED', text: 'keep-this-value' },
  { type: 'secret_text', name: 'WP_SALT', text: SECRET_VALUE },
  { type: 'secret_text', name: 'SPIKE_TOKEN' },
  { type: 'secret_text', name: 'INVOICE_TOKEN' },
];

function bundleDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pf782-bundle-'));
  writeFileSync(join(dir, 'index.js'), 'export default { fetch() { return new Response("new"); } }\n');
  return dir;
}

// A stand-in that keeps the entry and the script until a DELETE, and records every call.
function account({ entry = ENTRY, script = true, bindings = LIVE, bindingsStatus = 200 } = {}) {
  const st = { entry: entry ? JSON.stringify(entry) : null, script };
  const calls = [];
  let uploaded = null;
  const fetchImpl = async (url, init) => {
    const p = url.split('/client/v4')[1];
    const m = init.method;
    calls.push(`${m} ${p}`);
    if (/\/storage\/kv\/namespaces\/MAP\/values\//.test(p)) {
      if (m === 'GET') return st.entry ? { ok: true, status: 200, text: async () => st.entry } : res(404, { success: false, errors: [{ code: 10009, message: 'key not found' }] });
      if (m === 'DELETE') { st.entry = null; return okJ({}); }
    }
    if (/\/dispatch\/namespaces\/NS\/scripts\/site-acme\/bindings$/.test(p) && m === 'GET') {
      if (bindingsStatus !== 200) return res(bindingsStatus, { success: false, errors: [{ code: 10000, message: 'stand-in failure' }] });
      return okJ(bindings);
    }
    if (/\/dispatch\/namespaces\/NS\/scripts\/site-acme$/.test(p)) {
      if (m === 'GET') return st.script ? okJ({ script: { id: 'site-acme' } }) : res(404, { success: false, errors: [{ code: 10007, message: 'not found' }] });
      if (m === 'PUT') {
        uploaded = init.body;
        return okJ({ id: 'site-acme' });
      }
      if (m === 'DELETE') { st.script = false; return okJ({}); }
    }
    if (m === 'GET' && /\/dns_records\?/.test(p)) return okJ([{ id: 'DNS1' }]);
    if (m === 'GET' && /\/storage\/kv\/namespaces\?/.test(p)) return okJ([{ id: 'OC1', title: 'wp-wfp-acme-oc' }]);
    if (m === 'GET' && /\/queues\?/.test(p)) return okJ([{ queue_id: 'Q1', queue_name: 'wp-wfp-acme-email' }, { queue_id: 'Q2', queue_name: 'wp-wfp-acme-email-dlq' }]);
    if (m === 'GET' && /\/r2\/buckets\/[^/]+\/objects/.test(p)) return okJ({ objects: [] });
    if (m === 'DELETE') return okJ({});
    return okJ({});
  };
  return { st, calls, ctx: { acct: 'ACCT', token: 'tok', fetchImpl }, uploaded: () => uploaded };
}

const at = (calls, s) => calls.findIndex((c) => c.startsWith(s));

// 1. remove without --delete-data leaves the data and fails, naming what it kept.
{
  const A = account();
  const lines = [];
  let threw = null;
  try { await removeCommand(A.ctx, parseArgs(['remove', 'acme']), ENV, { out: (x) => lines.push(String(x)) }); }
  catch (e) { threw = e; }
  const txt = `${lines.join('\n')}\n${threw ? threw.message : ''}`;
  ok('remove without --delete-data: no DELETE', !A.calls.some((c) => c.startsWith('DELETE')));
  ok('remove without --delete-data: the script and the entry are still there', A.st.script === true && A.st.entry !== null);
  ok('remove without --delete-data: exits non-zero (throws)', threw !== null);
  ok('remove without --delete-data: names the data it kept', threw !== null && /site code and database \(site-acme\)/.test(txt) && /media bucket \(wp-wfp-acme-media\)/.test(txt));
}

// 2. remove with --delete-data deletes every part. Order is the landed one
// (custom hostname, DNS, script, resources, registry entry last).
{
  const A = account();
  const lines = [];
  let threw = null;
  try { await removeCommand(A.ctx, parseArgs(['remove', 'acme', '--delete-data']), ENV, { out: (x) => lines.push(String(x)) }); }
  catch (e) { threw = e; }
  const i = {
    ch: at(A.calls, 'DELETE /zones/ZONE/custom_hostnames/CH1'),
    dns: at(A.calls, 'DELETE /zones/ZONE/dns_records/DNS1'),
    script: at(A.calls, 'DELETE /accounts/ACCT/workers/dispatch/namespaces/NS/scripts/site-acme'),
    oc: at(A.calls, 'DELETE /accounts/ACCT/storage/kv/namespaces/OC1'),
    bucket: at(A.calls, 'DELETE /accounts/ACCT/r2/buckets/wp-wfp-acme-media'),
    entry: at(A.calls, 'DELETE /accounts/ACCT/storage/kv/namespaces/MAP/values/acme.skyphusionwp.dev'),
  };
  ok('remove --delete-data: does not throw', threw === null);
  ok('remove --delete-data: every part is deleted', Object.values(i).every((n) => n >= 0));
  ok('remove --delete-data: hostname and DNS before the script, entry last', i.ch < i.dns && i.dns < i.script && i.script < i.oc && i.oc < i.bucket && i.bucket < i.entry);
  ok('remove --delete-data: the script and the entry are gone', A.st.script === false && A.st.entry === null);
}

// 3. An unknown name (no registry entry, so no parts to find) is refused before any write.
{
  const A = account({ entry: null, script: false });
  let threw = null;
  try { await removeCommand(A.ctx, parseArgs(['remove', 'acme']), ENV, { out: () => {} }); }
  catch (e) { threw = e; }
  ok('remove of an unknown name: refused', threw !== null && /no registry entry/.test(threw.message));
  ok('remove of an unknown name: no write', !A.calls.some((c) => c.startsWith('DELETE') || c.startsWith('PUT') || c.startsWith('POST') || c.startsWith('PATCH')));
}

// 4. update re-uploads the bundle and keeps every live binding and every secret name.
{
  const dir = bundleDir();
  const A = account();
  const lines = [];
  let threw = null, r = null;
  try {
    r = await updateCommand(A.ctx, parseArgs(['update', 'acme']), { ...ENV, BDOSQL_BUNDLE_DIR: dir }, { out: (x) => lines.push(String(x)) });
  } catch (e) { threw = e; }
  finally { rmSync(dir, { recursive: true, force: true }); }
  const put = A.calls.filter((c) => c.startsWith('PUT'));
  let meta = null;
  const body = A.uploaded();
  if (body && typeof body.get === 'function') meta = JSON.parse(await body.get('metadata').text());
  const metaText = meta ? JSON.stringify(meta) : '';
  const sent = meta ? meta.bindings : [];
  const want = LIVE.filter((b) => b.type !== 'secret_text');
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  ok('update: the command exists and does not throw', typeof updateCommand === 'function' && threw === null && r);
  ok('update: one upload, and it is the namespace script', put.length === 1 && put[0] === 'PUT /accounts/ACCT/workers/dispatch/namespaces/NS/scripts/site-acme');
  ok('update: the upload keeps every non-secret binding, field for field', meta && same(sent, want));
  ok('update: keep_bindings is secret_text, and no migrations block', meta && same(meta.keep_bindings, ['secret_text']) && !Object.hasOwn(meta, 'migrations'));
  ok('update: every secret name is kept by that type, and no secret value is in the payload',
    meta && ['WP_SALT', 'SPIKE_TOKEN', 'INVOICE_TOKEN'].every((n) => (r.secrets || []).includes(n)) && !metaText.includes(SECRET_VALUE) && !sent.some((b) => b.type === 'secret_text'));
  ok('update: the upload is the new bundle module', body && typeof body.get === 'function' && /new/.test(await body.get('index.js').text()));
}

// 5. update refuses when the live script is missing, before any upload.
{
  const dir = bundleDir();
  const A = account({ script: false });
  let threw = null;
  try { await updateCommand(A.ctx, parseArgs(['update', 'acme']), { ...ENV, BDOSQL_BUNDLE_DIR: dir }, { out: () => {} }); }
  catch (e) { threw = e; }
  finally { rmSync(dir, { recursive: true, force: true }); }
  ok('update of a missing script: refused before any upload', threw !== null && /not in the namespace/.test(threw ? threw.message : '') && !A.calls.some((c) => c.startsWith('PUT')));
}

// 6. update refuses when the bindings cannot be read, before any upload.
{
  const dir = bundleDir();
  const A = account({ bindingsStatus: 500 });
  let threw = null;
  try { await updateCommand(A.ctx, parseArgs(['update', 'acme']), { ...ENV, BDOSQL_BUNDLE_DIR: dir }, { out: () => {} }); }
  catch (e) { threw = e; }
  finally { rmSync(dir, { recursive: true, force: true }); }
  ok('update when bindings cannot be read: refused before any upload', threw !== null && /bindings/.test(threw ? threw.message : '') && !A.calls.some((c) => c.startsWith('PUT')));
}

// 6b. Approach A: an update with no placement is refused before any upload.
//     With --placement, the upload carries that placement and still keeps the bindings.
{
  const dir = bundleDir();
  writeFileSync(join(dir, 'index-a-lean.js'), 'export default { fetch() { return new Response("a"); } }\n');
  const aEntry = { script: 'site-acme', kind: 'a' };
  const A = account({ entry: aEntry });
  let threw = null;
  try { await updateCommand(A.ctx, parseArgs(['update', 'acme']), { ...ENV, A_BUNDLE_DIR: dir }, { out: () => {} }); }
  catch (e) { threw = e; }
  ok('update kind a with no placement: refused before any upload', threw !== null && /Nothing was uploaded/.test(threw ? threw.message : '') && /placement/.test(threw.message) && !/usage:/.test(threw.message) && !A.calls.some((c) => c.startsWith('PUT')));
  const B = account({ entry: aEntry });
  let r = null;
  threw = null;
  try { r = await updateCommand(B.ctx, parseArgs(['update', 'acme', '--placement', 'azure:westus2']), { ...ENV, A_BUNDLE_DIR: dir }, { out: () => {} }); }
  catch (e) { threw = e; }
  finally { rmSync(dir, { recursive: true, force: true }); }
  let meta = null;
  const body = B.uploaded();
  if (body && typeof body.get === 'function') meta = JSON.parse(await body.get('metadata').text());
  ok('update kind a: placement is sent, bindings kept, no migrations', threw === null && r && meta
    && meta.placement && meta.placement.mode === 'targeted' && meta.placement.region === 'azure:westus2'
    && JSON.stringify(meta.keep_bindings) === JSON.stringify(['secret_text']) && !Object.hasOwn(meta, 'migrations'));
}

// 7. teardownDemoSite makes the same API calls it made before this change.
{
  const calls = [];
  const fetchImpl = async (url, init) => {
    const p = String(url).split('/client/v4')[1];
    calls.push(`${init.method} ${p}`);
    const okBody = (result) => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, result }) });
    if (init.method === 'GET' && /\/dns_records/.test(p)) return okBody([{ id: 'rec1' }]);
    if (init.method === 'GET' && /\/storage\/kv\/namespaces\?/.test(p)) return okBody([{ id: 'OCOLD', title: 'wp-wfp-demo-ddd-oc' }]);
    if (init.method === 'GET' && /\/queues\?/.test(p)) return okBody([
      { queue_id: 'Q1', queue_name: 'wp-wfp-demo-ddd-email' },
      { queue_id: 'Q2', queue_name: 'wp-wfp-demo-ddd-email-dlq' },
    ]);
    if (init.method === 'GET' && /\/objects/.test(p)) return okBody({ objects: [] });
    if (init.method === 'DELETE') return okBody({});
    return okBody({});
  };
  const env = { CF_ACCOUNT_ID: 'ACCT', WP_PROVISION_TOKEN: 'wp-tok', WFP_KV_ID: 'SERVERKV', WFP_NAMESPACE: 'wp-wfp' };
  const done = await teardownDemoSite({ acct: 'ACCT', token: 'wp-tok', fetchImpl }, env, 'demo-ddd.skyphusionwp.dev',
    { name: 'demo-ddd', script: 'site-demo-ddd', mediaBucket: 'wp-wfp-demo-ddd-media', saasZoneId: 'SERVERZONE' });
  const want = [
    'GET /zones/SERVERZONE/dns_records?type=AAAA&name=demo-ddd.skyphusionwp.dev',
    'DELETE /zones/SERVERZONE/dns_records/rec1',
    'DELETE /accounts/ACCT/workers/dispatch/namespaces/wp-wfp/scripts/site-demo-ddd',
    'GET /accounts/ACCT/storage/kv/namespaces?per_page=100&page=1',
    'DELETE /accounts/ACCT/storage/kv/namespaces/OCOLD',
    'GET /accounts/ACCT/queues?per_page=100&page=1',
    'DELETE /accounts/ACCT/queues/Q1',
    'GET /accounts/ACCT/queues?per_page=100&page=1',
    'DELETE /accounts/ACCT/queues/Q2',
    'DELETE /accounts/ACCT/vectorize/v2/indexes/wp-wfp-demo-ddd-search',
    'GET /accounts/ACCT/r2/buckets/wp-wfp-demo-ddd-media/objects?per_page=1000',
    'DELETE /accounts/ACCT/r2/buckets/wp-wfp-demo-ddd-media',
    'DELETE /accounts/ACCT/storage/kv/namespaces/SERVERKV/values/demo-ddd.skyphusionwp.dev',
  ];
  ok('teardownDemoSite: the same API calls as before', calls.join('\n') === want.join('\n') && done.script && done.bucket && done.kv);
}

// 8. undoStore makes the same API calls as before (front door, then the site parts, no database).
{
  const undoStore = sites.undoStore;
  const calls = [];
  const fetchImpl = async (url, init) => {
    const p = String(url).split('/client/v4')[1];
    calls.push(`${init.method} ${p}`);
    const okBody = (result) => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, result }) });
    if (init.method === 'GET' && /\/storage\/kv\/namespaces\?/.test(p)) return okBody([{ id: 'OC1', title: 'wp-wfp-acme-oc' }]);
    if (init.method === 'GET' && /\/queues\?/.test(p)) return okBody([
      { queue_id: 'Q1', queue_name: 'wp-wfp-acme-email' },
      { queue_id: 'Q2', queue_name: 'wp-wfp-acme-email-dlq' },
    ]);
    if (init.method === 'GET' && /\/objects/.test(p)) return okBody({ objects: [] });
    if (init.method === 'DELETE') return okBody({});
    return okBody({});
  };
  let threw = null;
  if (typeof undoStore !== 'function') threw = new Error('undoStore is not exported');
  else {
    try { await undoStore({ acct: 'ACCT', token: 'tok', fetchImpl }, { name: 'acme', kvId: 'MAP', namespace: 'NS', hostname: 'acme.example' }); }
    catch (e) { threw = e; }
  }
  const want = [
    'DELETE /accounts/ACCT/workers/scripts/wp-acme',
    'DELETE /accounts/ACCT/workers/dispatch/namespaces/NS/scripts/site-acme',
    'GET /accounts/ACCT/storage/kv/namespaces?per_page=100&page=1',
    'DELETE /accounts/ACCT/storage/kv/namespaces/OC1',
    'GET /accounts/ACCT/queues?per_page=100&page=1',
    'DELETE /accounts/ACCT/queues/Q1',
    'GET /accounts/ACCT/queues?per_page=100&page=1',
    'DELETE /accounts/ACCT/queues/Q2',
    'DELETE /accounts/ACCT/vectorize/v2/indexes/wp-wfp-acme-search',
    'GET /accounts/ACCT/r2/buckets/wp-wfp-acme-media/objects?per_page=1000',
    'DELETE /accounts/ACCT/r2/buckets/wp-wfp-acme-media',
    'DELETE /accounts/ACCT/storage/kv/namespaces/MAP/values/acme.example',
  ];
  ok('undoStore: the same API calls as before', threw === null && calls.join('\n') === want.join('\n'));
}

console.log(fails + ' failing');
process.exit(fails ? 1 : 0);
