#!/usr/bin/env bash
# #736 (#730): a FAULT_INJECT refusal on the Workers for Platforms path comes at the ENTRY of every command, as
# OBSERVABILITY=full's does, never after the build. On run8's gate check the refusal came from render_user, after
# the Terraform workspace, the site map entry and the media bucket existed. Against the stand-in account and
# Terraform of obs-full-live-test.sh: each refused case exits 2 with 0 API writes and 0 Terraform calls.
#   deploy/wfp/tests/fault-early-test.sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
SITE="$HERE/../site"
SITESH="$HERE/../site.sh"
UPSH="$HERE/../up.sh"
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails + 1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/fault-early-test.XXXXXX")
SRV=
trap '[ -n "$SRV" ] && kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; rm -rf "$T"' EXIT
echo '{"sites": {}}' > "$T/state.json"
python3 -I "$HERE/fake-account.py" "$T/port" "$T/state.json" & SRV=$!
for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
mkdir -p "$T/bin"
cat > "$T/bin/terraform" <<TF
#!/bin/sh
printf '%s\\n' "\$*" >> "$T/tf.log"
case "\$*" in
  init*) exit 0 ;;
  "output -raw kv_namespace_id") printf kv1 ;;
  "workspace list") printf '* default\\n  one\\n' ;;
  *) echo "stand-in terraform: \$* is not expected" >&2; exit 9 ;;
esac
TF
chmod +x "$T/bin/terraform"
PORT=$(cat "$T/port")
run() { # run <command> [args...]: rc, api writes, terraform calls, then the output
  rm -f "$T/state.json.writes" "$T/tf.log"
  local out rc writes tf
  out=$(env -i PATH="$T/bin:$PATH" HOME="${HOME:-/tmp}" TMPDIR="${TMPDIR:-/tmp}" \
    WFP_API="http://127.0.0.1:$PORT" WFP_STATE=local CLOUDFLARE_API_TOKEN=test \
    ACCOUNT_ID=test-account NAMESPACE=wp-wfp "$@" 2>&1); rc=$?
  writes=$(cat "$T/state.json.writes" 2>/dev/null | wc -l | tr -d ' ')
  tf=0; [ -f "$T/tf.log" ] && tf=$(wc -l < "$T/tf.log" | tr -d ' ')
  printf '%s\n%s\n%s\n%s\n' "$rc" "$writes" "$tf" "$out"
}
refused() { # refused <label> <want text> <command> [args...]
  local label=$1 want=$2; shift 2
  local meta rc writes tf out
  meta=$(run "$@"); out=$(printf '%s\n' "$meta" | tail -n +4)
  rc=$(printf '%s\n' "$meta" | sed -n '1p'); writes=$(printf '%s\n' "$meta" | sed -n '2p'); tf=$(printf '%s\n' "$meta" | sed -n '3p')
  ok "$label: refused at the entry (rc $rc, api writes $writes, terraform calls $tf)" \
    "$([ "$rc" = 2 ] && [ "$writes" = 0 ] && [ "$tf" = 0 ] && printf '%s\n' "$out" | grep -qF "$want" && ! printf '%s\n' "$out" | grep -q 'not built' && echo 1 || echo 0)"
}
NO_TA="FAULT_INJECT needs THROWAWAY=1"
LIVE="ggc-test is a live site"
BAD="FAULT_INJECT must be after-insert or unset"
# BUILD stays unset (site add's default is 0): a missing refusal stops at "not built", never at a real build.
refused "site add, no THROWAWAY" "$NO_TA" env FAULT_INJECT=after-insert "$SITE" add pf9x
refused "site add, a live site" "$LIVE" env FAULT_INJECT=after-insert THROWAWAY=1 "$SITE" add ggc-test
refused "site add, a bad value" "$BAD" env FAULT_INJECT=on THROWAWAY=1 "$SITE" add pf9x
refused "site update, no THROWAWAY" "$NO_TA" env FAULT_INJECT=after-insert "$SITE" update pf9x
refused "site update, a live site" "$LIVE" env FAULT_INJECT=after-insert THROWAWAY=1 "$SITE" update ggc-test
refused "site.sh up, no THROWAWAY" "$NO_TA" env FAULT_INJECT=after-insert "$SITESH" up pf9x
refused "site.sh up, a live site" "$LIVE" env FAULT_INJECT=after-insert THROWAWAY=1 "$SITESH" up ggc-test
refused "up.sh, no THROWAWAY" "$NO_TA" env FAULT_INJECT=after-insert BUILD=0 SITES=pf9x "$UPSH"
refused "up.sh 'one ggc-test' refuses before either" "$LIVE" env FAULT_INJECT=after-insert THROWAWAY=1 BUILD=0 SITES="one ggc-test" "$UPSH"
ok "update_one (update --all) checks each site before the snapshot and build" "$(awk '/^update_one_inner\(\)/,/^}/' "$SITE" | grep -q 'fault_inject_var "\$s" >/dev/null || return 2' && echo 1 || echo 0)"
echo "$fails failing case(s)"
[ "$fails" = 0 ]
