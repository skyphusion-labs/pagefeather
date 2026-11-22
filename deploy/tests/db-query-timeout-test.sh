#!/usr/bin/env bash
# #1364: DB_QUERY_TIMEOUT_MS is a plain var on approach A. Set, it is rendered.
# Unset, it is absent (the engine keeps 30 s). A value that is not digits from
# 1 to 600000 stops the deploy and names the setting. A recorded value that a
# later deploy leaves out is refused, the same way PHP_OVERFLOW is.
#   bash deploy/tests/db-query-timeout-test.sh
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails + 1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/db-query-timeout-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
# shellcheck source=SCRIPTDIR/lib.sh
. "$ROOT/deploy/tests/lib.sh"
FENCE="$T/fence"; fence_dir "$FENCE"
APP="$ROOT/spikes/b2-wordpress"
COMPAT=$(sed -n 's/^compatibility_date = "\(.*\)"/\1/p' "$APP/wrangler.toml" | head -1)

echo "1. deploy.sh refuses a bad value before any step, and names the setting"
for bad in 0 600001 abc 1.5 -1 1e3 ' 45000' 00x; do
  refuse "DB_QUERY_TIMEOUT_MS must be an integer from 1 to 600000" VARIANT=a "DB_QUERY_TIMEOUT_MS=$bad"
done
refuse "DB_QUERY_TIMEOUT_MS is for variant a only" VARIANT=b-dosql DB_QUERY_TIMEOUT_MS=45000
refuse "DB_QUERY_TIMEOUT_MS is for variant a only" VARIANT=b-do DB_QUERY_TIMEOUT_MS=1
ok "the bounds 1 and 600000 pass a_settings_check" "$(env -i PATH="$PATH" bash -c '. "'"$ROOT"'/deploy/a-settings.sh" && DB_QUERY_TIMEOUT_MS=1 a_settings_check a && DB_QUERY_TIMEOUT_MS=600000 a_settings_check a' >/dev/null 2>&1 && echo 1 || echo 0)"
ok "unset passes a_settings_check" "$(env -i PATH="$PATH" bash -c '. "'"$ROOT"'/deploy/a-settings.sh" && a_settings_check a' >/dev/null 2>&1 && echo 1 || echo 0)"

# render <out> [VAR=value ...]: deploy.sh's variant-a config. env -i, so an
# ambient DB_QUERY_TIMEOUT_MS cannot leak in. a_settings_check runs first, as deploy.sh does.
render() {
  local dst=$1 wfp=0; shift
  local extra=()
  if [ "${1:-}" = --wfp ]; then wfp=1; shift; extra=(RENDER_WFP=1 RENDER_SCRIPT=site-pfa-render NAMESPACE=wp-wfp); fi
  # shellcheck disable=SC2016
  env -i PATH="$PATH" HOME="$T" ROOT="$ROOT" APP="$APP" COMPAT="$COMPAT" NAME=pfa-render VARIANT=a LOCATION=wnam \
    SITE_ORIGIN=https://pfa-render.example.workers.dev BUCKET=MEDIA_BUCKET AI=0 \
    PLACEMENT=aws:us-west-2 OBSERVABILITY=0 "${extra[@]}" "$@" bash -c '
      set -e
      . "$ROOT/deploy/a-settings.sh"; . "$ROOT/deploy/observability.sh"; . "$ROOT/deploy/render-conf.sh"
      out() { case "$1" in hyperdrive_id) echo HYPERDRIVE_ID ;; oc_kv_id) echo OC_KV_ID ;; *) echo "out: no stub for $1" >&2; return 1 ;; esac; }
      a_settings_check "$VARIANT"
      cd "$APP" && render_conf' > "$dst" 2> "$T/render.err"
}

