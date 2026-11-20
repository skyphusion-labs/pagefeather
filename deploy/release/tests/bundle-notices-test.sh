#!/usr/bin/env bash
# #771: a product bundle ships the notices of the engine its build vendored. Offline: the same helper and packager
# build-bundle.sh calls (bundle-notice-set.sh, package-notices.sh), on a fake vendor/engine.mjs. #1027: with no
# PHP_ENGINE and no PF_ENGINE_JS or PF_ENGINE_WASM, approach A (deploy.sh VARIANT=a and build-bundle.sh
# BUNDLE_ENGINE=a) resolves the same pinned lean engine as b-dosql. An explicit PHP_ENGINE=npm still wins.
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
echo "4. approach A defaults to the pinned lean engine (#1027)"
# No PHP_ENGINE and no engine files: VARIANT=a and BUNDLE_ENGINE=a must ask engine.sh for the same pinned
# lean engine as b-dosql. PHP_ENGINE=npm still resolves npm and does not fetch. Curl is a stub that records
# the URL and fails, so this never fetches and never deploys. build-bundle.sh's APP is a stand-in whose
# prepare.sh only resolves the real engine.sh and exits, so opcache-a.sh never runs and no dev server starts.
lock="$ROOT/spikes/b2-wordpress/engine.lock"
lean_base=$(sed -n 's/^LEAN_BASE_URL=//p' "$lock")
lean_wasm=$(sed -n 's/^LEAN_WASM_ASSET=//p' "$lock")
lean_tag=$(sed -n 's/^LEAN_TAG=//p' "$lock")
want_fetch="engine.sh: could not fetch ${lean_base}/${lean_wasm} (the lean engine, ${lean_tag})"
fence="$T/fence"; mkdir -p "$fence" "$T/empty-cache" "$T/app"
cat > "$fence/curl" <<'EOF'
#!/bin/sh
if [ -n "${CURL_LOG:-}" ]; then printf '%s\n' "$*" >> "$CURL_LOG"; fi
exit 97
EOF
for c in terraform docker npx node wrangler; do
  printf '#!/bin/sh\necho "STUB %s called: the engine check did not stop" >&2\nexit 97\n' "$c" > "$fence/$c"
done
printf '#!/bin/sh\nexit 0\n' > "$fence/npm"
chmod +x "$fence"/*
cat > "$T/app/prepare.sh" <<EOF
#!/bin/bash
set -euo pipefail
. "$ROOT/spikes/b2-wordpress/engine.sh"
engine_resolve || exit 2
echo "RESOLVED PHP_ENGINE_RESOLVED=\${PHP_ENGINE_RESOLVED} recycle=\$(engine_recycle_mib)"
exit 2
EOF
chmod +x "$T/app/prepare.sh"
run_deploy() { # run_deploy <logfile> <env...>
  local log=$1; shift
  env -i PATH="$fence:$PATH" HOME="$T" PF_ENGINE_CACHE="$T/empty-cache" CURL_LOG="$log.curl" \
    NAME=pf-1027-engine ACCOUNT_ID=0123456789abcdef0123456789abcdef CLOUDFLARE_API_TOKEN=fake \
    "$@" bash "$ROOT/deploy/deploy.sh" >"$log" 2>&1 || true
}
run_bundle() { # run_bundle <logfile> <env...>
  local log=$1; shift
  mkdir -p "$log.dir"
  env -i PATH="$fence:$PATH" HOME="$T" PF_ENGINE_CACHE="$T/empty-cache" CURL_LOG="$log.curl" APP="$T/app" \
    "$@" bash "$ROOT/deploy/release/build-bundle.sh" "$log.dir" >"$log" 2>&1 || true
}
run_deploy "$T/dep-a" VARIANT=a
run_deploy "$T/dep-b" VARIANT=b-dosql
run_deploy "$T/dep-npm" VARIANT=a PHP_ENGINE=npm
run_bundle "$T/bun-a" BUNDLE_ENGINE=a
run_bundle "$T/bun-b" BUNDLE_ENGINE=dosql
run_bundle "$T/bun-npm" BUNDLE_ENGINE=a PHP_ENGINE=npm
fetch_line() { grep -F 'could not fetch' "$1" | head -1 || true; }
check_fetch() {
  local name=$1 file=$2 got
  got=$(fetch_line "$file")
  if [ "$got" = "$want_fetch" ]; then echo "  ok   $name"; else
    echo "  FAIL $name"
    echo "    got:  ${got:-<none>}"
    echo "    want: $want_fetch"
    res=$(grep -F 'RESOLVED PHP_ENGINE_RESOLVED=' "$file" | head -1 || true)
    [ -n "$res" ] && echo "    resolved: $res"
    echo "    last: $(tail -1 "$file")"
    fails=$((fails+1))
  fi
}
check_fetch "deploy.sh VARIANT=a, no PHP_ENGINE: the pinned lean engine" "$T/dep-a"
check_fetch "deploy.sh VARIANT=b-dosql, no PHP_ENGINE: the same pinned lean engine" "$T/dep-b"
ok "deploy.sh: variant a and b-dosql ask for the same engine" "$( [ "$(fetch_line "$T/dep-a")" = "$(fetch_line "$T/dep-b")" ] && [ -n "$(fetch_line "$T/dep-a")" ] && echo 1 || echo 0 )"
ok "deploy.sh: explicit PHP_ENGINE=npm does not fetch lean and gets past resolve" "$( ! grep -q 'could not fetch' "$T/dep-npm" && ! grep -q 'pagefeather-engine-lean' "$T/dep-npm" && grep -q 'set MYSQL_HOST' "$T/dep-npm" && echo 1 || echo 0 )"
check_fetch "build-bundle.sh BUNDLE_ENGINE=a, no PHP_ENGINE: the pinned lean engine" "$T/bun-a"
check_fetch "build-bundle.sh BUNDLE_ENGINE=dosql, no PHP_ENGINE: the same pinned lean engine" "$T/bun-b"
ok "build-bundle.sh: approach A and b-dosql ask for the same engine" "$( [ "$(fetch_line "$T/bun-a")" = "$(fetch_line "$T/bun-b")" ] && [ -n "$(fetch_line "$T/bun-a")" ] && echo 1 || echo 0 )"
ok "build-bundle.sh: explicit PHP_ENGINE=npm resolves npm, recycle 100, and does not fetch" "$( grep -q 'RESOLVED PHP_ENGINE_RESOLVED=npm recycle=100' "$T/bun-npm" && ! grep -q 'could not fetch' "$T/bun-npm" && echo 1 || echo 0 )"
echo "$fails failing case(s)"
exit $((fails > 0))
