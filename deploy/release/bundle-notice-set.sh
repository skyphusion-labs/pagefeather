#!/usr/bin/env bash
# The notice set a product bundle ships (#771), from the engine its build vendored (spikes/b2-wordpress/vendor/engine.mjs,
# written by prepare.sh): npm -> playground (package-notices.sh's default), lean -> lean-bundle. A custom engine (other
# PF_ENGINE_JS/WASM files) has no published notices and is refused, as is a tree with no engine.mjs: a release ships
# only a published, pinned engine.
#   deploy/release/bundle-notice-set.sh <vendor/engine.mjs>
# Test: deploy/release/tests/bundle-notices-test.sh.
set -euo pipefail
f=${1:?usage: bundle-notice-set.sh <vendor/engine.mjs>}
[ -s "$f" ] || { echo "bundle-notice-set: $f is missing: run prepare.sh" >&2; exit 2; }
e=$(sed -n "s/^export const PHP_ENGINE = '\([a-z]*\)';$/\1/p" "$f")
case "$e" in
  npm) echo playground ;;
  lean) echo lean-bundle ;;
  custom) echo "bundle-notice-set: the build used a custom engine (PF_ENGINE_JS/WASM that are not the pin); a release ships only a published engine" >&2; exit 2 ;;
  *) echo "bundle-notice-set: $f names no engine" >&2; exit 2 ;;
esac
