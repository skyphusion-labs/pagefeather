#!/usr/bin/env bash
# #827: one engine tag, computed once (engine.sh engine_tag, which build-id.sh also uses), recorded by prepare.sh in
# vendor/engine.mjs, required by build.sh (engine_vendor_check) and by every deploy that skips the build
# (engine_build_check). Before #827 build.sh compared engine NAMES, so two custom engines, or one lean pin and the
# next, passed, and the build id named an engine vendor/ did not hold. Offline: engine.sh is copied beside a test
# engine.lock, and the engines are small fake files (engine_resolve only reads a given pair).
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/engine-tag-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/eng" "$T/A" "$T/B" "$T/X" "$T/Y"
cp "$HERE/engine.sh" "$T/eng/engine.sh"
for k in A B X Y; do printf 'wasm %s\n' "$k" > "$T/$k/php_8_3.wasm"; printf 'loader %s\n' "$k" > "$T/$k/php_8_3.js"; done
sha() { { sha256sum "$1" 2>/dev/null || shasum -a 256 "$1"; } | cut -d' ' -f1; }
tag_of() { echo "e$(cat "$T/$1/php_8_3.wasm" "$T/$1/php_8_3.js" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-8)"; }
lock() { # lock <pair>: the test engine.lock pins that pair as lean
  cat > "$T/eng/engine.lock" <<LOCK
PHP_ENGINE_DEFAULT=lean
LEAN_TAG=engine-test
LEAN_BASE_URL=http://127.0.0.1:9/never-used
LEAN_WASM_ASSET=pagefeather-engine-lean.wasm
LEAN_JS_ASSET=pagefeather-engine-lean.js
LEAN_WASM_SHA256=$(sha "$T/$1/php_8_3.wasm")
LEAN_JS_SHA256=$(sha "$T/$1/php_8_3.js")
LOCK
}
lock X
# run <pair|npm> <bash code>: engine.sh sourced and resolved for that engine, then the code.
run() {
  local p=$1; shift
  if [ "$p" = npm ]; then env -u PF_ENGINE_JS -u PF_ENGINE_WASM PHP_ENGINE=npm bash -c ". '$T/eng/engine.sh' && engine_resolve && $*"
  else env -u PHP_ENGINE PF_ENGINE_JS="$T/$p/php_8_3.js" PF_ENGINE_WASM="$T/$p/php_8_3.wasm" bash -c ". '$T/eng/engine.sh' && engine_resolve && $*"; fi
}

# 1. The tag: the build id's own -e tag (sha256 of wasm then js, 8 hex), or npm.
ok "engine_tag of a custom pair is e + the first 8 hex of sha256(wasm, js)" "$([ "$(run A engine_tag 2>/dev/null)" = "$(tag_of A)" ] && echo 1 || echo 0)"
ok "engine_tag of npm is npm" "$([ "$(run npm engine_tag 2>/dev/null)" = npm ] && echo 1 || echo 0)"
ok "build-id.sh takes its -e tag from engine_tag (one computation, no second hash)" "$(grep -q 'engine_tag' "$HERE/build-id.sh" && ! grep -qE 'sha256sum|shasum' "$HERE/build-id.sh" && echo 1 || echo 0)"

# 2. The record: engine_mjs writes the name, the recycle line and the tag.
run A 'engine_mjs' > "$T/A.mjs" 2>/dev/null
ok "engine_mjs records ENGINE_TAG = '<tag>'" "$(grep -qx "export const ENGINE_TAG = '$(tag_of A)';" "$T/A.mjs" && echo 1 || echo 0)"
ok "  and still PHP_ENGINE and ENGINE_RECYCLE_MIB (index.js reads them)" "$(grep -qx "export const PHP_ENGINE = 'custom';" "$T/A.mjs" && grep -qx 'export const ENGINE_RECYCLE_MIB = 140;' "$T/A.mjs" && echo 1 || echo 0)"
ok "prepare.sh writes vendor/engine.mjs with engine_mjs" "$(grep -qE 'engine_mjs[[:space:]]*>[[:space:]]*vendor/engine\.mjs' "$HERE/prepare.sh" && echo 1 || echo 0)"

