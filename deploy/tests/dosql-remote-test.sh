#!/usr/bin/env bash
# deploy/deploy.sh VARIANT=b-dosql: the remote packs on by default, as deploy/wfp renders them (#598, #394).
# #598's live run (issuecomment-6934185301): a deploy.sh b-dosql store without the packs lost 14 of 40 post-new.php
# to memory resets; deploy/wfp's default (both packs on) lost 0 of 40. The rule is ONE file, deploy/lib/remote-packs.sh.
# 1. The settings: b-dosql accepts OPCACHE_REMOTE and SITE_REMOTE (0 or 1); b-do and c1 refuse them; bad values refuse.
# 2. The default: deploy.sh applies remote_pack_defaults on b-dosql, after the settings check and before the build.
# 3. The render: b-dosql with the packs renders /_pf/ first and both vars; with 0, none; b-do, none.
# 4. The guard: deploy.sh runs remote_assets_check.py on b-dosql, and a packed b-dosql config without /_pf/ first fails.
# 5. The build: remote_pack_build runs the trace and both pack steps in order, nothing when off, and stops on a failure;
#    deploy.sh's b-dosql branch runs it after opcache, status checked, and build.sh is not piped.
# shellcheck disable=SC2016  # the greps and awk programs match deploy.sh's literal $VARIANT and $WOO_ACTIVE text
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/dosql-remote-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
# shellcheck source=SCRIPTDIR/lib.sh
. "$ROOT/deploy/tests/lib.sh"   # refuse, behind the fence
FENCE="$T/fence"; fence_dir "$FENCE"
D="$ROOT/deploy/deploy.sh"; S="$ROOT/deploy/a-settings.sh"; L="$ROOT/deploy/lib/remote-packs.sh"
APP="$ROOT/spikes/b2-wordpress"
line() { grep -nE "$2" "$1" | head -1 | cut -d: -f1; }   # line <file> <ERE>: the first matching line number, or empty

echo "1. the settings"
chk() { env -i PATH="$PATH" "$@" bash -c ". '$S' && a_settings_check b-dosql" >/dev/null 2>&1 && echo 1 || echo 0; }
ok "b-dosql accepts OPCACHE_REMOTE=1 SITE_REMOTE=1" "$(chk OPCACHE_REMOTE=1 SITE_REMOTE=1)"
ok "b-dosql accepts OPCACHE_REMOTE=1 alone" "$(chk OPCACHE_REMOTE=1)"
ok "b-dosql accepts OPCACHE_REMOTE=0 SITE_REMOTE=0 (the opt-out)" "$(chk OPCACHE_REMOTE=0 SITE_REMOTE=0)"
ok "b-dosql accepts no setting" "$(chk)"
refuse "OPCACHE_REMOTE must be 0 or 1" VARIANT=b-dosql OPCACHE_REMOTE=2
refuse "OPCACHE_REMOTE must be 0 or 1" VARIANT=b-dosql OPCACHE_REMOTE=on
refuse "SITE_REMOTE must be 0 or 1" VARIANT=b-dosql OPCACHE_REMOTE=1 SITE_REMOTE=yes
refuse "SITE_REMOTE=1 needs OPCACHE_REMOTE=1" VARIANT=b-dosql OPCACHE_REMOTE=0 SITE_REMOTE=1
refuse "OPCACHE_REMOTE is for variant a or b-dosql only" VARIANT=b-do OPCACHE_REMOTE=1
refuse "SITE_REMOTE is for variant a or b-dosql only" VARIANT=c1 SITE_REMOTE=1
refuse "OPCACHE_A is for variant a only" VARIANT=b-dosql OPCACHE_A=1

