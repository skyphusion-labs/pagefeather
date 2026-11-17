// #782: removeNamespaceSite (provision.mjs), one removal for a core-path site, with a stand-in Cloudflare API.
// The lead's ruling (2026-11-17): traffic first (the custom hostname, then the proxied DNS record), then the script
// and its resources, the registry entry LAST so a retry finds what is left; a dry run unless deleteData, and it
// says that deleting the script deletes the site's database.
// Run: node deploy/provision/tests/remove-site-test.mjs
import { removeNamespaceSite } from '../provision.mjs';
import { parseArgs, removeCommand } from '../cli.mjs';

let fails = 0;
function ok(label, cond) { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) fails++; }
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
const okJ = (result) => res(200, { success: true, errors: [], result });

// A stand-in account. `have` names what exists; `fail` is a "METHOD /path" prefix that answers 500.
function account({ have = {}, fail = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const p = url.split('/client/v4')[1]; const m = init.method; const c = `${m} ${p}`;
    calls.push(c);
    if (fail && c.startsWith(fail)) return res(500, { success: false, errors: [{ code: 10000, message: 'stand-in failure' }] });
    if (m === 'GET' && /\/dns_records\?/.test(p)) return okJ(have.dns ? [{ id: 'DNS1' }] : []);
    if (m === 'GET' && /\/storage\/kv\/namespaces\?/.test(p)) return okJ(have.oc ? [{ id: 'OC1', title: 'wp-wfp-acme-oc' }, { id: 'OTHER', title: 'wp-wfp-other-oc' }] : [{ id: 'OTHER', title: 'wp-wfp-other-oc' }]);
    if (m === 'GET' && /\/queues\?/.test(p)) return okJ(have.queues ? [{ queue_id: 'Q1', queue_name: 'wp-wfp-acme-email' }, { queue_id: 'Q2', queue_name: 'wp-wfp-acme-email-dlq' }] : []);
    if (m === 'GET' && /\/r2\/buckets\/[^/]+\/objects/.test(p)) return have.bucket ? okJ({ objects: [] }) : res(404, { success: false, errors: [{ code: 10006, message: 'no bucket' }] });
    if (m === 'DELETE') return have.none ? res(404, { success: false, errors: [] }) : okJ({});
    return okJ({});
  };
  return { calls, ctx: { acct: 'ACCT', token: 'tok', fetchImpl } };
}
const ALL = { dns: true, oc: true, queues: true, bucket: true };
const base = (over = {}) => ({ ns: 'NS', kvId: 'MAP', hostname: 'acme.skyphusionwp.dev', name: 'acme', saasZoneId: 'ZONE',
  entry: { script: 'site-acme', kind: 'wp', customHostnameId: 'CH1' }, ...over });
const at = (calls, s) => calls.findIndex((c) => c.startsWith(s));

