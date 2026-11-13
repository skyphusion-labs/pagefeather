#!/usr/bin/env bash
# Build a WordPress bundle and package it as GitHub Release assets (issue #405).
#
#   deploy/release/build-bundle.sh <out dir>                    the b-dosql bundle
#   BUNDLE_ENGINE=a deploy/release/build-bundle.sh <out dir>    the approach-A bundle (#431)
#
# BUNDLE_ENGINE=a builds the Hyperdrive store's bundle: ENGINE=a (PHP in the Worker, MySQL through
# Hyperdrive), the lean MySQL client entry index-a-lean.js, and the precompiled OPcache from
# spikes/b2-wordpress/opcache-a.sh (primed on the D1 engine, minus the one colliding db.php entry),
# the stack that ran WooCommerce 12 of 12 (docs/results.md, 2026-11-09). Its build id carries -a.
# Its assets are the same set, each name prefixed "a." (a.manifest.json, a.SHA256SUMS,
# a.<module>, a.wordpress-static.tar.gz), so both bundles sit in one flat release without a clash.
# The manifest inside lists the real module names; a loader strips the prefix.
#
# The one-click admin (#401) downloads these assets into its own R2 bucket and checks
# each module against manifest.json before it uses it. So this script builds through
# the SAME path every deploy/wfp site uses (lib.sh build_dosql, then bundle_size_check),
# with the OPcache primed for WooCommerce (a one-click site can be a store).
#
# Output, in <out dir>/release (every file there is a release asset):
#   <modules>              index.js and the hash-named .wasm and .zip modules, flat, as the
#                          pinned Wrangler writes them with deploy --dry-run --outdir
#   manifest.json          each module's name, size, sha256 and type, plus the version, git sha,
#                          build id, and the Wrangler, WordPress and WooCommerce versions
#   wordpress-static.tar.gz  build/public (the static files). Nothing reads it yet (#328 item 2).
#   SHA256SUMS             sha256 of every other file in release/
#
# Env:
#   VERSION_TAG  the release tag (v1.2.3). When set it must equal v$(cat VERSION).
#   ALLOW_DIRTY  1 lets a local run package a build from a tree with uncommitted changes.
#                CI never sets it, so a published bundle always names a commit.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=${1:?usage: build-bundle.sh <out dir>}
REL="$ROOT/deploy/release"

version=$(tr -d '[:space:]' < "$ROOT/VERSION")
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "build-bundle: VERSION is not x.y.z: '$version'" >&2; exit 2; }
if [ -n "${VERSION_TAG:-}" ] && [ "$VERSION_TAG" != "v$version" ]; then
  echo "build-bundle: the tag $VERSION_TAG does not match VERSION ($version); a release PR bumps VERSION first (docs/releasing.md)" >&2
  exit 2
fi
engine=${BUNDLE_ENGINE:-dosql}
case "$engine" in
  dosql) main=index.js; prefix="" ;;
  a) main=index-a-lean.js; prefix="a." ;;
  *) echo "build-bundle: BUNDLE_ENGINE must be dosql or a, not '$engine'" >&2; exit 2 ;;
esac
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT")" ]; then echo "build-bundle: $OUT is not empty" >&2; exit 2; fi
mkdir -p "$OUT/modules" "$OUT/release"
OUT=$(cd "$OUT" && pwd)

# shellcheck source=../wfp/lib.sh
source "$ROOT/deploy/wfp/lib.sh"
export WOO_ACTIVE=1
if [ "$engine" = a ]; then
  # The approach-A build. prepare.sh first, as build_dosql does (#446: an old loader otherwise
  # survives in a tree that built before). opcache-a.sh builds D1, primes the OPcache there,
  # builds ENGINE=a and bundles the cache minus db.php. Then the cache is checked (the same floor
  # as a primed b-dosql store) and the size gate runs, as build_dosql runs it.
  ( cd "$APP"
    [ -d node_modules ] || npm ci --silent
    ./prepare.sh || { echo "prepare.sh failed: the loader was not rebuilt"; exit 1; }
    ./opcache-a.sh > build/opcache-a.log 2>&1 || { echo "opcache-a.sh failed:"; tail -25 build/opcache-a.log; exit 1; }
    tail -2 build/opcache-a.log
    python3 -I opcache-check.py build/opcache.zip 1 || { echo "the approach-A OPcache is not primed"; exit 1; }
  ) || exit 1
  bundle_size_check