echo "2. the default (deploy/lib/remote-packs.sh remote_pack_defaults, applied by deploy.sh on b-dosql)"
dflt() { env -i PATH="$PATH" "$@" bash -c ". '$L' && remote_pack_defaults && echo \"\$OPCACHE_REMOTE \$SITE_REMOTE\""; }
ok "unset: both on" "$([ "$(dflt)" = "1 1" ] && echo 1 || echo 0)"
ok "OPCACHE_REMOTE=0: both off (SITE_REMOTE follows)" "$([ "$(dflt OPCACHE_REMOTE=0)" = "0 0" ] && echo 1 || echo 0)"
ok "OPCACHE_REMOTE=1 SITE_REMOTE=0: kept" "$([ "$(dflt OPCACHE_REMOTE=1 SITE_REMOTE=0)" = "1 0" ] && echo 1 || echo 0)"
chkl=$(line "$D" '^a_settings_check "\$VARIANT"'); defl=$(line "$D" '^\[ "\$VARIANT" != b-dosql \] \|\| remote_pack_defaults$')
buildl=$(line "$D" '^log "build"$'); renl=$(line "$D" '^render_conf > "\$CONF"$')
ok "deploy.sh applies remote_pack_defaults on b-dosql after the settings check, before the build and the render (lines $chkl < ${defl:-none} < $buildl < $renl)" \
  "$([ -n "$defl" ] && [ "$chkl" -lt "$defl" ] && [ "$defl" -lt "$buildl" ] && [ "$defl" -lt "$renl" ] && echo 1 || echo 0)"
ok "deploy/a-settings.sh (which deploy.sh sources) sources deploy/lib/remote-packs.sh" "$(grep -qE '^\. .*/lib/remote-packs\.sh"' "$S" && grep -qE '^\. "\$ROOT/deploy/a-settings\.sh"' "$D" && echo 1 || echo 0)"
ok "deploy/wfp/lib.sh sources the same file and defines none of its functions itself" \
  "$(grep -qF '. "$WFP/../lib/remote-packs.sh"' "$ROOT/deploy/wfp/lib.sh" && ! grep -qE '^(opcache_remote_var|site_remote_var|remote_pack_defaults|remote_pack_build)\(\)' "$ROOT/deploy/wfp/lib.sh" && echo 1 || echo 0)"

