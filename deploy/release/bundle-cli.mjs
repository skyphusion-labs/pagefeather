// The command-line side of bundle-manifest.mjs (issue #405).
//   node bundle-cli.mjs make <modules dir> <manifest.json> key=value...
//   node bundle-cli.mjs verify <modules dir> <manifest.json>
// make: reads every file in the dir (the dry-run outdir with README.md and *.map
// already removed), writes the manifest. verify: exit 0 only when the dir matches.
import { readdir, readFile, writeFile, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { buildManifest, verifyBundle } from './bundle-manifest.mjs';

async function readDir(dir) {
  const files = [];
  for (const name of (await readdir(dir)).sort()) {
    const p = join(dir, name);
    // One open handle for the check and the read (no stat-then-read race), and no
    // symbolic link followed: a bundle is flat regular files only.
    const fh = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await fh.stat()).isFile()) throw new Error(`${p} is not a regular file; a bundle is flat`);
      files.push({ name, bytes: new Uint8Array(await fh.readFile()) });
    } finally { await fh.close(); }
  }
  return files;
}

const [cmd, dir, manifestPath, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'make' && dir && manifestPath) {
    const meta = {};
    for (const kv of rest) {
      const i = kv.indexOf('=');
      if (i < 1) throw new Error(`bad meta ${JSON.stringify(kv)} (want key=value)`);
      meta[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const m = await buildManifest(await readDir(dir), meta);
    await writeFile(manifestPath, JSON.stringify(m, null, 2) + '\n');
    const total = m.modules.reduce((s, x) => s + x.size, 0);
    console.log(`manifest: ${m.modules.length} modules, ${(total / 1048576).toFixed(2)} MiB, version ${m.version}, build ${m.buildId}`);
  } else if (cmd === 'verify' && dir && manifestPath) {
    const r = await verifyBundle(await readDir(dir), JSON.parse(await readFile(manifestPath, 'utf8')));
    if (!r.ok) { for (const e of r.errors) console.error(`verify: ${e}`); process.exit(1); }
    console.log('verify: the bundle matches its manifest');
  } else {
    console.error('usage: bundle-cli.mjs make <dir> <manifest.json> key=value... | verify <dir> <manifest.json>');
    process.exit(2);
  }
} catch (e) {
  console.error(`bundle-cli: ${e.message}`);
  process.exit(1);
}