else
  build_dosql
  # build_dosql already ran bundle_size_check; its status is checked by set -e.
fi

build_id=$(sed -n 's/^export default "\(.*\)";$/\1/p' "$APP/build/build-id.js")
[ -n "$build_id" ] || { echo "build-bundle: no build id in $APP/build/build-id.js" >&2; exit 1; }
case "$build_id" in
  *-dirty*) [ "${ALLOW_DIRTY:-0}" = 1 ] || { echo "build-bundle: build $build_id is from a dirty tree; refusing to package it" >&2; exit 1; } ;;
esac
case "$build_id" in *-wooprimed) ;; *) echo "build-bundle: build $build_id is not WooCommerce-primed" >&2; exit 1 ;; esac
# The engine the id names must be the engine asked for (an a bundle from a b-dosql build would deploy the
# wrong PHP and database driver).
case "$engine:$build_id" in
  a:*-a-*|a:*-a) ;;
  a:*) echo "build-bundle: build $build_id is not an ENGINE=a build" >&2; exit 1 ;;
  dosql:*-a-*|dosql:*-a) echo "build-bundle: build $build_id is an ENGINE=a build, not b-dosql" >&2; exit 1 ;;
esac

# The module set: the pinned Wrangler's own bundling, the same config keys as render_user.
cfg="$APP/wrangler.deploy.release.toml"   # matched by spikes/b2-wordpress/.gitignore
cat > "$cfg" <<TOML
# Generated by deploy/release/build-bundle.sh. Do not edit.
name = "pagefeather-release"
main = "$main"
compatibility_date = "$(compat_date)"
compatibility_flags = ["nodejs_compat"]
rules = [{ type = "Data", globs = ["**/*.zip"], fallthrough = false }]
TOML
dry="$OUT/dry-run"
( cd "$APP" && "$WR" deploy --dry-run --config "$cfg" --outdir "$dry" ) | tail -3
rm -f "$cfg"
# Wrangler also writes README.md and source maps; the loaders skip both, so they are not modules.
for f in "$dry"/*; do
  n=$(basename "$f")
  case "$n" in README.md|*.map) continue ;; esac
  cp "$f" "$OUT/modules/$n"
done
rm -rf "$dry"

wr_version=$("$WR" --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
wp_version=$(sed -n 's/^WP_VERSION=//p' "$APP/build.sh" | head -1)
woo_version=$(sed -n 's/^WOO_VERSION=//p' "$APP/build.sh" | head -1)
git_sha=$(git -C "$ROOT" rev-parse HEAD)
node "$REL/bundle-cli.mjs" make "$OUT/modules" "$OUT/release/manifest.json" \
  "version=$version" "gitSha=$git_sha" "buildId=$build_id" "wrangler=$wr_version" \
  "wordpress=$wp_version" "woocommerce=$woo_version" "compatibilityDate=$(compat_date)" "mainModule=$main"
# Check what was just described before anything is published (the same check the admin runs).
node "$REL/bundle-cli.mjs" verify "$OUT/modules" "$OUT/release/manifest.json"

for f in "$OUT/modules"/*; do cp "$f" "$OUT/release/${prefix}$(basename "$f")"; done
if [ -n "$prefix" ]; then mv "$OUT/release/manifest.json" "$OUT/release/${prefix}manifest.json"; fi
tar -czf "$OUT/release/${prefix}wordpress-static.tar.gz" -C "$APP/build" public
( cd "$OUT/release" && shasum -a 256 $(ls | grep -v "^${prefix}SHA256SUMS\$" | sort) > "${prefix}SHA256SUMS" )
echo "build-bundle: $engine v$version, build $build_id, main $main, $(ls "$OUT/release" | wc -l | tr -d ' ') assets in $OUT/release"
