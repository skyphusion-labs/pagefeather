// The release bundle manifest (issue #405): make it, and check a bundle against it.
//
// Pure Web Crypto (crypto.subtle) and no Node import, so the SAME check can run in
// the one-click admin Worker (#401) when it downloads a bundle into its own R2
// bucket. A bundle is the flat module set that the pinned Wrangler writes with
// `deploy --dry-run --outdir`: index.js plus hash-named .wasm and .zip modules.
// That is the shape deploy/provision loadModules (cli.mjs) and loadBundle
// (server-config.mjs) read.

export const MANIFEST_SCHEMA = 1;

// The module file names the provisioning loaders accept. A name outside this set
// would be DROPPED by the loader without an error, and the site would deploy with
// a missing module, so the manifest refuses it here instead.
export const MODULE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(m?js|wasm|zip|bin|dat|data)$/;

// The upload type a loader gives each module (the same rule as server-config.mjs
// moduleType), recorded so a reader does not have to guess.
export function moduleType(name) {
  if (name.endsWith('.js') || name.endsWith('.mjs')) return 'application/javascript+module';
  if (name.endsWith('.wasm')) return 'application/wasm';
  return 'application/octet-stream';
}

export async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

const META_KEYS = ['version', 'gitSha', 'buildId', 'wrangler', 'wordpress', 'woocommerce', 'compatibilityDate', 'mainModule'];

// files: [{ name, bytes: Uint8Array }]. meta: the META_KEYS, each a non-empty string.
// Returns the manifest object. Throws on a bad name, a duplicate, a missing main
// module, an empty file or a missing meta key, so a broken bundle is never described.
export async function buildManifest(files, meta) {
  for (const k of META_KEYS) {
    if (typeof meta[k] !== 'string' || !meta[k]) throw new Error(`manifest: meta.${k} is missing`);
  }
  const seen = new Set();
  const modules = [];
  for (const f of files) {
    if (!MODULE_NAME_RE.test(f.name)) throw new Error(`manifest: ${JSON.stringify(f.name)} is not a module name the provisioning loader reads`);
    if (seen.has(f.name)) throw new Error(`manifest: duplicate module ${f.name}`);
    seen.add(f.name);
    if (!f.bytes || !f.bytes.byteLength) throw new Error(`manifest: module ${f.name} is empty`);
    modules.push({ name: f.name, size: f.bytes.byteLength, sha256: await sha256Hex(f.bytes), type: moduleType(f.name) });
  }
  if (!seen.has(meta.mainModule)) throw new Error(`manifest: the main module ${meta.mainModule} is not in the bundle`);
  modules.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out = { schema: MANIFEST_SCHEMA };
  for (const k of META_KEYS) out[k] = meta[k];
  out.modules = modules;
  return out;
}

// Check a downloaded bundle against its manifest. files: [{ name, bytes }].
// Returns { ok, errors }. Every difference is an error: a module missing, an extra
// file, a size or a hash that differs, a bad schema. ok is true only with no error.
export async function verifyBundle(files, manifest) {
  const errors = [];
  if (!manifest || manifest.schema !== MANIFEST_SCHEMA || !Array.isArray(manifest.modules)) {
    return { ok: false, errors: ['manifest: unknown schema or no modules list'] };
  }
  if (!manifest.modules.length) errors.push('manifest: the modules list is empty');
  const want = new Map(manifest.modules.map((m) => [m.name, m]));
  const got = new Map();
  for (const f of files) {
    if (got.has(f.name)) errors.push(`duplicate file ${f.name}`);
    got.set(f.name, f.bytes);
  }
  for (const [name, m] of want) {
    const bytes = got.get(name);
    if (!bytes) { errors.push(`missing ${name}`); continue; }
    if (bytes.byteLength !== m.size) errors.push(`${name}: size ${bytes.byteLength}, manifest says ${m.size}`);
    const h = await sha256Hex(bytes);
    if (h !== m.sha256) errors.push(`${name}: sha256 ${h}, manifest says ${m.sha256}`);
  }
  for (const name of got.keys()) if (!want.has(name)) errors.push(`extra file ${name} is not in the manifest`);
  if (!want.has(manifest.mainModule)) errors.push(`manifest: the main module ${manifest.mainModule} is not listed`);
  return { ok: errors.length === 0, errors };
}
