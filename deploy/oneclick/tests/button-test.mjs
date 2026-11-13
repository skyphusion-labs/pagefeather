// Tests for the button packaging of the site manager (#416). Offline.
//   node deploy/oneclick/tests/button-test.mjs
// The button builds ONLY deploy/oneclick, so: the vendored copies equal their
// sources, no runtime file imports anything outside the directory, the Wrangler pin
// matches the repo pin, and the setup-page values are named and described.
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { namespaceFromToml, ensureNamespace } from '../scripts/ensure-namespace.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(HERE, '..');
const ROOT = resolve(DIR, '..', '..');
let failed = 0, run = 0;
async function ok(name, fn) {
  run++;
  try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
}
function assert(c, msg) { if (!c) throw new Error(msg); }
const same = (a, b) => Buffer.compare(a, b) === 0;

const pairs = execFileSync(join(DIR, 'sync-vendor.sh'), ['--list'], { encoding: 'utf8' }).trim().split('\n').map((l) => l.split(' '));

await ok('every vendored file is byte-identical to its source (run sync-vendor.sh after a change)', async () => {
  assert(pairs.length >= 9, `only ${pairs.length} pairs`);
  const drift = [];
  for (const [src, dst] of pairs) {
    if (!same(await readFile(join(ROOT, src)), await readFile(join(DIR, dst)))) drift.push(`${dst} differs from ${src}`);
  }
  assert(!drift.length, drift.join('; '));
});

await ok('control: the comparison sees a one-byte change', async () => {
  const a = await readFile(join(ROOT, pairs[0][0]));
  const b = Buffer.from(a); b[b.length - 1] ^= 1;
  assert(!same(a, b), 'a changed byte compared equal');
});

async function walk(d, out = []) {
  for (const n of await readdir(d)) {
    if (n === 'node_modules' || n === '.wrangler' || n === 'tests') continue;
    const p = join(d, n);
    if ((await stat(p)).isDirectory()) await walk(p, out);
    else if (/\.(mjs|js)$/.test(n)) out.push(p);
  }
  return out;
}
const IMPORT_RE = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

await ok('no runtime file imports a path outside deploy/oneclick, and every relative import exists', async () => {
  const files = await walk(DIR);
  assert(files.length >= 14, `only ${files.length} files scanned`);
  const bad = [];
  for (const f of files) {
    const src = await readFile(f, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (!spec.startsWith('.')) {
        if (!/^(node:|cloudflare:)/.test(spec)) bad.push(`${relative(DIR, f)}: package import ${spec}`);
        continue;
      }
      const target = resolve(dirname(f), spec);
      if (relative(DIR, target).startsWith('..')) { bad.push(`${relative(DIR, f)} imports ${spec}, outside the directory`); continue; }
      try { await stat(target); } catch { bad.push(`${relative(DIR, f)} imports ${spec}, which does not exist`); }
    }
  }
  assert(!bad.length, bad.join('; '));
});

await ok('control: the import scan finds an outside import', async () => {
  const hits = [..."import x from '../provision/cf.mjs';".matchAll(IMPORT_RE)].map((m) => m[1]);
  assert(hits[0] === '../provision/cf.mjs' && relative(DIR, resolve(DIR, hits[0])).startsWith('..'), 'not found');
});

