// Tests for deploy/release (issue #405). Offline: no build, no network.
//   node deploy/release/tests/bundle-manifest-test.mjs
// Each refusal case has a passing control next to it, so a check that never fires
// cannot hide behind a green run.
import { readFile, mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildManifest, verifyBundle, MODULE_NAME_RE, moduleType } from '../bundle-manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
let failed = 0, run = 0;
async function ok(name, fn) {
  run++;
  try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
}
function assert(c, msg) { if (!c) throw new Error(msg); }
async function throwsWith(fn, re) {
  try { await fn(); } catch (e) { assert(re.test(e.message), `threw "${e.message}", wanted ${re}`); return; }
  throw new Error(`did not throw (wanted ${re})`);
}

const enc = (s) => new TextEncoder().encode(s);
const META = { version: '0.1.0', gitSha: 'a'.repeat(40), buildId: 'abc-wooprimed', wrangler: '4.107.0', wordpress: '7.1.4', woocommerce: '11.2.1', compatibilityDate: '2026-07-01', mainModule: 'index.js' };
const files = () => [
  { name: 'index.js', bytes: enc('import w from "./c6-php.wasm"; export default {};') },
  { name: 'c6-php.wasm', bytes: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]) },
  { name: '8a-site.zip', bytes: new Uint8Array([80, 75, 5, 6, 0, 0]) },
];

await ok('control: a manifest built from a bundle verifies against that bundle', async () => {
  const m = await buildManifest(files(), META);
  assert(m.schema === 1 && m.modules.length === 3, 'shape');
  assert(m.modules.map((x) => x.name).join(',') === '8a-site.zip,c6-php.wasm,index.js', 'sorted by name');
  assert(m.modules.find((x) => x.name === 'index.js').type === 'application/javascript+module', 'js type');
  assert(m.modules.find((x) => x.name === 'c6-php.wasm').type === 'application/wasm', 'wasm type');
  assert(m.modules.find((x) => x.name === '8a-site.zip').type === 'application/octet-stream', 'zip type');
  const r = await verifyBundle(files(), m);
  assert(r.ok && r.errors.length === 0, r.errors.join('; '));
});

await ok('a changed byte (same size) fails on the sha256', async () => {
  const m = await buildManifest(files(), META);
  const f = files(); f[1].bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 1]);
  const r = await verifyBundle(f, m);
  assert(!r.ok && r.errors.some((e) => /c6-php\.wasm: sha256/.test(e)), r.errors.join('; '));
});

await ok('a size change fails on the size', async () => {
  const m = await buildManifest(files(), META);
  const f = files(); f[0].bytes = enc('export default {};');
  const r = await verifyBundle(f, m);
  assert(!r.ok && r.errors.some((e) => /index\.js: size/.test(e)), r.errors.join('; '));
});

await ok('a missing module fails', async () => {
  const m = await buildManifest(files(), META);
  const r = await verifyBundle(files().slice(0, 2), m);
  assert(!r.ok && r.errors.includes('missing 8a-site.zip'), r.errors.join('; '));
});

await ok('an extra file fails', async () => {
  const m = await buildManifest(files(), META);
  const r = await verifyBundle([...files(), { name: 'evil.js', bytes: enc('x') }], m);
  assert(!r.ok && r.errors.some((e) => /extra file evil\.js/.test(e)), r.errors.join('; '));
});

await ok('an unknown schema or an empty modules list fails', async () => {
  const m = await buildManifest(files(), META);
  assert(!(await verifyBundle(files(), { ...m, schema: 2 })).ok, 'schema 2 passed');
  assert(!(await verifyBundle([], { ...m, modules: [] })).ok, 'empty list passed');
  assert(!(await verifyBundle(files(), null)).ok, 'null manifest passed');
});

await ok('buildManifest refuses names the loader would drop or that are not flat', async () => {
  for (const bad of ['README.md', 'index.js.map', 'vendor/php.wasm', '../x.js', '.hidden.js', 'a b.js']) {
    await throwsWith(() => buildManifest([...files(), { name: bad, bytes: enc('x') }], META), /not a module name/);
  }
});

