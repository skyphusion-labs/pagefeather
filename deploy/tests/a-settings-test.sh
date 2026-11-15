#!/usr/bin/env bash
# deploy/deploy.sh variant a: the #394 admin fixes behind settings (deploy/a-settings.sh).
# 1. The refusals fire through deploy.sh itself, before any Terraform, build or deploy step
#    (env -i and a fake token, as code-only-test.sh: a case that got past its refusal would fail).
# 2. The rendered [vars] and [assets] lines, defaults first: no setting renders nothing.
# 3. The rendered config passes remote_assets_check.py with a remote build, and the same config
#    WITHOUT the a_assets_first line is refused (the guard deploy.sh runs before the upload).
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/a-settings-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
# A fence: a case that gets past its refusal stops at the first real step, never runs it. The stubs
# shadow terraform, curl, docker and npm; deploy.sh reaches one of them before anything is built or sent.
STUB="$T/stub"; mkdir -p "$STUB"
for c in terraform curl docker npm; do printf '#!/bin/sh\necho "STUB %s called: a refusal did not fire" >&2\nexit 97\n' "$c" > "$STUB/$c"; chmod +x "$STUB/$c"; done
refuse() { # refuse <expected text> <VAR=value...>
  local want=$1; shift
  local out rc
  out=$(env -i PATH="$STUB:$PATH" HOME="$HOME" NAME=zarapo ACCOUNT_ID=0123456789abcdef0123456789abcdef CLOUDFLARE_API_TOKEN=fake "$@" bash "$ROOT/deploy/deploy.sh" 2>&1); rc=$?
  if [ "$rc" = 2 ] && grep -qF "$want" <<<"$out" && ! grep -qE '^== (terraform|build|deploy)' <<<"$out"; then echo "  ok   refuses: $want ($*)"
  else echo "  FAIL expected exit 2 with '$want' before any step ($*; rc=$rc): $(tail -1 <<<"$out")"; fails=$((fails+1)); fi
}
echo "1. refusals through deploy.sh"
refuse "OPCACHE_A is for variant a only" VARIANT=b-dosql OPCACHE_A=1
refuse "OPCACHE_REMOTE is for variant a only" VARIANT=b-dosql OPCACHE_REMOTE=1
refuse "SITE_REMOTE is for variant a only" VARIANT=b-do SITE_REMOTE=1
refuse "RECYCLE_WASM_MIB is for variant a only" VARIANT=b-dosql RECYCLE_WASM_MIB=140
for bad in 2 on d1 yes; do refuse "OPCACHE_A must be 0 or 1" VARIANT=a OPCACHE_A=$bad; done
for bad in 2 on yes; do refuse "OPCACHE_REMOTE must be 0 or 1" VARIANT=a OPCACHE_A=1 OPCACHE_REMOTE=$bad; done
refuse "SITE_REMOTE must be 0 or 1" VARIANT=a OPCACHE_A=1 OPCACHE_REMOTE=1 SITE_REMOTE=on
refuse "SITE_REMOTE=1 needs OPCACHE_REMOTE=1" VARIANT=a OPCACHE_A=1 SITE_REMOTE=1
refuse "OPCACHE_REMOTE=1 on variant a needs OPCACHE_A=1" VARIANT=a OPCACHE_REMOTE=1
refuse "OPCACHE_REMOTE=1 on variant a needs OPCACHE_A=1" VARIANT=a OPCACHE_A=0 OPCACHE_REMOTE=1
for bad in 63 241 0 12.5 abc -100 1000 ' 140'; do refuse "RECYCLE_WASM_MIB must be an integer from 64 to 240" VARIANT=a "RECYCLE_WASM_MIB=$bad"; done
: > "$T/engine.js"; printf 'x' > "$T/engine.wasm"
refuse "PF_ENGINE_JS and PF_ENGINE_WASM: set both or neither" VARIANT=a PF_ENGINE_JS="$T/engine.js"
refuse "PF_ENGINE_JS and PF_ENGINE_WASM: set both or neither" VARIANT=b-dosql PF_ENGINE_WASM="$T/engine.wasm"
refuse "PF_ENGINE_JS is not a file with content" VARIANT=a PF_ENGINE_JS="$T/engine.js" PF_ENGINE_WASM="$T/engine.wasm"
refuse "PF_ENGINE_WASM is not a file with content" VARIANT=a PF_ENGINE_JS="$T/engine.wasm" PF_ENGINE_WASM="$T/missing.wasm"