echo "2. rendered when set, absent when unset (deploy.sh and deploy/wfp RENDER_WFP=1)"
render "$T/unset.toml"; rc=$?
ok "unset renders no DB_QUERY_TIMEOUT_MS (rc $rc)" "$([ $rc = 0 ] && ! grep -q 'DB_QUERY_TIMEOUT_MS' "$T/unset.toml" && echo 1 || echo 0)"
render "$T/set.toml" DB_QUERY_TIMEOUT_MS=45000; rc=$?
ok "DB_QUERY_TIMEOUT_MS=45000 renders the plain var (rc $rc)" "$([ $rc = 0 ] && grep -qx 'DB_QUERY_TIMEOUT_MS = "45000"' "$T/set.toml" && echo 1 || echo 0)"
render "$T/pad.toml" DB_QUERY_TIMEOUT_MS=00045000; rc=$?
ok "a leading zero renders the decimal value (rc $rc)" "$([ $rc = 0 ] && grep -qx 'DB_QUERY_TIMEOUT_MS = "45000"' "$T/pad.toml" && echo 1 || echo 0)"
render "$T/lo.toml" DB_QUERY_TIMEOUT_MS=1; rc=$?
ok "1 renders 1 (rc $rc)" "$([ $rc = 0 ] && grep -qx 'DB_QUERY_TIMEOUT_MS = "1"' "$T/lo.toml" && echo 1 || echo 0)"
render "$T/hi.toml" DB_QUERY_TIMEOUT_MS=600000; rc=$?
ok "600000 renders 600000 (rc $rc)" "$([ $rc = 0 ] && grep -qx 'DB_QUERY_TIMEOUT_MS = "600000"' "$T/hi.toml" && echo 1 || echo 0)"
render "$T/wfp-unset.toml" --wfp; rc=$?
ok "kind a (RENDER_WFP=1), unset: no line (rc $rc)" "$([ $rc = 0 ] && ! grep -q 'DB_QUERY_TIMEOUT_MS' "$T/wfp-unset.toml" && echo 1 || echo 0)"
render "$T/wfp-set.toml" --wfp DB_QUERY_TIMEOUT_MS=45000; rc=$?
ok "kind a (RENDER_WFP=1), set: the same plain var (rc $rc)" "$([ $rc = 0 ] && grep -qx 'DB_QUERY_TIMEOUT_MS = "45000"' "$T/wfp-set.toml" && echo 1 || echo 0)"
render "$T/bad.toml" DB_QUERY_TIMEOUT_MS=0; rc=$?
ok "a bad value stops the render and names the setting (rc $rc)" "$([ $rc != 0 ] && grep -q 'DB_QUERY_TIMEOUT_MS must be an integer from 1 to 600000' "$T/render.err" && ! grep -q 'DB_QUERY_TIMEOUT_MS' "$T/bad.toml" && echo 1 || echo 0)"

echo "3. deploy/wfp kind a checks it before any step; a b-dosql render refuses it"
WFP="$ROOT/deploy/wfp"
bad_in=$(DB_QUERY_TIMEOUT_MS=0 WFP="$WFP" bash -c '. "'"$WFP"'/kind-a.sh"; a_inputs_check' 2>&1); brc=$?
ok "a_inputs_check refuses 0 and names the setting (rc $brc)" "$([ $brc = 2 ] && grep -q 'DB_QUERY_TIMEOUT_MS must be an integer from 1 to 600000' <<<"$bad_in" && ! grep -q 'KIND=a needs' <<<"$bad_in" && echo 1 || echo 0)"
ok_in=$(DB_QUERY_TIMEOUT_MS=45000 WFP="$WFP" bash -c '. "'"$WFP"'/kind-a.sh"; a_inputs_check' 2>&1); orc=$?
ok "a_inputs_check accepts 45000 and then asks for MySQL (rc $orc)" "$([ $orc = 2 ] && grep -q 'KIND=a needs MYSQL_HOST' <<<"$ok_in" && ! grep -q 'DB_QUERY_TIMEOUT_MS must' <<<"$ok_in" && echo 1 || echo 0)"
bout=$(DB_QUERY_TIMEOUT_MS=45000 bash -c '. "'"$WFP"'/lib.sh" >/dev/null; render_user one https://wp-one.example.workers.dev' 2>&1 >/dev/null); brc=$?
ok "a b-dosql render_user refuses the setting (rc $brc)" "$([ $brc = 2 ] && grep -q 'DB_QUERY_TIMEOUT_MS is for a kind a site' <<<"$bout" && echo 1 || echo 0)"

echo "4. recorded on deploy.sh: a later run without it is refused"
# shellcheck source=../lib/recorded-inputs.sh
. "$ROOT/deploy/lib/recorded-inputs.sh"
mkdir -p "$T/bin" "$T/tf"
cat > "$T/bin/terraform" <<STUB
#!/bin/bash
case "\$1" in
  workspace) if [ "\$2" = list ]; then echo "* default"; echo "  site1"; exit 0; fi; exit 0 ;;
  output) [ -f "$T/rec" ] && { cat "$T/rec"; exit 0; }; echo "Error: Output \\"deploy_inputs\\" not found" >&2; exit 1 ;;
