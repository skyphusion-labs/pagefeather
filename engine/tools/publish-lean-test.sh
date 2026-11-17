#!/usr/bin/env bash
# engine/tools/publish-lean.sh (#771), offline: fake artifact files pinned by a temp lock (ENGINE_LOCK), and the real
# notices packager (#742).
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
P="$ROOT/engine/tools/publish-lean.sh"
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/publish-lean-test.XXXXXX"); trap 'rm -rf "$T"' EXIT
sha() { { sha256sum "$1" 2>/dev/null || shasum -a 256 "$1"; } | cut -d' ' -f1; }
mkdir -p "$T/art/8_3_36"; printf 'a lean wasm\n' > "$T/art/8_3_36/php_8_3.wasm"; printf 'a lean loader\n' > "$T/art/php_8_3.js"
lock() { # lock <wasm sha> <js sha> [tag] [wasm asset]
  printf 'PHP_ENGINE_DEFAULT=lean\nLEAN_TAG=%s\nLEAN_BASE_URL=https://example.invalid/%s\nLEAN_WASM_ASSET=%s\nLEAN_JS_ASSET=pagefeather-engine-lean.js\nLEAN_WASM_SHA256=%s\nLEAN_JS_SHA256=%s\n' \
    "${3:-engine-lean-test}" "${3:-engine-lean-test}" "${4:-pagefeather-engine-lean.wasm}" "$1" "$2" > "$T/lock"
}
W=$(sha "$T/art/8_3_36/php_8_3.wasm"); J=$(sha "$T/art/php_8_3.js")
lock "$W" "$J"
ENGINE_LOCK="$T/lock" FROM_RUN=123 "$P" "$T/art" "$T/out" > "$T/ok.log" 2>&1; rc=$?
ok "a pinned artifact: assembled (rc 0)" "$([ $rc = 0 ] && echo 1 || echo 0)"
ok "  the two files under their published names, the same bytes" "$([ "$(sha "$T/out/pagefeather-engine-lean.wasm")" = "$W" ] && [ "$(sha "$T/out/pagefeather-engine-lean.js")" = "$J" ] && echo 1 || echo 0)"
ok "  no file named php_8_3.* is published" "$(ls "$T/out" | grep -q php_8_3 && echo 0 || echo 1)"
ok "  SHA256SUMS lists both, and they check" "$( (cd "$T/out" && { sha256sum -c SHA256SUMS 2>/dev/null || shasum -a 256 -c SHA256SUMS; } >/dev/null) && [ "$(wc -l < "$T/out/SHA256SUMS" | tr -d ' ')" = 2 ] && echo 1 || echo 0)"
ok "  the packager's NOTICE, SOURCE and LICENSES.tar.gz (#742)" "$([ -s "$T/out/NOTICE" ] && [ -s "$T/out/SOURCE" ] && [ -s "$T/out/LICENSES.tar.gz" ] && echo 1 || echo 0)"
ok "  SOURCE is the lean one (names pagefeather-engine-lean.wasm)" "$(grep -q 'pagefeather-engine-lean.wasm' "$T/out/SOURCE" && echo 1 || echo 0)"
ok "  the release body states both hashes, the run, and the notices" "$(grep -q "$W" "$T/out/release-body.md" && grep -q "$J" "$T/out/release-body.md" && grep -q 'run 123' "$T/out/release-body.md" && grep -q '#584' "$T/out/release-body.md" && echo 1 || echo 0)"
rm -rf "$T/out"
lock "$(printf '%064d' 0)" "$J"
ENGINE_LOCK="$T/lock" "$P" "$T/art" "$T/out" > "$T/e.log" 2>&1; rc=$?
ok "a wasm that is not the pin: refused (rc 2), nothing written" "$([ $rc = 2 ] && grep -q 'not the pin' "$T/e.log" && [ ! -e "$T/out/pagefeather-engine-lean.wasm" ] && echo 1 || echo 0)"
lock "$W" "$(printf '%064d' 0)"
ENGINE_LOCK="$T/lock" "$P" "$T/art" "$T/out" > "$T/e.log" 2>&1; rc=$?
ok "a loader that is not the pin: refused (rc 2)" "$([ $rc = 2 ] && grep -q 'loader' "$T/e.log" && echo 1 || echo 0)"
lock "$W" "$J" engine-lean-test php_8_3.wasm
ENGINE_LOCK="$T/lock" "$P" "$T/art" "$T/out" > "$T/e.log" 2>&1; rc=$?
ok "a published name that says PHP: refused (rc 2)" "$([ $rc = 2 ] && grep -q 'says PHP' "$T/e.log" && echo 1 || echo 0)"
lock "$W" "$J"; mkdir -p "$T/out"; : > "$T/out/stray"
ENGINE_LOCK="$T/lock" "$P" "$T/art" "$T/out" > "$T/e.log" 2>&1; rc=$?
ok "an out dir that is not empty: refused" "$([ $rc = 2 ] && grep -q 'not empty' "$T/e.log" && echo 1 || echo 0)"
rm -rf "$T/out"; mkdir -p "$T/empty"
ENGINE_LOCK="$T/lock" "$P" "$T/empty" "$T/out" > "$T/e.log" 2>&1; rc=$?
ok "an artifact dir without the two files: refused" "$([ $rc = 2 ] && grep -q 'has no 8_3_36' "$T/e.log" && echo 1 || echo 0)"
( . "$ROOT/spikes/b2-wordpress/engine.lock"; [[ "$LEAN_WASM_SHA256" =~ ^[0-9a-f]{64}$ ]] && [[ "$LEAN_JS_SHA256" =~ ^[0-9a-f]{64}$ ]] && [[ "$LEAN_BASE_URL" == */"$LEAN_TAG" ]] && [[ "$LEAN_TAG" != *[Pp][Hh][Pp]* ]] && [[ "$LEAN_WASM_ASSET$LEAN_JS_ASSET" != *[Pp][Hh][Pp]* ]] )
ok "the real engine.lock: two sha256 values, the URL named by its tag, no published name says PHP" "$([ $? = 0 ] && echo 1 || echo 0)"
echo "$fails failing case(s)"
exit $((fails > 0))