echo "3. the render (deploy/render-conf.sh, a stub out(), no Terraform)"
COMPAT=$(sed -n 's/^compatibility_date = "\(.*\)"/\1/p' "$APP/wrangler.toml" | head -1)
render() { # render <out.toml> <variant> [VAR=value ...]
  local dst=$1 v=$2; shift 2
  # shellcheck disable=SC2016  # the script expands in the child shell, from the env -i values
  env -i PATH="$PATH" HOME="$T" ROOT="$ROOT" APP="$APP" COMPAT="$COMPAT" NAME=pf-render VARIANT="$v" LOCATION=enam \
    SITE_ORIGIN=https://pf-render.example.workers.dev BUCKET= AI=0 WOO_ACTIVE=1 "$@" bash -c '
      set -e
      . "$ROOT/deploy/a-settings.sh"; . "$ROOT/deploy/observability.sh"; . "$ROOT/deploy/render-conf.sh"
      out() { echo "OUT_$1"; }
      a_settings_check "$VARIANT"
      [ "$VARIANT" != b-dosql ] || remote_pack_defaults
      cd "$APP" && render_conf' > "$dst" 2> "$dst.err"
}
sect() { # sect <toml> <table.key>: the value as Python prints it, or None. A line parser (no tomllib: macOS python3 is
  # 3.9): [table] headers, key = value lines, values read with ast.literal_eval (strings and string arrays only).
  python3 -I -c 'import ast, re, sys
want_t, want_k = sys.argv[2].rsplit(".", 1); t = ""; v = None
for ln in open(sys.argv[1]):
    ln = ln.strip()
    m = re.fullmatch(r"\[([A-Za-z0-9_.]+)\]", ln)
    if m: t = m.group(1); continue
    m = re.fullmatch(r"([A-Za-z0-9_]+)\s*=\s*(.+)", ln)
    if m and t == want_t and m.group(1) == want_k:
        try: v = ast.literal_eval(m.group(2))
        except (ValueError, SyntaxError): v = m.group(2)
print(v)' "$1" "$2"; }
dupes() { # dupes <toml>: the (table, key) pairs set twice, one per line (none in a valid render)
  python3 -I -c 'import re, sys, collections
t = ""; c = collections.Counter()
for ln in open(sys.argv[1]):
    ln = ln.strip()
    if re.fullmatch(r"\[\[.+\]\]", ln): t = ln + str(sum(c.values())); continue
    m = re.fullmatch(r"\[([A-Za-z0-9_.]+)\]", ln)
    if m: t = m.group(1); continue
    m = re.fullmatch(r"([A-Za-z0-9_]+)\s*=.*", ln)
    if m: c[(t, m.group(1))] += 1
for k, n in c.items():
    if n > 1: print(k)' "$1"; }
render "$T/def.toml" b-dosql; rc=$?
ok "b-dosql, no setting: render_conf ran (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"; [ $rc = 0 ] || cat "$T/def.toml.err"
ok "  [assets] run_worker_first is [\"/_pf/*\"]" "$([ "$(sect "$T/def.toml" assets.run_worker_first)" = "['/_pf/*']" ] && echo 1 || echo 0)"
ok "  [assets] binds ASSETS" "$([ "$(sect "$T/def.toml" assets.binding)" = ASSETS ] && echo 1 || echo 0)"
ok "  vars OPCACHE_REMOTE = on" "$([ "$(sect "$T/def.toml" vars.OPCACHE_REMOTE)" = on ] && echo 1 || echo 0)"
ok "  vars SITE_REMOTE = on" "$([ "$(sect "$T/def.toml" vars.SITE_REMOTE)" = on ] && echo 1 || echo 0)"
render "$T/off.toml" b-dosql OPCACHE_REMOTE=0; rc=$?
ok "b-dosql OPCACHE_REMOTE=0: rendered (rc $rc), no /_pf/ first and neither var" \
  "$([ $rc = 0 ] && [ "$(sect "$T/off.toml" assets.run_worker_first)" = None ] && [ "$(sect "$T/off.toml" vars.OPCACHE_REMOTE)" = None ] && [ "$(sect "$T/off.toml" vars.SITE_REMOTE)" = None ] && echo 1 || echo 0)"
render "$T/oc.toml" b-dosql OPCACHE_REMOTE=1 SITE_REMOTE=0; rc=$?
ok "b-dosql OPCACHE_REMOTE=1 SITE_REMOTE=0: /_pf/ first and OPCACHE_REMOTE only (rc $rc)" \
  "$([ $rc = 0 ] && [ "$(sect "$T/oc.toml" assets.run_worker_first)" = "['/_pf/*']" ] && [ "$(sect "$T/oc.toml" vars.OPCACHE_REMOTE)" = on ] && [ "$(sect "$T/oc.toml" vars.SITE_REMOTE)" = None ] && echo 1 || echo 0)"
render "$T/bdo.toml" b-do; rc=$?
ok "b-do, no setting: no /_pf/ first and neither var (rc $rc)" \
  "$([ $rc = 0 ] && [ "$(sect "$T/bdo.toml" assets.run_worker_first)" = None ] && [ "$(sect "$T/bdo.toml" vars.OPCACHE_REMOTE)" = None ] && echo 1 || echo 0)"
ok "the default render sets no key twice in a table" "$([ -s "$T/def.toml" ] && [ -z "$(dupes "$T/def.toml")" ] && echo 1 || echo 0)"

echo "4. the guard (deploy/wfp/remote_assets_check.py) on b-dosql"
RB="$T/rapp"; mkdir -p "$RB/build"
echo 'export default {"id":"t","packs":[],"files":{}};' > "$RB/build/opcache-remote-index.js"
echo 'export default {"id":"t","hot":null,"packs":[],"files":{},"dirs":[],"selfcheck":["index.php",1,"x"]};' > "$RB/build/site-remote-index.js"
python3 -I "$ROOT/deploy/wfp/remote_assets_check.py" "$T/def.toml" "$RB" 2>"$T/g1.err"; rc=$?
ok "the default b-dosql config over a packed build passes (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"
grep -v '^run_worker_first' "$T/def.toml" > "$T/nofirst.toml"
python3 -I "$ROOT/deploy/wfp/remote_assets_check.py" "$T/nofirst.toml" "$RB" 2>"$T/g2.err"; rc=$?
ok "the control: the same config without /_pf/ first is REFUSED (rc $rc)" "$([ $rc = 2 ] && echo 1 || echo 0)"
python3 -I "$ROOT/deploy/wfp/remote_assets_check.py" "$T/off.toml" "$RB" 2>"$T/g3.err"; rc=$?
ok "the control: an OPCACHE_REMOTE=0 config over a packed build is REFUSED (rc $rc)" "$([ $rc = 2 ] && echo 1 || echo 0)"
gl=$(line "$D" '^  python3 -I .*remote_assets_check\.py'); gc=$(awk -v g="$gl" 'NR < g && /^if / {c=$0} END {print c}' "$D")
ok "deploy.sh runs the guard on b-dosql too (its condition: ${gc:-none})" "$(grep -q 'b-dosql' <<<"$gc" && grep -q '"\$VARIANT" = a' <<<"$gc" && echo 1 || echo 0)"

echo "5. the build (remote_pack_build, stubbed steps)"
B="$T/bapp"; mkdir -p "$B/build"
printf '#!/bin/sh\necho "file-trace WOO_ACTIVE=$WOO_ACTIVE DEV_ENV=$DEV_ENV" >> "$CALLS"\n' > "$B/file-trace.sh"; chmod +x "$B/file-trace.sh"
for p in opcache-split opcache-remote site-remote; do
  printf 'import os, sys\nopen(os.environ["CALLS"], "a").write("%s " + " ".join(sys.argv[1:]) + "\\n")\nsys.exit(int(os.environ.get("FAIL_%s", "0")))\n' "$p" "${p//-/_}" > "$B/$p.py"
done
pb() { : > "$T/calls"; env -i PATH="$PATH" CALLS="$T/calls" "$@" bash -c ". '$L' && cd '$B' && remote_pack_build 1" > "$T/pb.out" 2>&1; echo $?; }
rc=$(pb OPCACHE_REMOTE=1 SITE_REMOTE=1)
ok "both on: rc $rc; file-trace (WOO_ACTIVE=1, dosql-local), opcache-remote, site-remote, in that order" \
  "$([ "$rc" = 0 ] && [ "$(cut -d' ' -f1-3 "$T/calls" | tr '\n' '|')" = "file-trace WOO_ACTIVE=1 DEV_ENV=dosql-local|opcache-remote build/opcache.zip build/file-trace.json|site-remote build/site.zip build/file-trace.json|" ] && echo 1 || echo 0)"
rc=$(pb OPCACHE_REMOTE=0 SITE_REMOTE=0)
ok "both off: rc $rc, no step runs" "$([ "$rc" = 0 ] && [ ! -s "$T/calls" ] && echo 1 || echo 0)"
rc=$(pb OPCACHE_REMOTE=1 SITE_REMOTE=1 FAIL_opcache_remote=1)
ok "a failing opcache-remote.py: rc $rc (not 0), and site-remote.py never runs" "$([ "$rc" != 0 ] && ! grep -q '^site-remote' "$T/calls" && echo 1 || echo 0)"
rc=$(pb OPCACHE_REMOTE=0 SITE_REMOTE=1)
ok "SITE_REMOTE=1 without OPCACHE_REMOTE: rc $rc (not 0), no step runs" "$([ "$rc" != 0 ] && [ ! -s "$T/calls" ] && echo 1 || echo 0)"
bb=$(awk '/^if \[ "\$VARIANT" = b-do \] \|\| \[ "\$VARIANT" = b-dosql \]; then$/ {f=1; next} f && /^elif / {exit} f' "$D")
ok "deploy.sh b-dosql runs remote_pack_build after opcache, status checked" \
  "$(awk '/DEV_ENV=.* opcache/ {o=NR} /remote_pack_build "\$WOO_ACTIVE"/ {r=NR; l=$0} END {print (o && r && r > o && l ~ /\|\| exit 1/) ? 1 : 0}' <<<"$bb")"
ok "deploy.sh b-do/b-dosql does not pipe build.sh (#464: a pipe takes tail's status)" "$(grep -qE '\./build\.sh \|' <<<"$bb" && echo 0 || echo 1)"

echo "$fails failing case(s)"
[ "$fails" = 0 ]
