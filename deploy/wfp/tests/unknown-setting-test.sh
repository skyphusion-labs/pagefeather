#!/bin/bash
# #1285: an unknown key in _build/settings.json stops deploy/wfp and names the key.
# REPLACE_INPUTS=1 drops those keys and names each one. A known key is kept as today.
# The record is written again only after merge exits 0, which is the same order as
# keep_settings and then record_settings. A stop leaves the file as it was.
#   bash deploy/wfp/tests/unknown-setting-test.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../../.." && pwd)
SS="$HERE/../site_settings.py"
T=$(mktemp -d "${TMPDIR:-/tmp}/unknown-setting-test.XXXXXX"); trap 'rm -rf "${T:?}"' EXIT
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails + 1)); fi; }

# write_rec <path> <json>
write_rec() { printf '%s' "$2" > "$1"; }

# run_merge <record path>: merge, and on exit 0 write the new record the way a good update does.
# Prints nothing. Leaves rc in $T/rc, merge stderr in $T/err, merge stdout in $T/out.
run_merge() {
  local rc=0 out
  out=$(python3 -I "$SS" merge "$1" 2>"$T/err") || rc=$?
  printf '%s' "$out" > "$T/out"
  printf '%s' "$rc" > "$T/rc"
  if [ "$rc" = 0 ]; then
    env -i PATH="$PATH" bash -c 'eval "$1"; exec python3 -I "$2" env-json' _ "$out" "$SS" > "$T/new.json"
    cp "$T/new.json" "$1"
  fi
}

has() { grep -q "$1" "$T/err" && echo 1 || echo 0; }
lacks() { grep -q "$1" "$T/err" && echo 0 || echo 1; }

# 1. Unknown keys stop the deploy. The file still holds them, and the known key.
write_rec "$T/stop.json" '{"secrets":[],"settings":{"FUTURE_SETTING":"keep-me","MAIL_ALLOWED_TO":"ops@example.com","NEXT_SETTING":"also"},"v":1}'
cp "$T/stop.json" "$T/stop.before"
run_merge "$T/stop.json"
rc=$(cat "$T/rc")
ok "#1285 deploy/wfp: an unknown key stops the deploy and the record keeps it (rc $rc)" \
  "$([ "$rc" != 0 ] && [ "$(has 'FUTURE_SETTING')" = 1 ] && [ "$(has 'NEXT_SETTING')" = 1 ] && [ "$(has 'not a known setting')" = 1 ] && [ "$(lacks ignored)" = 1 ] && cmp -s "$T/stop.before" "$T/stop.json" && echo 1 || echo 0)"

# 2. REPLACE_INPUTS=1 proceeds, names each dropped key, and the known key stays in the new record.
write_rec "$T/drop.json" '{"secrets":[],"settings":{"FUTURE_SETTING":"keep-me","MAIL_ALLOWED_TO":"ops@example.com","NEXT_SETTING":"also"},"v":1}'
REPLACE_INPUTS=1 run_merge "$T/drop.json"
rc=$(cat "$T/rc")
ok "#1285 deploy/wfp: REPLACE_INPUTS=1 drops the unknown keys and names them (rc $rc)" \
  "$([ "$rc" = 0 ] && [ "$(has 'dropped unknown setting FUTURE_SETTING')" = 1 ] && [ "$(has 'dropped unknown setting NEXT_SETTING')" = 1 ] && [ "$(lacks ignored)" = 1 ] && python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); s=d["settings"]; raise SystemExit(0 if s.get("MAIL_ALLOWED_TO")=="ops@example.com" and "FUTURE_SETTING" not in s and "NEXT_SETTING" not in s else 1)' "$T/drop.json" && echo 1 || echo 0)"
unset REPLACE_INPUTS

# A later refusal (a missing secret) must not say the key was dropped. The file stays whole.
write_rec "$T/secret.json" '{"secrets":["TURNSTILE_SECRET"],"settings":{"FUTURE_SETTING":"keep-me","MAIL_ALLOWED_TO":"ops@example.com"},"v":1}'
cp "$T/secret.json" "$T/secret.before"
REPLACE_INPUTS=1 run_merge "$T/secret.json"
rc=$(cat "$T/rc")
ok "#1285 deploy/wfp: a refused run does not say it dropped the unknown key (rc $rc)" \
  "$([ "$rc" != 0 ] && [ "$(has 'required secret')" = 1 ] && [ "$(lacks 'dropped unknown')" = 1 ] && cmp -s "$T/secret.before" "$T/secret.json" && echo 1 || echo 0)"
unset REPLACE_INPUTS

# 3. A known key, with no unknown key, is kept as today: the export, the log line, and the record.
write_rec "$T/known.json" '{"secrets":[],"settings":{"MAIL_ALLOWED_TO":"ops@example.com"},"v":1}'
run_merge "$T/known.json"
rc=$(cat "$T/rc")
ok "#1285 deploy/wfp: a known key is kept as today (rc $rc)" \
  "$([ "$rc" = 0 ] && grep -q 'MAIL_ALLOWED_TO kept from the record' "$T/err" && grep -q 'ops@example.com' "$T/out" && [ "$(lacks 'not a known setting')" = 1 ] && [ "$(lacks 'dropped unknown')" = 1 ] && python3 -I -c 'import json,sys; s=json.load(open(sys.argv[1]))["settings"]; raise SystemExit(0 if s.get("MAIL_ALLOWED_TO")=="ops@example.com" and len(s)==1 else 1)' "$T/known.json" && echo 1 || echo 0)"

# The update returns when keep_settings fails, so record_settings does not run.
k=$(grep -n 'keep_settings "\$bucket" "\$WDIR"' "$ROOT/deploy/wfp/site" | head -1 | cut -d: -f1)
r=$(grep -n 'record_settings "\$bucket" "\$WDIR"' "$ROOT/deploy/wfp/site" | head -1 | cut -d: -f1)
ok "#1285 site update returns on a keep_settings failure before it records (lines ${k:-none} and ${r:-none})" \
  "$([ -n "$k" ] && [ -n "$r" ] && [ "$k" -lt "$r" ] && grep -q 'keep_settings "\$bucket" "\$WDIR" || { echo "site \$s: update refused' "$ROOT/deploy/wfp/site" && echo 1 || echo 0)"

# Both deploy paths call one function. A private copy of the old "ignored" line cannot pass.
ok "#1285 deploy.sh and deploy/wfp call unknown_setting.guard" \
  "$(grep -q 'unknown_setting.guard' "$ROOT/deploy/lib/recorded-inputs.sh" && grep -q 'unknown_setting.guard' "$ROOT/deploy/wfp/site_settings.py" && ! grep -q 'which is not a known setting: ignored' "$ROOT/deploy/wfp/site_settings.py" && echo 1 || echo 0)"

[ "$fails" = 0 ] && echo "unknown-setting: all checks pass" || echo "unknown-setting: $fails failing check(s)"
exit $((fails > 0))
