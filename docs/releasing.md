# Releasing

**Status: current from issue #405.** This page is for a maintainer who cuts a release. A release publishes the WordPress bundle that the one-click admin downloads (#401).

## What a release is

A release is a version of this repository, `vX.Y.Z`. The version is in the file `VERSION`. A release has three parts, and it is not done until all three exist:

1. A **release pull request** that changes `VERSION` (and nothing else that is not reviewed). It merges through the normal gate. Nobody pushes a release commit to `main`.
2. An **annotated tag** `vX.Y.Z` on the merge commit of that pull request.
3. A **published GitHub Release** for that tag. People watch the Releases page, and publishing the Release starts the bundle build.

## Cut a release

1. Open a pull request that changes `VERSION` to the new version, for example `0.1.0`. Before 1.0, a change that adds something is a MINOR bump; a fix is a PATCH bump.
2. When it is merged, tag the merge commit:

   ```sh
   git fetch origin && git tag -a v0.1.0 -m "v0.1.0" <merge commit sha> && git push origin v0.1.0
   ```

3. Publish the GitHub Release from the tag. Write the notes to a file first; never put the notes in a quoted shell string:

   ```sh
   gh release create v0.1.0 --verify-tag --title v0.1.0 --notes-file notes.md
   ```

4. Publishing starts `.github/workflows/release-bundle.yml` (job `publish`). Check that it is green. It:
   - refuses a tag that is not `vX.Y.Z`, a tag that is not on `main`, and a tag that does not match `VERSION`;
   - refuses a release that already has assets (assets are never replaced, see below);
   - builds both bundles with `deploy/release/build-bundle.sh` (the b-dosql bundle, then `BUNDLE_ENGINE=a` for the approach-A bundle of the Hyperdrive store, #431), uploads them in one upload, then downloads them again and checks every file of each.

5. Read the Release page. It must list `manifest.json`, `SHA256SUMS`, `wordpress-static.tar.gz`, `NOTICE`, `SOURCE`, `LICENSES.tar.gz` and the modules (`index.js` and the `.wasm` and `.zip` files). The approach-A bundle is the same names with the `a.` prefix.

If the build fails, fix the cause on `main` and cut the next PATCH version. To run the build again for a tag whose Release has no assets yet, run the workflow by hand with that tag (`gh workflow run release-bundle.yml -f tag=v0.1.0`).

## Why assets are never replaced

The one-click admin checks each module against `manifest.json`, and it may pin the hashes of a release. Two builds of one commit are not the same byte for byte (zip timestamps, the OPcache). So replacing the assets of a release could break a site manager that already trusts them. A new build is a new version.

## Which engine a release ships

A version tag `vX.Y.Z` ships the npm Playground engine (the binary pinned in `engine/UPSTREAM`), after `spikes/b2-wordpress/prepare.sh`, in both the b-dosql bundle and the approach-A bundle. `build-bundle.sh` packages that engine's notices (the default of `package-notices.sh`).

The custom engine (variant s1-lean) is a separate prerelease. Its assets are `pagefeather-engine-lean.js` and `pagefeather-engine-lean.wasm`. It carries notices by running `package-notices.sh <release dir> "" lean` before `SHA256SUMS`. That SOURCE names `engine/` at the tag, the pins and licences in `engine/licenses.tsv`, and `.github/workflows/pagefeather-engine.yml` (variant s1-lean). `release-bundle.yml` does not publish that prerelease.

## The bundle

See [deploy/release/README.md](../deploy/release/README.md) for what is in the bundle and how to check it.