esac
exit 0
STUB
chmod +x "$T/bin/terraform"
record() { env -i PATH="$PATH" "$@" bash -c '. "'"$ROOT"'/deploy/lib/recorded-inputs.sh"; deploy_inputs_value'; }
check() {
  local rec=$1; shift; printf '%s' "$rec" > "$T/rec"
  env -i PATH="$T/bin:$PATH" "$@" bash -c '. "'"$ROOT"'/deploy/lib/recorded-inputs.sh"; inputs_check "'"$T/tf"'" site1' > "$T/out" 2> "$T/err"
}
ok "RECORDED_INPUTS lists DB_QUERY_TIMEOUT_MS" "$(grep -qw DB_QUERY_TIMEOUT_MS <<<"$RECORDED_INPUTS" && echo 1 || echo 0)"
A=$(record VARIANT=a LOCATION=wnam PHP_OVERFLOW=0 DB_QUERY_TIMEOUT_MS=45000)
check "$A" VARIANT=a LOCATION=wnam PHP_OVERFLOW=0; rc=$?
ok "a recorded 45000 left out on the next deploy is refused (rc $rc)" "$([ $rc = 2 ] && grep -q "DB_QUERY_TIMEOUT_MS: recorded '45000', this run ''" "$T/err" && echo 1 || echo 0)"
check "$A" VARIANT=a LOCATION=wnam PHP_OVERFLOW=0 DB_QUERY_TIMEOUT_MS=45000; rc=$?
ok "the same value on the next deploy passes (rc $rc)" "$([ $rc = 0 ] && ! grep -q 'DB_QUERY_TIMEOUT_MS:' "$T/err" && echo 1 || echo 0)"
U=$(record VARIANT=a LOCATION=wnam PHP_OVERFLOW=0)
ok "unset is not in the record" "$(printf '%s' "$U" | base64 -d | grep -q DB_QUERY_TIMEOUT_MS && echo 0 || echo 1)"

echo "5. deploy/wfp records it, keeps it, and refuses a drop"
ok "SITE_SETTINGS, site_settings.py and the update local -x list it" "$(
  (. "$WFP/lib.sh" >/dev/null 2>&1; echo " $SITE_SETTINGS ") | grep -q ' DB_QUERY_TIMEOUT_MS ' &&
  python3 -I -c 'import sys; sys.path.insert(0, sys.argv[1]); import site_settings as s; sys.exit(0 if "DB_QUERY_TIMEOUT_MS" in s.SETTINGS and "DB_QUERY_TIMEOUT_MS" in s.DROPPABLE_VARS and "DB_QUERY_TIMEOUT_MS" not in s.MEASUREMENT else 1)' "$WFP" &&
  grep -q 'DB_QUERY_TIMEOUT_MS="${DB_QUERY_TIMEOUT_MS:-}"' "$WFP/site" && echo 1 || echo 0
)"
merge_out=$(python3 -I -c 'import sys; sys.path.insert(0, sys.argv[1]); import site_settings as s
rc = s.merge({"v": 1, "settings": {"DB_QUERY_TIMEOUT_MS": "45000"}, "secrets": []}, {})
sys.exit(rc)' "$WFP" 2>"$T/merge.err")
ok "a recorded value is kept when this run does not set it" "$(grep -qx 'export DB_QUERY_TIMEOUT_MS=45000' <<<"$merge_out" && grep -q 'kept from the record' "$T/merge.err" && echo 1 || echo 0)"
printf '%s\n' 'name = "site-one"' '[vars]' 'SITE_ORIGIN = "https://x"' > "$T/conf.toml"
printf '%s\n' '[{"type":"plain_text","name":"DB_QUERY_TIMEOUT_MS","text":"45000"},{"type":"plain_text","name":"SITE_ORIGIN","text":"https://x"}]' > "$T/live.json"
printf '%s\n' '[]' > "$T/sec.json"
python3 -I -c 'import sys; sys.path.insert(0, sys.argv[1]); import site_settings as s
sys.exit(s.dropcheck(sys.argv[2], sys.argv[3], sys.argv[4], {}))' "$WFP" "$T/conf.toml" "$T/live.json" "$T/sec.json" >"$T/drop.out" 2>"$T/drop.err"; drc=$?
ok "dropping the live var is refused and names the setting (rc $drc)" "$([ $drc = 6 ] && grep -q 'DB_QUERY_TIMEOUT_MS' "$T/drop.err" && grep -q 'DROP it' "$T/drop.err" && echo 1 || echo 0)"
python3 -I -c 'import sys; sys.path.insert(0, sys.argv[1]); import site_settings as s
sys.exit(s.dropcheck(sys.argv[2], sys.argv[3], sys.argv[4], {"DROP_SETTINGS": "DB_QUERY_TIMEOUT_MS"}))' "$WFP" "$T/conf.toml" "$T/live.json" "$T/sec.json" >"$T/drop2.out" 2>"$T/drop2.err"; drc=$?
ok "DROP_SETTINGS=DB_QUERY_TIMEOUT_MS allows the drop (rc $drc)" "$([ $drc = 0 ] && echo 1 || echo 0)"

[ "$fails" = 0 ] && echo "db-query-timeout-test: all pass" || { echo "db-query-timeout-test: $fails failing check(s)"; exit 1; }
