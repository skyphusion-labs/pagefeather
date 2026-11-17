#!/usr/bin/env bash
# #771: a product bundle ships the notices of the engine its build vendored. Offline: the same helper and packager
# build-bundle.sh calls (bundle-notice-set.sh, package-notices.sh), on a fake vendor/engine.mjs; and the approach-A
# hold on npm (#788) in build-bundle.sh and deploy.sh.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
SET="$ROOT/deploy/release/bundle-notice-set.sh"; PKG="$ROOT/deploy/release/package-notices.sh"
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/bundle-notices-test.XXXXXX"); trap 'rm -rf "$T"' EXIT
mk() { printf "// test\nexport const PHP_ENGINE = '%s';\nexport const ENGINE_RECYCLE_MIB = 140;\n" "$1" > "$T/engine.mjs"; }
lv() { sed -n "s/^$1=//p" "$ROOT/spikes/b2-wordpress/engine.lock"; }
echo "1. a lean-default bundle"
mk lean; s=$("$SET" "$T/engine.mjs"); ok "lean: the lean-bundle set" "$([ "$s" = lean-bundle ] && echo 1 || echo 0)"
mkdir -p "$T/rel"; "$PKG" "$T/rel" "" "$s" > /dev/null 2>&1; rc=$?
ok "  the packager writes NOTICE, SOURCE and LICENSES.tar.gz" "$([ $rc = 0 ] && [ -s "$T/rel/NOTICE" ] && [ -s "$T/rel/SOURCE" ] && [ -s "$T/rel/LICENSES.tar.gz" ] && echo 1 || echo 0)"
ok "  SOURCE names the engine prerelease and both pinned hashes (engine.lock)" "$(grep -q "$(lv LEAN_TAG)" "$T/rel/SOURCE" && grep -q "$(lv LEAN_WASM_SHA256)" "$T/rel/SOURCE" && grep -q "$(lv LEAN_JS_SHA256)" "$T/rel/SOURCE" && echo 1 || echo 0)"
ok "  SOURCE names prepare.sh and its transform (the bundled wasm is transformed)" "$(grep -q 'spikes/b2-wordpress/prepare.sh' "$T/rel/SOURCE" && grep -q 'memory-import transform' "$T/rel/SOURCE" && echo 1 || echo 0)"
ok "  NOTICE is the lean one, naming the prerelease, and still says it includes PHP" "$(grep -q "$(lv LEAN_TAG)" "$T/rel/NOTICE" && grep -q 'This product includes PHP software' "$T/rel/NOTICE" && echo 1 || echo 0)"
ok "  no placeholder is left" "$(grep -q '@[A-Z_]*@' "$T/rel/NOTICE" "$T/rel/SOURCE" && echo 0 || echo 1)"
ok "  it is not the Playground set (which names the npm wasm as shipped)" "$(grep -q 'produced from that pinned binary' "$T/rel/SOURCE" && echo 0 || echo 1)"
echo "2. the others"
mk npm; ok "npm: the Playground set" "$([ "$("$SET" "$T/engine.mjs")" = playground ] && echo 1 || echo 0)"
mk custom; "$SET" "$T/engine.mjs" > /dev/null 2> "$T/e"; rc=$?
ok "a custom engine: refused (no published notices)" "$([ $rc = 2 ] && grep -q 'custom engine' "$T/e" && echo 1 || echo 0)"
"$SET" "$T/none.mjs" > /dev/null 2>&1; ok "no engine.mjs: refused" "$([ $? = 2 ] && echo 1 || echo 0)"
mkdir -p "$T/rel2"; ENGINE_LOCK="$T/nolock" "$PKG" "$T/rel2" "" lean-bundle > /dev/null 2>&1
ok "lean-bundle without a lock: refused" "$([ $? = 1 ] && echo 1 || echo 0)"
echo "3. build-bundle.sh and deploy.sh"
ok "build-bundle.sh packages the set bundle-notice-set.sh names, in one call" "$(grep -q 'notice_set=$("$REL/bundle-notice-set.sh" "$APP/vendor/engine.mjs")' "$ROOT/deploy/release/build-bundle.sh" && [ "$(grep -c 'package-notices.sh' "$ROOT/deploy/release/build-bundle.sh")" = 1 ] && echo 1 || echo 0)"
ok "approach A is held on npm unless chosen (#788): build-bundle.sh and deploy.sh" "$(grep -q '\[ "$engine" = a \] && \[ -z "${PHP_ENGINE:-}" \]' "$ROOT/deploy/release/build-bundle.sh" && grep -q '\[ "$VARIANT" = a \] && \[ -z "${PHP_ENGINE:-}" \]' "$ROOT/deploy/deploy.sh" && echo 1 || echo 0)"
echo "$fails failing case(s)"
exit $((fails > 0))
