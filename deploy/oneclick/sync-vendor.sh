#!/usr/bin/env bash
# Copy the code the site manager runs into deploy/oneclick/vendor (issue #416).
#
# The Deploy to Cloudflare button builds ONLY this directory: Cloudflare makes it the
# root of the owner's new repository, so it must hold every file it imports
# (https://developers.cloudflare.com/workers/platform/deploy-buttons/, "Monorepos",
# read 2026-11-13). The copies are byte-identical to their sources;
# tests/vendor-test.mjs fails when one differs. Run this after any change to a source.
#
#   deploy/oneclick/sync-vendor.sh          copy
#   deploy/oneclick/sync-vendor.sh --list   print "source vendor-path" pairs
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
PAIRS=(
  "deploy/provision/cf.mjs vendor/provision/cf.mjs"
  "deploy/provision/ops.mjs vendor/provision/ops.mjs"
  "deploy/provision/provision.mjs vendor/provision/provision.mjs"
  "deploy/provision/registry.mjs vendor/provision/registry.mjs"
  "deploy/provision/server-config.mjs vendor/provision/server-config.mjs"
  "deploy/provision/shared.mjs vendor/provision/shared.mjs"
  "deploy/provision/wp-site-config.mjs vendor/provision/wp-site-config.mjs"
  "deploy/release/bundle-manifest.mjs vendor/release/bundle-manifest.mjs"
  "deploy/wfp/dispatcher/worker.js vendor/wfp-dispatcher/worker.js"
)
if [ "${1:-}" = --list ]; then printf '%s\n' "${PAIRS[@]}"; exit 0; fi
for p in "${PAIRS[@]}"; do
  read -r src dst <<<"$p"
  mkdir -p "$HERE/$(dirname "$dst")"
  cp "$ROOT/$src" "$HERE/$dst"
  echo "vendor: $src -> deploy/oneclick/$dst"
done
