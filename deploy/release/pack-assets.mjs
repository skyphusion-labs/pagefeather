// Package the remote packs as release assets (#1036). The packs themselves are what
// opcache-remote.py and site-remote.py write under build/public/_pf/<id>/ (deploy/lib/remote-packs.sh).
// This only copies them, with the index those scripts wrote, so the one-click admin can upload them.
// A null index and no _pf tree is the opt-out (OPCACHE_REMOTE=0): write nothing.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assetContentHash } from '../provision/cf.mjs';

const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parsePackIndex(text) {
  const s = String(text).trim();
  if (s === 'export default null;') return null;
  const m = s.match(/^export default (\{.*\});$/s);
  if (!m) throw new Error('not a pack index');
  return JSON.parse(m[1]);
}

async function readIndex(buildDir, name) {
  let text;
  try { text = await readFile(join(buildDir, name), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') throw new Error(`missing ${name}`); throw e; }
  try { return parsePackIndex(text); }
  catch (e) { throw new Error(`${name}: ${e.message}`); }
}

async function listPackFiles(buildDir) {
  const root = join(buildDir, 'public', '_pf');
  let ids;
  try { ids = await readdir(root); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const id of ids) {
    if (id === '.' || id === '..') continue;
    const dir = join(root, id);
    if (!(await stat(dir)).isDirectory()) continue;
    for (const name of await readdir(dir)) {
      const full = join(dir, name);
      if (!(await stat(full)).isFile()) continue;
      out.push({ id, name, full });
    }
  }
  return out;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Writes <prefix>remote-packs-index.json and one <prefix><asset> per pack into releaseDir.
// Returns { wrote, files, indexSha256 }. The caller stamps the module manifest.
export async function packagePacks({ buildDir, releaseDir, prefix = '' }) {
  const opcache = await readIndex(buildDir, 'opcache-remote-index.js');
  const site = await readIndex(buildDir, 'site-remote-index.js');
  const listed = await listPackFiles(buildDir);
  if (!opcache) {
    if (listed.length) throw new Error('opcache-remote-index.js is null but build/public/_pf holds packs');
    return { wrote: false };
  }
  const id = opcache.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(id)) throw new Error('opcache index id is not a path');
  const mine = listed.filter((f) => f.id === id);
  if (listed.length !== mine.length) throw new Error('build/public/_pf holds a pack whose directory is not the opcache index id');
  if (!mine.length) throw new Error('opcache-remote-index.js names packs but build/public/_pf is empty');
  if (site && site.id !== id) throw new Error('site-remote-index.js id does not match the opcache index');
  const files = [];
  for (const f of mine.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!ASSET_NAME.test(f.name)) throw new Error(`pack name ${JSON.stringify(f.name)} is not a release asset name`);
    const kind = /^(st-|site-)/.test(f.name) ? 'site' : 'opcache';
    if (kind === 'site' && !site) throw new Error('site-remote-index.js is null but a site pack is in build/public/_pf');
    const bytes = new Uint8Array(await readFile(f.full));
    files.push({
      asset: f.name,
      path: `/_pf/${id}/${f.name}`,
      size: bytes.byteLength,
      sha256: sha256(bytes),
      hash: await assetContentHash(bytes, f.name),
      kind,
      bytes,
    });
  }
  if (site && !files.some((f) => f.kind === 'site')) throw new Error('site-remote-index.js is set but build/public/_pf has no site pack');
  const index = {
    schema: 1,
    buildId: id,
    opcache,
    site: site || null,
    files: files.map(({ asset, path, size, sha256: sum, hash, kind }) => ({ asset, path, size, sha256: sum, hash, kind })),
  };
  const indexBytes = new TextEncoder().encode(JSON.stringify(index) + '\n');
  await mkdir(releaseDir, { recursive: true });
  await writeFile(join(releaseDir, prefix + 'remote-packs-index.json'), indexBytes);
  for (const f of files) await writeFile(join(releaseDir, prefix + f.asset), f.bytes);
  return { wrote: true, files: files.length, indexSha256: sha256(indexBytes) };
}
