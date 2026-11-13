// Get the WordPress files (#414): download a release's bundle (#405) into this
// Worker's own BUNDLES bucket, after checking it.
//
// Trust: the manifest's SHA-256 is pinned in this Worker's config
// (BUNDLE_MANIFEST_SHA256), which the owner deployed. The manifest pins every
// module's SHA-256 (verifyBundle). So a changed release asset is refused, and
// nothing is written to the bucket unless the whole bundle checks out. With no pin
// set, nothing is downloaded.
import { verifyBundle, sha256Hex } from '../release/bundle-manifest.mjs';
import { bundlePrefix } from './sites.mjs';

export const RELEASE_BASE_DEFAULT = 'https://github.com/skyphusion-labs/pagefeather/releases/download';

async function get(fetchImpl, url) {
  const res = await fetchImpl(url, { redirect: 'follow', headers: { 'user-agent': 'pagefeather-site-manager' } });
  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function installBundle(env, { fetchImpl = fetch } = {}) {
  const version = env.BUNDLE_VERSION;
  const pin = env.BUNDLE_MANIFEST_SHA256;
  if (typeof version !== 'string' || !/^v\d+\.\d+\.\d+$/.test(version)) throw new Error('BUNDLE_VERSION is not set to a release (vX.Y.Z)');
  if (typeof pin !== 'string' || !/^[0-9a-f]{64}$/.test(pin)) throw new Error('BUNDLE_MANIFEST_SHA256 is not set; the WordPress files are not available yet');
  if (!env.BUNDLES) throw new Error('the BUNDLES bucket is not bound');
  const base = `${env.RELEASE_BASE || RELEASE_BASE_DEFAULT}/${version}`;

  const manifestBytes = await get(fetchImpl, `${base}/manifest.json`);
  const got = await sha256Hex(manifestBytes);
  if (got !== pin) throw new Error(`manifest.json sha256 ${got} is not the pinned ${pin}; refusing it`);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  if (manifest.version !== version.slice(1)) throw new Error(`the manifest is for ${manifest.version}, not ${version}`);

  const files = [];
  for (const m of manifest.modules) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(m.name)) throw new Error(`bad module name ${JSON.stringify(m.name)}`);
    files.push({ name: m.name, bytes: await get(fetchImpl, `${base}/${m.name}`) });
  }
  const v = await verifyBundle(files, manifest);
  if (!v.ok) throw new Error(`the bundle does not match its manifest: ${v.errors.join('; ')}`);

  // Only now, with every module checked, write to the bucket.
  const prefix = bundlePrefix(env);
  for (const f of files) await env.BUNDLES.put(prefix + f.name, f.bytes);
  await env.BUNDLES.put(prefix + 'manifest.json', manifestBytes);
  return { ok: true, version, modules: files.length, prefix };
}
