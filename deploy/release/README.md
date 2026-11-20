# deploy/release: the WordPress bundles as release assets (issues #405, #431)

The one-click admin (#401) needs the WordPress bundles in its own R2 bucket. It cannot build them, so CI builds them and attaches them to each GitHub Release. There are two:

- **the b-dosql bundle** (a site on the Durable Object path, `wp`): `manifest.json`, `SHA256SUMS` and the rest, unprefixed;
- **the approach-A bundle** (a Hyperdrive store, `a`, #431): the same set, every asset name prefixed `a.`.

The release procedure is [docs/releasing.md](../../docs/releasing.md).

## Files

- `build-bundle.sh <out dir>`: builds through `deploy/wfp/lib.sh` `build_dosql` (the build every `deploy/wfp` site uses), with the OPcache primed for WooCommerce, and runs `bundle_size_check`. Then the pinned Wrangler (`deploy/wr`) writes the module set with `deploy --dry-run --outdir`. It refuses a build from a dirty tree (unless `ALLOW_DIRTY=1`, for a local try) and a tag that does not match `VERSION`.
- `BUNDLE_ENGINE=a build-bundle.sh <out dir>`: the approach-A bundle. It runs `prepare.sh` (the loader patches), then `spikes/b2-wordpress/opcache-a.sh`: build the D1 engine, prime the OPcache there with WooCommerce, build `ENGINE=a`, and bundle the cache minus the one colliding `wp-content/db.php` entry. Then `opcache-check.py` (the same floor as a primed b-dosql store) and `bundle_size_check`. The main module is `index-a-lean.js` (the lean MySQL client); the build id carries `-a` and must end `-wooprimed`. This is the stack that ran WooCommerce 12 of 12 (docs/results.md, 2026-11-09).
- `bundle-manifest.mjs`: makes `manifest.json` and checks a bundle against it. It uses only Web Crypto, so the admin Worker can run the same check.
- `bundle-cli.mjs`: `make` and `verify` from the command line.
- `package-notices.sh <release dir> [prefix] [engine]`: copies notices into the release as `NOTICE`, `SOURCE` and `LICENSES.tar.gz` (#584). `engine` is `playground` (the default), `lean`, or `lean-bundle`. `build-bundle.sh` asks `bundle-notice-set.sh` which set the vendored engine needs (`lean-bundle` for the pinned lean engine, `playground` for `PHP_ENGINE=npm`) and passes that, before it writes `SHA256SUMS`. The lean prerelease is unprefixed: `package-notices.sh <release dir> "" lean`.
- `tests/bundle-manifest-test.mjs`: offline tests, with a passing control beside each refusal.
- `tests/release-notices-test.sh`: a fake release dir must contain the notices directory, SOURCE and NOTICE; every `engine/licenses.tsv` row must be present with its pinned sha256.

## The assets

| Asset | What it is |
| --- | --- |
| `index.js` | The Worker's main module, bundled by Wrangler. |
| `<hash>-<name>.wasm`, `<hash>-<name>.zip` | The PHP WebAssembly, `site.zip` (WordPress, WooCommerce, the mu-plugins) and `opcache.zip`. Wrangler names them; `index.js` imports them by these names. |
| `manifest.json` | The name, size, SHA-256 and upload type of each module, and the version, git sha, build id, and the Wrangler, WordPress and WooCommerce versions. |
| `wordpress-static.tar.gz` | `build/public`, the static files. Nothing reads it yet (#328, item 2). |
| `remote-packs-index.json` | The opcache index, the site index, and each pack's path, size and hashes (#1036). Absent when the bundle was built with `OPCACHE_REMOTE=0`. `manifest.json` carries `assetsIndexSha256` of this file when it is present. |
| `oc-*.zip`, `st-*.zip`, `site-hot.zip` | The packs. The one-click admin uploads them as the site's assets under `/_pf/`. |
| `NOTICE` | PHP and Zend acknowledgment lines, and the list of linked components (#584). |
| `SOURCE` | For the pinned lean engine: the engine prerelease, both pinned hashes, and `prepare.sh`'s transform. For the npm Playground engine (`PHP_ENGINE=npm`): the pinned binary, `spikes/b2-wordpress/prepare.sh`, the php-src commit, the Emscripten version, and the URL of each library source. The shipped wasm sha256 is the `SHA256SUMS` line, and SOURCE says whether that line differs from the pin (#584). |
| `LICENSES.tar.gz` | The notices directory: the licence text of each linked component, fetched at the pinned version (#584). |
| `SHA256SUMS` | The SHA-256 of every other asset. |

The approach-A assets are the same table with every name prefixed `a.`: `a.index-a-lean.js`, `a.<hash>-<name>.wasm` and `.zip`, `a.manifest.json`, `a.wordpress-static.tar.gz`, `a.NOTICE`, `a.SOURCE`, `a.LICENSES.tar.gz`, `a.SHA256SUMS`. Inside `a.manifest.json` the module names are the real ones (no prefix), because they are the names `index-a-lean.js` imports. A loader reads asset `a.<name>` for module `<name>`. The pack index works the same way: `asset` is `oc-0.zip`, and the file in the release is `a.oc-0.zip`. CI checks that no `a.` asset name equals a b-dosql one.

## Which engine

A `vX.Y.Z` product release ships the pinned lean engine in both bundles (b-dosql and approach-A), from `spikes/b2-wordpress/engine.lock` (#771, #1027). `prepare.sh` applies the loader patches. `build-bundle.sh` packages the lean-bundle notices. `PHP_ENGINE=npm` builds the npm Playground engine and packages the playground notices instead.

The custom engine (variant s1-lean, built by `.github/workflows/pagefeather-engine.yml` from `engine/` at the tag) is a separate prerelease. Its assets are `pagefeather-engine-lean.js` and `pagefeather-engine-lean.wasm`. Notices for that release come from `package-notices.sh <release dir> "" lean`: `lean/SOURCE` names `engine/` at the tag, `engine/licenses.tsv` and the workflow. `release-bundle.yml` does not publish that prerelease.

The module set is a flat directory. It is the shape `deploy/provision` reads (`loadModules` in `cli.mjs`, `loadBundle` in `server-config.mjs`): copy the modules under `bundles/b-dosql/<version>/` in the `BUNDLES` bucket, and copy `manifest.json` next to them. `manifest.json` refuses a module name those loaders would skip, so a module cannot be dropped without an error. When `manifest.json` names `assetsIndexSha256`, also copy `remote-packs-index.json` and each pack. The provisioning Worker reads a pack at `assets` plus its `/_pf/` path, for example `bundles/b-dosql/<version>/assets/_pf/<build-id>/oc-0.zip`. It refuses the site when the manifest names that hash and `remote-packs-index.json` is not there. The built Worker imports the pack indexes and the zips are empty, so a site with no packs answers 503 on every request. A release built with `OPCACHE_REMOTE=0` has no `assetsIndexSha256` and no pack index. Copy the modules only, as before. `OPCACHE_REMOTE=0` and `SITE_REMOTE=0` at site-add are refused for a bundle that carries the index. Only the build can opt out. The test checks that the loaders still use the same name rule.

## Check a bundle by hand

```sh
gh release download v0.1.0 --dir bundle
(cd bundle && shasum -a 256 -c SHA256SUMS)
mkdir bundle/modules && for m in $(node -e 'for (const x of require("./bundle/manifest.json").modules) console.log(x.name)'); do cp "bundle/$m" bundle/modules/; done
node deploy/release/bundle-cli.mjs verify bundle/modules bundle/manifest.json
# The approach-A bundle: the same check, each module read from its a.-prefixed asset.
(cd bundle && shasum -a 256 -c a.SHA256SUMS)
mkdir bundle/modules-a && for m in $(node -e 'for (const x of require("./bundle/a.manifest.json").modules) console.log(x.name)'); do cp "bundle/a.$m" "bundle/modules-a/$m"; done
node deploy/release/bundle-cli.mjs verify bundle/modules-a bundle/a.manifest.json
```
