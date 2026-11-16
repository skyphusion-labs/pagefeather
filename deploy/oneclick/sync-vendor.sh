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
#   deploy/oneclick/sync-vendor.sh --check [prefix]
#                                            compare, copy nothing (#739): exit 1 naming each source whose copy
#                                            differs, 2 when no pair's source starts with the prefix. The suites
#                                            that edit a vendored source run it for their prefix
#                                            (deploy/provision, deploy/release, deploy/wfp/dispatcher tests).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
PAIRS=(
  "deploy/provision/cf.mjs vendor/provision/cf.mjs"
  "deploy/provision/hyperdrive-gate.mjs vendor/provision/hyperdrive-gate.mjs"
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
if [ "${1:-}" = --check ]; then
  prefix=${2:-}
  n=0; bad=0
  for p in "${PAIRS[@]}"; do
    read -r src dst <<<"$p"
    case "$src" in "$prefix"*) ;; *) continue ;; esac
    n=$((n + 1))
    if ! cmp -s "$ROOT/$src" "$HERE/$dst"; then
      echo "vendor: deploy/oneclick/$dst differs from $src: run deploy/oneclick/sync-vendor.sh and commit the copy" >&2
      bad=$((bad + 1))
    fi
  done
  [ "$n" -gt 0 ] || { echo "vendor: no vendored pair has a source under '${prefix}' (a check that compares nothing is not a pass)" >&2; exit 2; }
  [ "$bad" = 0 ] || exit 1
  echo "vendor: $n pair$([ "$n" = 1 ] || echo s) equal${prefix:+ under $prefix}"
  exit 0
fi
for p in "${PAIRS[@]}"; do
  read -r src dst <<<"$p"
  mkdir -p "$HERE/$(dirname "$dst")"
  cp "$ROOT/$src" "$HERE/$dst"
  echo "vendor: $src -> deploy/oneclick/$dst"
done