echo "2. the rendered lines (deploy/a-settings.sh)"
S="$ROOT/deploy/a-settings.sh"
r() { env -i PATH="$PATH" "$@" bash -c ". '$S' && a_vars && echo --- && a_assets_first" 2>&1; }
ok "no setting renders nothing" "$([ "$(r)" = '---' ] && echo 1 || echo 0)"
ok "OPCACHE_REMOTE=0 SITE_REMOTE=0 renders nothing" "$([ "$(r OPCACHE_REMOTE=0 SITE_REMOTE=0)" = '---' ] && echo 1 || echo 0)"
ok "OPCACHE_REMOTE=1: the var, and /_pf/ first" "$([ "$(r OPCACHE_REMOTE=1)" = "$(printf 'OPCACHE_REMOTE = "on"\n---\nrun_worker_first = ["/_pf/*"]')" ] && echo 1 || echo 0)"
ok "OPCACHE_REMOTE=1 SITE_REMOTE=1: both vars, and /_pf/ first" "$([ "$(r OPCACHE_REMOTE=1 SITE_REMOTE=1)" = "$(printf 'OPCACHE_REMOTE = "on"\nSITE_REMOTE = "on"\n---\nrun_worker_first = ["/_pf/*"]')" ] && echo 1 || echo 0)"
ok "RECYCLE_WASM_MIB=140 renders it as a string" "$([ "$(r RECYCLE_WASM_MIB=140)" = "$(printf 'RECYCLE_WASM_MIB = "140"\n---')" ] && echo 1 || echo 0)"
ok "RECYCLE_WASM_MIB=064 renders 64 (base 10, not octal)" "$([ "$(r RECYCLE_WASM_MIB=064)" = "$(printf 'RECYCLE_WASM_MIB = "64"\n---')" ] && echo 1 || echo 0)"
ok "the bounds 64 and 240 pass the check" "$(env -i PATH="$PATH" bash -c ". '$S' && RECYCLE_WASM_MIB=64 a_settings_check a && RECYCLE_WASM_MIB=240 a_settings_check a" >/dev/null 2>&1 && echo 1 || echo 0)"
ok "no setting passes the check on every variant" "$(env -i PATH="$PATH" bash -c ". '$S' && for v in a b-do b-dosql c1; do a_settings_check \$v || exit 1; done" >/dev/null 2>&1 && echo 1 || echo 0)"
ok "the lean engine pair passes the check" "$(env -i PATH="$PATH" PF_ENGINE_JS="$T/engine.wasm" PF_ENGINE_WASM="$T/engine.wasm" bash -c ". '$S' && a_settings_check a" >/dev/null 2>&1 && echo 1 || echo 0)"

echo "2b. an empty or unreadable primed cache fails (a_opcache_count; from #625, rollins-sb1114l)"
cnt() { env -i PATH="$PATH" bash -c ". '$S' && a_opcache_count '$1'" 2>&1; }
python3 -I -c 'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1], "w"); [z.writestr("a%d.php.bin" % i, "x") for i in range(3)]; z.close()' "$T/oc3.zip"
python3 -I -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1], "w").close()' "$T/oc0.zip"
printf 'not a zip' > "$T/ocbad.zip"
out=$(cnt "$T/oc3.zip"); rc=$?
ok "a primed cache passes and says how many scripts (rc $rc)" "$([ $rc = 0 ] && grep -qF '3 compiled scripts' <<<"$out" && echo 1 || echo 0)"
out=$(cnt "$T/oc0.zip"); rc=$?
ok "an empty cache fails (rc $rc)" "$([ $rc != 0 ] && grep -qF '0 compiled scripts' <<<"$out" && echo 1 || echo 0)"
out=$(cnt "$T/ocbad.zip"); rc=$?
ok "an unreadable cache fails (rc $rc)" "$([ $rc != 0 ] && grep -qF 'not a readable zip' <<<"$out" && echo 1 || echo 0)"
out=$(cnt "$T/missing.zip"); rc=$?
ok "a missing cache fails (rc $rc)" "$([ $rc != 0 ] && grep -qF 'not a readable zip' <<<"$out" && echo 1 || echo 0)"
ok "deploy.sh counts the cache right after opcache-a.sh" "$(awk '/opcache-a.sh > "\$ALOG"/ {a=NR} /a_opcache_count build\/opcache.zip/ {c=NR} END {print (a && c && c > a && c - a < 6) ? 1 : 0}' "$ROOT/deploy/deploy.sh")"

echo "3. the rendered config against remote_assets_check.py"
APP="$T/app"; mkdir -p "$APP/build"
echo 'export default {"id":"t","packs":[],"files":{}};' > "$APP/build/opcache-remote-index.js"
echo 'export default {"id":"t","hot":null,"packs":[],"files":{},"dirs":[],"selfcheck":["index.php",1,"x"]};' > "$APP/build/site-remote-index.js"
conf() { # conf <with first: 1|0>: the [assets] and [vars] blocks as deploy.sh writes them
  env -i PATH="$PATH" OPCACHE_REMOTE=1 SITE_REMOTE=1 bash -c ". '$S'
    echo '[assets]'; echo 'directory = \"build/public\"'; echo 'binding = \"ASSETS\"'; echo 'not_found_handling = \"none\"'
    [ $1 = 0 ] || a_assets_first
    echo '[vars]'; echo 'SITE_ORIGIN = \"https://zarapo.example.workers.dev\"'; a_vars"
}
conf 1 > "$T/on.toml"; conf 0 > "$T/nofirst.toml"
python3 -I "$ROOT/deploy/wfp/remote_assets_check.py" "$T/on.toml" "$APP" 2>"$T/on.err"; rc=$?
ok "a remote A config passes the guard (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"
python3 -I "$ROOT/deploy/wfp/remote_assets_check.py" "$T/nofirst.toml" "$APP" 2>"$T/nofirst.err"; rc=$?
ok "the control: the same config without /_pf/ first is REFUSED (rc $rc)" "$([ $rc = 2 ] && grep -q run_worker_first "$T/nofirst.err" && echo 1 || echo 0)"
ok "deploy.sh runs the guard on variant a before the deploy" "$(awk '/remote_assets_check.py/ {g=NR} /^DEP=.*deploy --config/ {d=NR} END {print (g && d && g < d) ? 1 : 0}' "$ROOT/deploy/deploy.sh")"

echo "$fails failing case(s)"
[ "$fails" = 0 ]