// 1. The default is a dry run: no API call at all, and the plan says the database goes with the script.
{
  const { calls, ctx } = account({ have: ALL });
  const r = await removeNamespaceSite(ctx, base());
  ok('dry run by default: no API call', calls.length === 0);
  ok('dry run: reported as a dry run', r.dryRun === true);
  ok('dry run: the plan names every part, in order', JSON.stringify(r.plan.map((x) => x.part)) === JSON.stringify(
    ['custom hostname', 'DNS record', 'site code and database', 'object cache', 'email queues', 'search index', 'media bucket', 'site entry']));
  ok('dry run: it says deleting the script deletes the database', /database/.test(r.dataLoss || '') && /script|code/.test(r.dataLoss || ''));
}
// 2. With deleteData: every part, traffic first, the entry last, never another site.
{
  const { calls, ctx } = account({ have: ALL });
  const r = await removeNamespaceSite(ctx, base({ deleteData: true }));
  const i = {
    ch: at(calls, 'DELETE /zones/ZONE/custom_hostnames/CH1'), dns: at(calls, 'DELETE /zones/ZONE/dns_records/DNS1'),
    script: at(calls, 'DELETE /accounts/ACCT/workers/dispatch/namespaces/NS/scripts/site-acme'),
    oc: at(calls, 'DELETE /accounts/ACCT/storage/kv/namespaces/OC1'), q1: at(calls, 'DELETE /accounts/ACCT/queues/Q1'),
    q2: at(calls, 'DELETE /accounts/ACCT/queues/Q2'), vec: at(calls, 'DELETE /accounts/ACCT/vectorize/v2/indexes/wp-wfp-acme-search'),
    bucket: at(calls, 'DELETE /accounts/ACCT/r2/buckets/wp-wfp-acme-media'),
    entry: at(calls, 'DELETE /accounts/ACCT/storage/kv/namespaces/MAP/values/acme.skyphusionwp.dev'),
  };
  ok('delete: every part is deleted', Object.values(i).every((n) => n >= 0));
  ok('delete: the custom hostname, then DNS, before the script', i.ch < i.dns && i.dns < i.script);
  ok('delete: the resources after the script', i.script < i.oc && i.oc < i.q1 && i.q2 < i.vec && i.vec < i.bucket);
  ok('delete: the registry entry LAST', Object.entries(i).every(([k, n]) => k === 'entry' || n < i.entry));
  ok('delete: never another site\'s namespace', !calls.some((c) => c.endsWith('/storage/kv/namespaces/OTHER')));
  ok('delete: reported not a dry run, each part done', r.dryRun === false && r.done.length === 8);
}
// 3. No custom hostname recorded, no SaaS zone: those steps are skipped, the rest happen.
{
  const { calls, ctx } = account({ have: ALL });
  await removeNamespaceSite(ctx, base({ deleteData: true, saasZoneId: undefined, entry: { script: 'site-acme' } }));
  ok('no zone: no custom-hostname or DNS call', !calls.some((c) => /custom_hostnames|dns_records/.test(c)));
  ok('no zone: the script is still deleted', at(calls, 'DELETE /accounts/ACCT/workers/dispatch/namespaces/NS/scripts/site-acme') >= 0);
}
// 4. Nothing left (a rerun after a full remove): every step is done, nothing throws.
{
  const { ctx } = account({ have: { none: true } });
  let threw = null, r = null;
  try { r = await removeNamespaceSite(ctx, base({ deleteData: true })); } catch (e) { threw = e; }
  ok('rerun on an empty site: no throw', threw === null);
  ok('rerun on an empty site: every part reported', r && r.done.length === 8);
}
// 5. A failure part way stops the run, and the entry stays for the retry.
{
  const { calls, ctx } = account({ have: ALL, fail: 'DELETE /accounts/ACCT/workers/dispatch/namespaces/NS/scripts/site-acme' });
  let threw = null;
  try { await removeNamespaceSite(ctx, base({ deleteData: true })); } catch (e) { threw = e; }
  ok('a failed script delete throws', threw !== null);
  ok('after the failure: the entry is NOT deleted', at(calls, 'DELETE /accounts/ACCT/storage/kv/namespaces/MAP/values/') < 0);
  ok('after the failure: the bucket is not touched', at(calls, 'DELETE /accounts/ACCT/r2/buckets/') < 0);
  const again = account({ have: ALL });
  const r = await removeNamespaceSite(again.ctx, base({ deleteData: true }));
  ok('the retry completes', r.done.length === 8 && at(again.calls, 'DELETE /accounts/ACCT/storage/kv/namespaces/MAP/values/') >= 0);
}
// 5b. keepGoing (a rollback, the one-click undo): every step is tried, a failure is reported, not thrown.
{
  const { calls, ctx } = account({ have: ALL, fail: 'DELETE /accounts/ACCT/workers/dispatch/namespaces/NS/scripts/site-acme' });
  let threw = null, r = null;
  try { r = await removeNamespaceSite(ctx, base({ deleteData: true, keepGoing: true })); } catch (e) { threw = e; }
  ok('keepGoing: no throw', threw === null);
  ok('keepGoing: the failed part is reported with its error', r && r.left.length === 1 && r.left[0].part === 'site code and database' && /stand-in failure/.test(r.left[0].error));
  ok('keepGoing: the steps after it still run', at(calls, 'DELETE /accounts/ACCT/r2/buckets/wp-wfp-acme-media') >= 0);
}
// 5c. Without keepGoing, left is empty on success.
{
  const { ctx } = account({ have: ALL });
  const r = await removeNamespaceSite(ctx, base({ deleteData: true }));
  ok('success: nothing left', Array.isArray(r.left) && r.left.length === 0);
}
// 6. withEntry false (a half-made site with no entry): no registry delete, no entry in the plan.
{
  const { calls, ctx } = account({ have: ALL });
  const r = await removeNamespaceSite(ctx, base({ deleteData: true, withEntry: false, entry: null }));
  ok('withEntry false: no registry delete', at(calls, 'DELETE /accounts/ACCT/storage/kv/namespaces/MAP/values/') < 0);
  ok('withEntry false: the script is found by its derived name', at(calls, 'DELETE /accounts/ACCT/workers/dispatch/namespaces/NS/scripts/site-acme') >= 0);
  ok('withEntry false: no site entry in the plan', !r.plan.some((x) => x.part === 'site entry'));
}
// 7. A bad name is refused before any call.
{
  const { calls, ctx } = account({ have: ALL });
  let threw = null;
  try { await removeNamespaceSite(ctx, base({ deleteData: true, name: '../x' })); } catch (e) { threw = e; }
  ok('a bad name: refused, no call', threw !== null && calls.length === 0);
}
// ---- the CLI: site remove <name> [--delete-data] [--no-entry] ----
const throws = (f) => { try { f(); return false; } catch { return true; } };
ok('cli: remove <name> parses, a dry run by default', (() => { const a = parseArgs(['remove', 'acme']); return a.cmd === 'remove' && a.name === 'acme' && !a.deleteData && !a.noEntry; })());
ok('cli: --delete-data and --no-entry parse', (() => { const a = parseArgs(['remove', 'acme', '--delete-data', '--no-entry']); return a.deleteData === true && a.noEntry === true; })());
ok('cli: remove needs a name', throws(() => parseArgs(['remove'])));
ok('cli: remove refuses a bad name', throws(() => parseArgs(['remove', 'Bad_Name'])));
ok('cli: remove refuses an unknown flag', throws(() => parseArgs(['remove', 'acme', '--force'])));
// A stateful stand-in: the entry and the script exist until deleted. sticky makes the entry DELETE a no-op.
function live({ entry = true, sticky = false } = {}) {
  const st = { entry, script: true }; const calls = [];
  const fetchImpl = async (url, init) => {
    const p = url.split('/client/v4')[1]; const m = init.method; calls.push(`${m} ${p}`);
    if (/\/storage\/kv\/namespaces\/MAP\/values\//.test(p)) {
      if (m === 'GET') return st.entry ? { ok: true, status: 200, text: async () => JSON.stringify({ script: 'site-acme', kind: 'wp' }) } : res(404, { success: false, errors: [{ code: 10009, message: 'key not found' }] });
      if (m === 'DELETE') { if (!sticky) st.entry = false; return okJ({}); }
    }
    if (/\/dispatch\/namespaces\/NS\/scripts\/site-acme$/.test(p)) {
      if (m === 'GET') return st.script ? okJ({ script: { id: 'site-acme' } }) : res(404, { success: false, errors: [{ code: 10007, message: 'not found' }] });
      if (m === 'DELETE') { st.script = false; return okJ({}); }
    }
    if (m === 'GET' && /\?/.test(p)) return okJ([]);
    if (m === 'GET' && /\/objects/.test(p)) return res(404, { success: false, errors: [] });
    if (m === 'DELETE') return res(404, { success: false, errors: [] });
    return okJ({});
  };
  return { st, calls, ctx: { acct: 'ACCT', token: 'tok', fetchImpl } };
}
const ENV = { WFP_SAAS_ZONE_ID: 'ZONE', WFP_KV_ID: 'MAP', WFP_NAMESPACE: 'NS', WP_HOSTNAME: 'acme.skyphusionwp.dev' };
{
  const L = live(); const lines = [];
  const r = await removeCommand(L.ctx, parseArgs(['remove', 'acme']), ENV, { out: (x) => lines.push(String(x)) });
  const txt = lines.join('\n');
  ok('cli dry run: only reads, never deletes', !L.calls.some((c) => c.startsWith('DELETE')));
  ok('cli dry run: prints the plan, the data-loss warning and how to go on', /site code and database/.test(txt) && /database/.test(txt) && /--delete-data/.test(txt) && r.dryRun === true);
}
{
  const L = live({ entry: false }); let threw = null;
  try { await removeCommand(L.ctx, parseArgs(['remove', 'acme', '--delete-data']), ENV, { out: () => {} }); } catch (e) { threw = e; }
  ok('cli: no registry entry is refused, naming --no-entry', threw && /--no-entry/.test(threw.message));
  ok('cli: that refusal deletes nothing', !L.calls.some((c) => c.startsWith('DELETE')));
}
{
  const L = live(); const lines = [];
  const r = await removeCommand(L.ctx, parseArgs(['remove', 'acme', '--delete-data']), ENV, { out: (x) => lines.push(String(x)) });
  ok('cli delete: the entry and the script are gone, read back', L.st.entry === false && L.st.script === false && r.checked === true);
  ok('cli delete: the read-back is GETs after the deletes', L.calls.lastIndexOf('GET /accounts/ACCT/storage/kv/namespaces/MAP/values/acme.skyphusionwp.dev') > L.calls.findIndex((c) => c.startsWith('DELETE /accounts/ACCT/storage/kv/namespaces/MAP/values/')));
}
{
  const L = live({ sticky: true }); let threw = null;
  try { await removeCommand(L.ctx, parseArgs(['remove', 'acme', '--delete-data']), ENV, { out: () => {} }); } catch (e) { threw = e; }
  ok('cli delete: an entry still present after its delete is a failure, not a success', threw && /still/.test(threw.message));
}
{
  const L = live({ entry: false });
  const r = await removeCommand(L.ctx, parseArgs(['remove', 'acme', '--delete-data', '--no-entry']), ENV, { out: () => {} });
  ok('cli --no-entry: a half-made site is removed by derived names', L.st.script === false && r.dryRun === false);
}
console.log(fails + ' failing');
process.exit(fails ? 1 : 0);
