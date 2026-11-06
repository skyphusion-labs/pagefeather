#!/bin/bash
# The plugin suite on wp-a2 (issue #50): the same 7 groups as
# spikes/b2-wordpress/plugin-suite.sh (read from that file), because the 18
# plugins and WooCommerce do not fit in one Worker (64 MiB). For each group:
# deploy wp-a2 with deploy/deploy.sh and WOO=0 PLUGINS="<group>", then
# tests/plugins/plugins.py for the group's plugins. A refused deploy is a
# result. At the end, one normal deploy puts WooCommerce back and activates it
# (a WOO=0 build makes WordPress deactivate it).
#
#   SITE_ENV=<file with B and ADMIN_PASSWORD for wp-a2> \
#   NAME=wp-a2 VARIANT=a MYSQL=external MYSQL_HOST=... MYSQL_USER=... MYSQL_PASSWORD=... MYSQL_DATABASE=... \
#   PLACEMENT=aws:us-east-2 HYPERDRIVE_SQL_MODE=... CLOUDFLARE_API_TOKEN=... ACCOUNT_ID=... [DEPLOY_STATE=r2 ...] \
#   ./tests/a2/plugin-suite.sh [group-number ...]
#
# Output: tests/plugins/results/a2-paid.jsonl (one line per plugin, as the
# other columns of tests/plugins/report.py).
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
: "${SITE_ENV:?set SITE_ENV}" "${NAME:?set NAME}"
[ "${VARIANT:-}" = a ] || { echo "VARIANT=a only" >&2; exit 2; }
OUT="$ROOT/tests/plugins/results/a2-paid.jsonl"
mkdir -p "$(dirname "$OUT")"
# The groups, from the one list in plugin-suite.sh. No mapfile: macOS /bin/bash is 3.2.
GROUPS_=()
while IFS= read -r line; do GROUPS_+=("$line"); done < <(sed -n '/^GROUPS_=(/,/^)/p' "$ROOT/spikes/b2-wordpress/plugin-suite.sh" | grep -E '^[[:space:]]+"' | sed -E 's/^[[:space:]]+"(.*)"[[:space:]]*$/\1/')
[ "${#GROUPS_[@]}" -eq 7 ] || { echo "expected 7 groups in plugin-suite.sh, got ${#GROUPS_[@]}" >&2; exit 1; }
sel=("$@")
if [ ${#sel[@]} -eq 0 ]; then for i in $(seq 1 ${#GROUPS_[@]}); do sel+=("$i"); done; fi
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
for g in "${sel[@]}"; do
  P=${GROUPS_[$((g-1))]}
  echo "== group $g: $P"
  if ! WOO=0 PLUGINS="$P" BENCH=0 WOO_ACTIVE=0 "$ROOT/deploy/deploy.sh" > "$W/deploy.log" 2>&1; then
    err=$(grep -iE 'error|exceed|limit' "$W/deploy.log" | head -3 | tr '\n' ' ' | cut -c1-300)
    for s in $P; do
      python3 -c 'import json, sys; print(json.dumps({"plugin": sys.argv[1], "target": sys.argv[2], "error": "deploy refused", "detail": sys.argv[3]}))' "$s" "$NAME" "$err"
    done >> "$OUT"
    echo "group $g: deploy refused: $err"
    continue
  fi
  grep -E 'Total Upload' "$W/deploy.log" | head -1
  sleep 10
  # shellcheck disable=SC2086,SC1090 # $P is a list of plugin slugs; SITE_ENV is the caller's file
  (set -a; . "$SITE_ENV"; set +a; python3 "$ROOT/tests/plugins/plugins.py" $P) | grep '^{' >> "$OUT"
done
echo "== restore: WooCommerce back in the build and active"
WOO=1 PLUGINS='' BENCH=0 WOO_ACTIVE=1 "$ROOT/deploy/deploy.sh" > "$W/deploy.log" 2>&1 \
  && echo "restored" || { echo "RESTORE FAILED: wp-a2 has no WooCommerce now"; tail -20 "$W/deploy.log"; exit 1; }
echo "results: $OUT"
