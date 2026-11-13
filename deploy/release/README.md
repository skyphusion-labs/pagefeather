# deploy/release: the WordPress bundle as release assets (issue #405)

The one-click admin (#401) needs the b-dosql WordPress bundle in its own R2 bucket. It cannot build it, so CI builds it and attaches it to each GitHub Release. The release procedure is [docs/releasing.md](../../docs/releasing.md).

## Files

- `build-bundle.sh <out dir>`: builds through `deploy/wfp/lib.sh` `build_dosql` (the build every `deploy/wfp` site uses), with the OPcache primed for WooCommerce, and runs `bundle_size_check`. Then the pinned Wrangler (`deploy/wr`) writes the module set with `deploy --dry-run --outdir`. It refuses a build from a dirty tree (unless `ALLOW_DIRTY=1`, for a local try) and a tag that does not match `VERSION`.
- `bundle-manifest.mjs`: makes `manifest.json` and checks a bundle against it. It uses only Web Crypto, so the admin Worker can run the same check.
- `bundle-cli.mjs`: `make` and `verify` from the command line.
- `tests/bundle-manifest-test.mjs`: offline tests, with a passing control beside each refusal.

## The assets

| Asset | What it is |
| --- | --- |
| `index.js` | The Worker's main module, bundled by Wrangler. |
| `<hash>-<name>.wasm`, `<hash>-<name>.zip` | The PHP WebAssembly, `site.zip` (WordPress, WooCommerce, the mu-plugins) and `opcache.zip`. Wrangler names them; `index.js` imports them by these names. |
| `manifest.json` | The name, size, SHA-256 and upload type of each module, and the version, git sha, build id, and the Wrangler, WordPress and WooCommerce versions. |
| `wordpress-static.tar.gz` | `build/public`, the static files. Nothing reads it yet (#328, item 2). |
| `SHA256SUMS` | The SHA-256 of every other asset. |

The module set is a flat directory. It is the shape `deploy/provision` reads (`loadModules` in `cli.mjs`, `loadBundle` in `server-config.mjs`): copy the modules under `bundles/b-dosql/<version>/` in the `BUNDLES` bucket. `manifest.json` refuses a module name those loaders would skip, so a module cannot be dropped without an error. The test checks that the loaders still use the same name rule.

## Check a bundle by hand

```sh
gh release download v0.1.0 --dir bundle
(cd bundle && shasum -a 256 -c SHA256SUMS)
mkdir bundle/modules && for m in $(node -e 'for (const x of require("./bundle/manifest.json").modules) console.log(x.name)'); do cp "bundle/$m" bundle/modules/; done
node deploy/release/bundle-cli.mjs verify bundle/modules bundle/manifest.json
```
