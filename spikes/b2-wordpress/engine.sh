# shellcheck shell=bash
# The PHP engine a build uses (#771). Sourced by prepare.sh, build-id.sh and the deploy scripts, so every one of
# them agrees. engine_resolve sets PF_ENGINE_JS and PF_ENGINE_WASM (the files prepare.sh vendors), or unsets both for
# npm, and PHP_ENGINE_RESOLVED (lean, npm or custom). Then everything after it (build-id.sh's -e tag, deploy/wfp's
# engine record and refusal, #642) works as before, on the files it names.
#   PF_ENGINE_JS and PF_ENGINE_WASM set   those files, as given. Both or neither. lean when they are the pinned pair
#                                         (a deploy script resolves once and exports them), custom otherwise.
#   PHP_ENGINE=npm                        the pinned @php-wasm/web-8-3 package engine in node_modules.
#   PHP_ENGINE unset or lean              the DEFAULT: the lean engine pinned in engine.lock, fetched once into
#                                         PF_ENGINE_CACHE (default ~/.cache/pagefeather-engine), by hash. A file
#                                         whose sha256 is not the pin is refused and removed, never used.
# PF_ENGINE_BASE_URL overrides engine.lock's LEAN_BASE_URL (tests; a mirror). The pin itself cannot be overridden.
# Test: spikes/b2-wordpress/tests/engine-resolve-test.sh.

engine_sha256() { { sha256sum "$1" 2>/dev/null || shasum -a 256 "$1"; } | cut -d' ' -f1; }

engine_resolve() {
  local here lock cache f want got url
  if [ -n "${PF_ENGINE_JS:-}${PF_ENGINE_WASM:-}" ]; then
    [ -n "${PF_ENGINE_JS:-}" ] && [ -n "${PF_ENGINE_WASM:-}" ] || { echo "PF_ENGINE_JS and PF_ENGINE_WASM: set both or neither" >&2; return 2; }
    [ -s "$PF_ENGINE_JS" ] && [ -s "$PF_ENGINE_WASM" ] || { echo "an engine file is missing or empty: $PF_ENGINE_JS $PF_ENGINE_WASM" >&2; return 2; }
    [ "${PHP_ENGINE:-}" != npm ] || { echo "PHP_ENGINE=npm and PF_ENGINE_JS/PF_ENGINE_WASM: choose one" >&2; return 2; }
    # Files that ARE the pinned pair are the lean engine (a deploy script resolves once and exports them).
    local name=custom lk
    lk="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/engine.lock"
    if [ -s "$lk" ] && [ "$(engine_sha256 "$PF_ENGINE_WASM")" = "$(sed -n 's/^LEAN_WASM_SHA256=//p' "$lk")" ] \
       && [ "$(engine_sha256 "$PF_ENGINE_JS")" = "$(sed -n 's/^LEAN_JS_SHA256=//p' "$lk")" ]; then name=lean; fi
    export PF_ENGINE_JS PF_ENGINE_WASM PHP_ENGINE_RESOLVED=$name
    return 0
  fi
  case "${PHP_ENGINE:-}" in
    npm) unset PF_ENGINE_JS PF_ENGINE_WASM; export PHP_ENGINE_RESOLVED=npm; return 0 ;;
    ''|lean) ;;
    *) echo "PHP_ENGINE must be lean or npm, not ${PHP_ENGINE}" >&2; return 2 ;;
  esac
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  lock="$here/engine.lock"
  [ -s "$lock" ] || { echo "engine.sh: $lock is missing" >&2; return 2; }
  local PHP_ENGINE_DEFAULT LEAN_TAG LEAN_BASE_URL LEAN_WASM_SHA256 LEAN_JS_SHA256
  # shellcheck disable=SC1090
  . "$lock"
  [[ "$LEAN_WASM_SHA256" =~ ^[0-9a-f]{64}$ ]] && [[ "$LEAN_JS_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "engine.lock: the two sha256 values are not 64 hex" >&2; return 2; }
  url=${PF_ENGINE_BASE_URL:-$LEAN_BASE_URL}
  cache="${PF_ENGINE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/pagefeather-engine}/$LEAN_WASM_SHA256-${LEAN_JS_SHA256:0:16}"
  mkdir -p "$cache" || return 2
  for f in php_8_3.wasm php_8_3.js; do
    if [ "$f" = php_8_3.wasm ]; then want=$LEAN_WASM_SHA256; else want=$LEAN_JS_SHA256; fi
    if [ -s "$cache/$f" ] && [ "$(engine_sha256 "$cache/$f")" = "$want" ]; then continue; fi
    rm -f "$cache/$f" "$cache/$f.part"
    curl -fsSL --retry 3 --retry-delay 2 -o "$cache/$f.part" "$url/$f" || { rm -f "$cache/$f.part"; echo "engine.sh: could not fetch $url/$f (the lean engine, $LEAN_TAG)" >&2; return 2; }
    got=$(engine_sha256 "$cache/$f.part")
    [ "$got" = "$want" ] || { rm -f "$cache/$f.part"; echo "engine.sh: $f from $url has sha256 $got, not the pin $want; refused" >&2; return 2; }
    mv "$cache/$f.part" "$cache/$f"
  done
  export PF_ENGINE_WASM="$cache/php_8_3.wasm" PF_ENGINE_JS="$cache/php_8_3.js" PHP_ENGINE_RESOLVED=lean
}

# engine_recycle_mib: the engine's own default recycle line (#771): 140 on lean and on a custom pagefeather build,
# 100 on npm (#598, #602). An explicit RECYCLE_WASM_MIB on the site still wins (recycle-line.mjs).
engine_recycle_mib() { if [ "${PHP_ENGINE_RESOLVED:-}" = npm ]; then echo 100; else echo 140; fi; }
