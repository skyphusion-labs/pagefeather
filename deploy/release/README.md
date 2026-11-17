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
- `package-notices.sh <release dir> [prefix] [engine]`: copies notices into the release as `NOTICE`, `SOURCE` and `LICENSES.tar.gz` (#584). `engine` is `playground` (the default) or `lean`. `build-bundle.sh` runs it with no engine argument, before it writes `SHA256SUMS`. The lean prerelease is unprefixed: `package-notices.sh <release dir> "" lean`.
- `tests/bundle-manifest-test.mjs`: offline tests, with a passing control beside each refusal.
- `tests/release-notices-test.sh`: a fake release dir must contain the notices directory, SOURCE and NOTICE; every `engine/licenses.tsv` row must be present with its pinned sha256.

## The assets

| Asset | What it is |
| --- | --- |
| `index.js` | The Worker's main module, bundled by Wrangler. |
| `<hash>-<name>.wasm`, `<hash>-<name>.zip` | The PHP WebAssembly, `site.zip` (WordPress, WooCommerce, the mu-plugins) and `opcache.zip`. Wrangler names them; `index.js` imports them by these names. |
| `manifest.json` | The name, size, SHA-256 and upload type of each module, and the version, git sha, build id, and the Wrangler, WordPress and WooCommerce versions. |
| `wordpress-static.tar.gz` | `build/public`, the static files. Nothing reads it yet (#328, item 2). |
| `NOTICE` | PHP and Zend acknowledgment lines, and the list of linked components (#584). |
| `SOURCE` | For the npm Playground engine: the pinned binary, `spikes/b2-wordpress/prepare.sh`, the php-src commit, the Emscripten version, and the URL of each library source. The shipped wasm sha256 is the `SHA256SUMS` line, and SOURCE says whether that line differs from the pin (#584). |
| `LICENSES.tar.gz` | The notices directory: the licence text of each linked component, fetched at the pinned version (#584). |
| `SHA256SUMS` | The SHA-256 of every other asset. |

The approach-A assets are the same table with every name prefixed `a.`: `a.index-a-lean.js`, `a.<hash>-<name>.wasm` and `.zip`, `a.manifest.json`, `a.wordpress-static.tar.gz`, `a.NOTICE`, `a.SOURCE`, `a.LICENSES.tar.gz`, `a.SHA256SUMS`. Inside `a.manifest.json` the module names are the real ones (no prefix), because they are the names `index-a-lean.js` imports. A loader reads asset `a.<name>` for module `<name>`. CI checks that no `a.` asset name equals a b-dosql one.

## Which engine

A `vX.Y.Z` product release ships the npm Playground engine in both bundles (b-dosql and approach-A). `prepare.sh` rewrites that binary (the memory-import transform and the loader patch) before the bundle is built. `build-bundle.sh` packages the playground notices.

The custom engine (variant s1-lean, built by `.github/workflows/pagefeather-engine.yml` from `engine/` at the tag) is a separate prerelease. Its assets are `pagefeather-engine-lean.js` and `pagefeather-engine-lean.wasm`. Notices for that release come from `package-notices.sh <release dir> "" lean`: `lean/SOURCE` names `engine/` at the tag, `engine/licenses.tsv` and the workflow. `release-bundle.yml` does not publish that prerelease.

The module set is a flat directory. It is the shape `deploy/provision` reads (`loadModules` in `cli.mjs`, `loadBundle` in `server-config.mjs`): copy the modules under `bundles/b-dosql/<version>/` in the `BUNDLES` bucket. `manifest.json` refuses a module name those loaders would skip, so a module cannot be dropped without an error. The test checks that the loaders still use the same name rule.

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