await ok('the button installs the same Wrangler as the repo pin, locked', async () => {
  const pkg = JSON.parse(await readFile(join(DIR, 'package.json'), 'utf8'));
  const tools = JSON.parse(await readFile(join(ROOT, 'deploy/tools/package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(DIR, 'package-lock.json'), 'utf8'));
  const want = tools.devDependencies.wrangler;
  assert(/^\d+\.\d+\.\d+$/.test(want), `the repo pin ${want} is not exact`);
  assert(pkg.devDependencies.wrangler === want, `package.json wrangler ${pkg.devDependencies.wrangler}, repo pin ${want}`);
  assert(lock.packages['node_modules/wrangler'].version === want, 'the lockfile resolves another wrangler');
  assert(pkg.scripts.deploy === 'node scripts/ensure-namespace.mjs && wrangler deploy', `deploy script ${pkg.scripts.deploy}`);
});

await ok('the setup page values: .dev.vars.example names them, package.json describes them, wrangler.toml has no var of the same name', async () => {
  const names = (await readFile(join(DIR, '.dev.vars.example'), 'utf8')).split('\n').filter(Boolean).map((l) => l.split('=')[0]).sort();
  assert(names.join(',') === 'ADMIN_EMAIL,PAGEFEATHER_KEY', `names ${names}`);
  const pkg = JSON.parse(await readFile(join(DIR, 'package.json'), 'utf8'));
  for (const n of names) assert(pkg.cloudflare.bindings[n] && pkg.cloudflare.bindings[n].description.length > 20, `${n} has no description`);
  const toml = await readFile(join(DIR, 'wrangler.toml'), 'utf8');
  const vars = (toml.split('[vars]')[1] || '').split(/\n\[/)[0];
  for (const n of names) assert(!new RegExp(`^${n}\\s*=`, 'm').test(vars), `${n} is also a [vars] entry`);
  const desc = pkg.cloudflare.bindings.PAGEFEATHER_KEY.description;
  assert(desc.includes('dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys='), 'no account token template link');
  assert(!/[\u2013\u2014]/.test(JSON.stringify(pkg)), 'a dash character');
});

await ok('the namespace name comes from wrangler.toml', async () => {
  assert(namespaceFromToml(await readFile(join(DIR, 'wrangler.toml'), 'utf8')) === 'pagefeather', 'not pagefeather');
  let threw = false; try { namespaceFromToml('name = "x"\n'); } catch { threw = true; }
  assert(threw, 'a config with no namespace did not throw');
});

function api(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const p = new URL(url).pathname.replace('/client/v4', '');
    calls.push(`${init.method} ${p}`);
    const r = routes[`${init.method} ${p}`];
    if (!r) return new Response(JSON.stringify({ success: false, errors: [{ code: 0, message: 'no route' }] }), { status: 599 });
    return new Response(JSON.stringify(r.body || { success: true, result: r.result ?? null }), { status: r.status || 200 });
  };
  return { fetchImpl, calls };
}

await ok('ensure-namespace: an existing namespace is left alone', async () => {
  const a = api({ 'GET /accounts/A/workers/dispatch/namespaces/pagefeather': { result: { namespace_name: 'pagefeather' } } });
  const r = await ensureNamespace({ token: 't', account: 'A', name: 'pagefeather', fetchImpl: a.fetchImpl });
  assert(r.created === false && !a.calls.some((c) => c.startsWith('POST')), JSON.stringify(a.calls));
});

await ok('ensure-namespace: a missing namespace is made; the account is found when not given', async () => {
  const a = api({
    'GET /accounts': { result: [{ id: 'A' }] },
    'GET /accounts/A/workers/dispatch/namespaces/pagefeather': { status: 404, body: { success: false, errors: [{ code: 10121, message: 'not found' }] } },
    'POST /accounts/A/workers/dispatch/namespaces': { result: { namespace_name: 'pagefeather' } },
  });
  const r = await ensureNamespace({ token: 't', name: 'pagefeather', fetchImpl: a.fetchImpl });
  assert(r.created === true && a.calls.includes('POST /accounts/A/workers/dispatch/namespaces'), JSON.stringify(a.calls));
});

await ok('ensure-namespace: a refused read or make fails with the Workers for Platforms hint; two accounts fail', async () => {
  const a = api({ 'GET /accounts/A/workers/dispatch/namespaces/pagefeather': { status: 403, body: { success: false, errors: [{ code: 10000, message: 'not entitled' }] } } });
  let msg = '';
  try { await ensureNamespace({ token: 't', account: 'A', name: 'pagefeather', fetchImpl: a.fetchImpl }); } catch (e) { msg = e.message; }
  assert(/Workers for Platforms/.test(msg) && !a.calls.some((c) => c.startsWith('POST')), msg);
  const b = api({ 'GET /accounts': { result: [{ id: 'A' }, { id: 'B' }] } });
  msg = '';
  try { await ensureNamespace({ token: 't', name: 'pagefeather', fetchImpl: b.fetchImpl }); } catch (e) { msg = e.message; }
  assert(/CLOUDFLARE_ACCOUNT_ID/.test(msg), msg);
  msg = '';
  try { await ensureNamespace({ token: '', account: 'A', name: 'pagefeather', fetchImpl: b.fetchImpl }); } catch (e) { msg = e.message; }
  assert(/CLOUDFLARE_API_TOKEN/.test(msg), msg);
});

console.log(`cases_run=${run} failed=${failed}`);
process.exit(failed ? 1 : 0);
