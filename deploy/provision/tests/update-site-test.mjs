// #782: updateNamespaceSite (provision.mjs) and `site update <name>` (cli.mjs), with a stand-in Cloudflare API.
// Built on the update probe (the lead ran it, 2026-11-17): a re-upload with NO migrations keeps the Durable
// Object's data, and re-sending the applied tag is refused (412, 10079). So update re-uploads the new code with the
// LIVE non-secret bindings verbatim, keep_bindings for the secret types, and no migrations; then it reads the
// settings back and fails if any binding is gone.
// Run: node deploy/provision/tests/update-site-test.mjs
import { updateNamespaceSite } from '../provision.mjs';
import { parseArgs, updateCommand } from '../cli.mjs';

let fails = 0;
function ok(label, cond) { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) fails++; }
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
const okJ = (result) => res(200, { success: true, errors: [], result });
const LIVE = [
  { type: 'durable_object_namespace', name: 'PHP_RUNTIME', class_name: 'PhpRuntime' },
  { type: 'kv_namespace', name: 'OC_KV', namespace_id: 'OC1' },
  { type: 'r2_bucket', name: 'MEDIA', bucket_name: 'wp-wfp-acme-media' },
  { type: 'plain_text', name: 'SITE_ORIGIN', text: 'https://acme.skyphusionwp.dev' },
  { type: 'secret_text', name: 'SPIKE_TOKEN' },
  { type: 'secret_text', name: 'AUTH_SALT' },
];
// A stand-in: settings answer `before` until the first PUT, then `after` (default: the same as before).
function account({ before = LIVE, after = null, live = true, entry = true } = {}) {
  const calls = []; const puts = []; let put = false;
  const fetchImpl = async (url, init) => {
    const p = url.split('/client/v4')[1]; const m = init.method; calls.push(`${m} ${p}`);
    if (/\/dispatch\/namespaces\/NS\/scripts\/site-acme\/settings$/.test(p) && m === 'GET') {
      if (!live) return res(404, { success: false, errors: [{ code: 10007, message: 'not found' }] });
      return okJ({ bindings: put ? (after || before) : before });
    }
    if (/\/dispatch\/namespaces\/NS\/scripts\/site-acme$/.test(p) && m === 'PUT') {
      put = true;
      const meta = JSON.parse(await init.body.get('metadata').text());
      const parts = [...init.body.entries()].filter(([k]) => k !== 'metadata').map(([k, v]) => ({ name: k, filename: v.name }));
      puts.push({ meta, parts }); return okJ({ id: 'site-acme' });
    }
    if (/\/storage\/kv\/namespaces\/MAP\/values\//.test(p) && m === 'GET') {
      return entry ? { ok: true, status: 200, text: async () => JSON.stringify({ script: 'site-acme', kind: 'wp' }) } : res(404, { success: false, errors: [] });
    }
    return okJ({});
  };
  return { calls, puts, ctx: { acct: 'ACCT', token: 'tok', fetchImpl } };
}
const MODS = [{ name: 'index.js', content: 'export default {}', type: 'application/javascript+module' }, { name: 'php.wasm', content: new Uint8Array([0, 97, 115, 109]), type: 'application/wasm' }];
const base = (over = {}) => ({ ns: 'NS', name: 'acme', mainModule: 'index.js', modules: MODS, compatibilityDate: '2026-07-01', compatibilityFlags: ['nodejs_compat'], ...over });

// 1. The upload: the live non-secret bindings verbatim, keep_bindings for secrets, no migrations, the new modules.
{
  const A = account();
  const r = await updateNamespaceSite(A.ctx, base());
  const u = A.puts[0];
  ok('update: exactly one upload', A.puts.length === 1);
  ok('update: the live non-secret bindings, verbatim', u && JSON.stringify(u.meta.bindings) === JSON.stringify(LIVE.filter((b) => b.type !== 'secret_text')));
  ok('update: no secret is sent (none can be: none is stored)', u && !u.meta.bindings.some((b) => b.type === 'secret_text'));
  ok('update: keep_bindings keeps the secret type', u && Array.isArray(u.meta.keep_bindings) && u.meta.keep_bindings.includes('secret_text'));
  ok('update: NO migrations (the applied tag would be refused, 10079)', u && !('migrations' in u.meta));
  ok('update: the new main module and every module part, named', u && u.meta.main_module === 'index.js' && u.parts.map((x) => `${x.name}:${x.filename}`).join() === 'index.js:index.js,php.wasm:php.wasm');
  ok('update: the settings are read back after the upload', A.calls.filter((c) => c.endsWith('/settings')).length === 2);
  ok('update: reports what it kept', r && r.kept.length === 4 && r.secrets.join() === 'SPIKE_TOKEN,AUTH_SALT');
}
// 2. No live script: refused, nothing uploaded.
{
  const A = account({ live: false }); let threw = null;
  try { await updateNamespaceSite(A.ctx, base()); } catch (e) { threw = e; }
  ok('no live script: refused', threw && /no live script|not found/i.test(threw.message));
  ok('no live script: nothing uploaded', A.puts.length === 0);
}
// 3. A binding gone after the upload (the platform dropped a secret): a failure naming it.
{
  const A = account({ after: LIVE.filter((b) => b.name !== 'SPIKE_TOKEN') }); let threw = null;
  try { await updateNamespaceSite(A.ctx, base()); } catch (e) { threw = e; }
  ok('a binding gone after the upload: it fails', threw !== null);
  ok('a binding gone after the upload: it names the binding', threw && /SPIKE_TOKEN/.test(threw.message));
}
// 4. A bad name: refused before any call.
{
  const A = account(); let threw = null;
  try { await updateNamespaceSite(A.ctx, base({ name: '../x' })); } catch (e) { threw = e; }
  ok('a bad name: refused, no call', threw !== null && A.calls.length === 0);
}
// ---- the CLI ----
const throws = (f) => { try { f(); return false; } catch { return true; } };
ok('cli: update <name> parses', (() => { const a = parseArgs(['update', 'acme']); return a.cmd === 'update' && a.name === 'acme'; })());
ok('cli: update needs a name', throws(() => parseArgs(['update'])));
ok('cli: update refuses a bad name', throws(() => parseArgs(['update', 'Bad_Name'])));
ok('cli: update refuses an unknown flag', throws(() => parseArgs(['update', 'acme', '--delete-data'])));
const ENV = { WFP_SAAS_ZONE_ID: 'ZONE', WFP_KV_ID: 'MAP', WFP_NAMESPACE: 'NS', WP_HOSTNAME: 'acme.skyphusionwp.dev' };
{
  const A = account({ entry: false }); let threw = null;
  try { await updateCommand(A.ctx, parseArgs(['update', 'acme']), ENV, { out: () => {}, modules: MODS }); } catch (e) { threw = e; }
  ok('cli: no registry entry is refused', threw && /no registry entry/.test(threw.message));
  ok('cli: that refusal uploads nothing', A.puts.length === 0);
}
{
  const A = account(); const lines = [];
  const r = await updateCommand(A.ctx, parseArgs(['update', 'acme']), ENV, { out: (x) => lines.push(String(x)), modules: MODS });
  ok('cli: update uploads once and prints what it kept', A.puts.length === 1 && r.kept.length === 4 && /kept/.test(lines.join('\n')));
}
console.log(fails + ' failing');
process.exit(fails ? 1 : 0);