await ok('buildManifest refuses a missing main module, an empty file, a duplicate, a missing meta key', async () => {
  await throwsWith(() => buildManifest(files().slice(1), META), /main module index\.js is not in the bundle/);
  await throwsWith(() => buildManifest([...files(), { name: 'e.zip', bytes: new Uint8Array() }], META), /e\.zip is empty/);
  await throwsWith(() => buildManifest([...files(), files()[0]], META), /duplicate module index\.js/);
  const { buildId, ...noBuild } = META;
  await throwsWith(() => buildManifest(files(), noBuild), /meta\.buildId is missing/);
});

await ok('drift guard: the name rule and types match both provisioning loaders', async () => {
  // cli.mjs loadModules and server-config.mjs loadBundle each filter by this extension
  // list. If one of them changes, a bundle this manifest accepts could lose a module.
  const ext = String.raw`\.(m?js|wasm|zip|bin|dat|data)$/`;
  for (const f of ['deploy/provision/cli.mjs', 'deploy/provision/server-config.mjs']) {
    const src = await readFile(join(ROOT, f), 'utf8');
    assert(src.includes(ext), `${f} no longer filters modules by ${ext}`);
  }
  assert(String(MODULE_NAME_RE).endsWith(ext), `MODULE_NAME_RE ${MODULE_NAME_RE} does not end with ${ext}`);
  const sc = await readFile(join(ROOT, 'deploy/provision/server-config.mjs'), 'utf8');
  assert(sc.includes(`if (f.endsWith('.wasm')) return 'application/wasm';`), 'server-config moduleType changed');
  assert(moduleType('x.mjs') === 'application/javascript+module' && moduleType('x.bin') === 'application/octet-stream', 'moduleType');
});

await ok('the CLI: make, verify (exit 0), then a tampered module (exit 1)', async () => {
  const d = await mkdtemp(join(tmpdir(), 'bundle-cli-'));
  try {
    const mods = join(d, 'modules'); await mkdir(mods);
    for (const f of files()) await writeFile(join(mods, f.name), f.bytes);
    const cli = join(ROOT, 'deploy/release/bundle-cli.mjs');
    const meta = Object.entries(META).map(([k, v]) => `${k}=${v}`);
    let r = spawnSync(process.execPath, [cli, 'make', mods, join(d, 'manifest.json'), ...meta], { encoding: 'utf8' });
    assert(r.status === 0, `make exit ${r.status}: ${r.stderr}`);
    r = spawnSync(process.execPath, [cli, 'verify', mods, join(d, 'manifest.json')], { encoding: 'utf8' });
    assert(r.status === 0, `verify of a good bundle exit ${r.status}: ${r.stderr}`);
    await writeFile(join(mods, 'index.js'), 'export default { tampered: 1 };');
    r = spawnSync(process.execPath, [cli, 'verify', mods, join(d, 'manifest.json')], { encoding: 'utf8' });
    assert(r.status === 1 && /index\.js/.test(r.stderr), `verify of a tampered bundle exit ${r.status}: ${r.stderr}`);
  } finally { await rm(d, { recursive: true, force: true }); }
});

await ok('the CLI refuses a directory and a symbolic link inside the bundle dir', async () => {
  const { symlink } = await import('node:fs/promises');
  const cli = join(ROOT, 'deploy/release/bundle-cli.mjs');
  const meta = Object.entries(META).map(([k, v]) => `${k}=${v}`);
  for (const kind of ['dir', 'link']) {
    const d = await mkdtemp(join(tmpdir(), 'bundle-cli-'));
    try {
      const mods = join(d, 'modules'); await mkdir(mods);
      for (const f of files()) await writeFile(join(mods, f.name), f.bytes);
      if (kind === 'dir') await mkdir(join(mods, 'sub.js'));
      else { await writeFile(join(d, 'outside.js'), 'x'); await symlink(join(d, 'outside.js'), join(mods, 'link.js')); }
      const r = spawnSync(process.execPath, [cli, 'make', mods, join(d, 'manifest.json'), ...meta], { encoding: 'utf8' });
      assert(r.status === 1, `${kind}: make exit ${r.status}, wanted 1: ${r.stderr}`);
    } finally { await rm(d, { recursive: true, force: true }); }
  }
});

console.log(`cases_run=${run} failed=${failed}`);
process.exit(failed ? 1 : 0);