# 3. build.sh's check (engine_vendor_check <engine.mjs>).
run A "engine_vendor_check '$T/A.mjs'" >/dev/null 2>&1; ok "the same engine passes" "$([ $? = 0 ] && echo 1 || echo 0)"
msg=$(run B "engine_vendor_check '$T/A.mjs'" 2>&1); rc=$?
ok "another engine OF THE SAME NAME (custom A vendored, custom B built) is refused (#827's repro)" "$([ $rc = 2 ] && echo 1 || echo 0)"
ok "  the message names both tags and the fix (prepare.sh)" "$(echo "$msg" | grep -qF "$(tag_of A)" && echo "$msg" | grep -qF "$(tag_of B)" && echo "$msg" | grep -qF 'prepare.sh' && echo 1 || echo 0)"
run X 'engine_mjs' > "$T/X.mjs" 2>/dev/null
ok "  (X is the pinned pair, so it is named lean)" "$(grep -qx "export const PHP_ENGINE = 'lean';" "$T/X.mjs" && echo 1 || echo 0)"
lock Y
msg=$(run Y "engine_vendor_check '$T/X.mjs'" 2>&1); rc=$?
ok "a vendor/ of the OLD lean pin, built after the pin moved (lean and lean), is refused" "$([ $rc = 2 ] && echo "$msg" | grep -qF "$(tag_of X)" && echo "$msg" | grep -qF "$(tag_of Y)" && echo 1 || echo 0)"
lock X
grep -v ENGINE_TAG "$T/A.mjs" > "$T/old.mjs"
msg=$(run A "engine_vendor_check '$T/old.mjs'" 2>&1); rc=$?
ok "a vendor/engine.mjs from before #827 (no ENGINE_TAG) is refused, and says prepare.sh" "$([ $rc = 2 ] && echo "$msg" | grep -qF 'prepare.sh' && echo 1 || echo 0)"
msg=$(run A "engine_vendor_check '$T/none.mjs'" 2>&1); rc=$?
ok "no vendor/engine.mjs is refused, and says prepare.sh" "$([ $rc = 2 ] && echo "$msg" | grep -qF 'prepare.sh' && echo 1 || echo 0)"
run npm 'engine_mjs' > "$T/npm.mjs" 2>/dev/null
run npm "engine_vendor_check '$T/npm.mjs'" >/dev/null 2>&1; ok "npm vendored, npm built: passes" "$([ $? = 0 ] && echo 1 || echo 0)"
run A "engine_vendor_check '$T/npm.mjs'" >/dev/null 2>&1; ok "npm vendored, a custom engine built: refused" "$([ $? = 2 ] && echo 1 || echo 0)"
ok "build.sh runs engine_vendor_check on vendor/engine.mjs and writes build/engine-tag" "$(grep -q 'engine_vendor_check vendor/engine.mjs' "$HERE/build.sh" && grep -q 'build/engine-tag' "$HERE/build.sh" && echo 1 || echo 0)"
ok "  the old name-only compare is gone" "$(! grep -q 'vendor/ holds the \$built engine' "$HERE/build.sh" && echo 1 || echo 0)"

# 4. A deploy that skips the build (engine_build_check <app>): build/engine-tag against vendor/engine.mjs. No resolve.
mkdir -p "$T/app/build" "$T/app/vendor"
cp "$T/A.mjs" "$T/app/vendor/engine.mjs"; tag_of A > "$T/app/build/engine-tag"
bc() { bash -c ". '$T/eng/engine.sh' && engine_build_check '$T/app'"; }
bc >/dev/null 2>&1; ok "build and vendor/ of one engine: passes" "$([ $? = 0 ] && echo 1 || echo 0)"
run B 'engine_mjs' > "$T/app/vendor/engine.mjs" 2>/dev/null
msg=$(bc 2>&1); rc=$?
ok "vendor/ re-prepared with another engine after the build: refused, both tags named" "$([ $rc = 2 ] && echo "$msg" | grep -qF "$(tag_of A)" && echo "$msg" | grep -qF "$(tag_of B)" && echo 1 || echo 0)"
ok "  and it says what fixes it (prepare.sh, then build.sh)" "$(echo "$msg" | grep -qF 'prepare.sh' && echo "$msg" | grep -qF 'build.sh' && echo 1 || echo 0)"
rm -f "$T/app/build/engine-tag"
msg=$(bc 2>&1); rc=$?
ok "a build from before #827 (no build/engine-tag) is refused, and says build.sh" "$([ $rc = 2 ] && echo "$msg" | grep -qF 'build.sh' && echo 1 || echo 0)"
ok "site add runs engine_build_check before it deploys" "$(awk '/b-dosql is not built/{f=1} f&&/engine_build_check/{print 1; exit}' "$ROOT/deploy/wfp/site" | grep -q 1 && echo 1 || echo 0)"
ok "up.sh runs engine_build_check after the (maybe skipped) build" "$(awk '/build_dosql/{f=1} f&&/engine_build_check/{print 1; exit}' "$ROOT/deploy/wfp/up.sh" | grep -q 1 && echo 1 || echo 0)"
ok "deploy.sh runs engine_build_check before it deploys" "$(awk '/engine_build_check/{f=1} f&&/wr" deploy/{print 1; exit}' "$ROOT/deploy/deploy.sh" | grep -q 1 && echo 1 || echo 0)"

echo "$fails failing case(s)"
[ "$fails" = 0 ]
