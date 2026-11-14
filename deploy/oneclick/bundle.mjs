// Get the WordPress files (#414): download a release's bundle (#405) into this
// Worker's own BUNDLES bucket, after checking it.
//
// Trust: the manifest's SHA-256 is pinned in this Worker's config
// (BUNDLE_MANIFEST_SHA256), which the owner deployed. The manifest pins every
// module's SHA-256 (verifyBundle). So a changed release asset is refused, and
// nothing is written to the bucket unless the whole bundle checks out. With no pin
// set, nothing is downloaded.
import { verifyBundle, sha256Hex } from './vendor/release/bundle-manifest.mjs';
import { bundlePrefix, aBundlePrefix } from './sites.mjs';
import { BadRequest } from './vendor/provision/server-config.mjs';

// Every refusal here is text this file wrote (no upstream message), so it is a
// BadRequest: the Site Health screen shows it as it is (errors.mjs).
export const RELEASE_BASE_DEFAULT = 'https://github.com/skyphusion-labs/pagefeather/releases/download';

async function get(fetchImpl, url) {
  const res = await fetchImpl(url, { redirect: 'follow', headers: { 'user-agent': 'pagefeather-site-manager' } });
  if (!res.ok) throw new BadRequest(`download ${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Download one bundle, check it whole, then write it. `asset` is the release
// asset name prefix: '' for the b-dosql bundle, 'a.' for the approach-A bundle
// (#431). Module names inside a manifest never carry the prefix.
async function fetchBundle(env, fetchImpl, { base, version, pin, asset, prefix, pinName }) {
  const manifestBytes = await get(fetchImpl, `${base}/${asset}manifest.json`);
  const got = await sha256Hex(manifestBytes);
  if (got !== pin) throw new BadRequest(`${asset}manifest.json sha256 ${got} is not the pinned ${pin} (${pinName}); refusing it`);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  if (manifest.version !== version.slice(1)) throw new BadRequest(`the manifest is for ${manifest.version}, not ${version}`);

  const files = [];
  for (const m of manifest.modules) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(m.name)) throw new BadRequest(`bad module name ${JSON.stringify(m.name)}`);
    files.push({ name: m.name, bytes: await get(fetchImpl, `${base}/${asset}${m.name}`) });
  }
  const v = await verifyBundle(files, manifest);
  if (!v.ok) throw new BadRequest(`the bundle does not match its manifest: ${v.errors.join('; ')}`);
  return { files, manifestBytes, prefix };
}

async function writeBundle(env, { files, manifestBytes, prefix }) {
  for (const f of files) await env.BUNDLES.put(prefix + f.name, f.bytes);
  await env.BUNDLES.put(prefix + 'manifest.json', manifestBytes);
}

export async function installBundle(env, { fetchImpl = fetch } = {}) {
  const version = env.BUNDLE_VERSION;
  const pin = env.BUNDLE_MANIFEST_SHA256;
  const pinA = env.A_BUNDLE_MANIFEST_SHA256;
  if (typeof version !== 'string' || !/^v\d+\.\d+\.\d+$/.test(version)) throw new BadRequest('BUNDLE_VERSION is not set to a release (vX.Y.Z)');
  if (typeof pin !== 'string' || !/^[0-9a-f]{64}$/.test(pin)) throw new BadRequest('BUNDLE_MANIFEST_SHA256 is not set; the WordPress files are not available yet');
  // The Hyperdrive store files are optional: no pin, no download. A pin that is
  // set but malformed is refused, never skipped.
  const wantA = typeof pinA === 'string' && pinA !== '';
  if (wantA && !/^[0-9a-f]{64}$/.test(pinA)) throw new BadRequest('A_BUNDLE_MANIFEST_SHA256 is not a SHA-256');
  if (!env.BUNDLES) throw new BadRequest('the BUNDLES bucket is not bound');
  const base = `${env.RELEASE_BASE || RELEASE_BASE_DEFAULT}/${version}`;

  const b = await fetchBundle(env, fetchImpl, { base, version, pin, asset: '', prefix: bundlePrefix(env), pinName: 'BUNDLE_MANIFEST_SHA256' });
  const a = wantA ? await fetchBundle(env, fetchImpl, { base, version, pin: pinA, asset: 'a.', prefix: aBundlePrefix(env), pinName: 'A_BUNDLE_MANIFEST_SHA256' }) : null;
  // Only now, with every module of every bundle checked, write to the bucket.
  await writeBundle(env, b);
  if (a) await writeBundle(env, a);
  return { ok: true, version, modules: b.files.length, prefix: b.prefix, ...(a ? { storeModules: a.files.length, storePrefix: a.prefix } : {}) };
}
