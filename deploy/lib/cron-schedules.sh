# shellcheck shell=bash
# #1186: after the upload, read the Worker's Cron Triggers back (the schedules API) and fail LOUDLY when they do not match
# what the render asked for. Wrangler leaves an existing schedule in place when the config has no [triggers] block, so a
# deploy with the approach A cron OFF used to keep the minute trigger, and the cron object kept running every leg
# (cf759hl, 2026-11-21: 15 done legs in 15 min on a build with no cron). The render now writes crons = [] whenever the
# cron is off (a-settings.sh a_cron_triggers, cron_triggers_none); this proves wrangler applied it.
#   cron_schedules_readback <script> on|off [schedule]   (schedule for "on"; default "* * * * *")
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (or ACCOUNT_ID). The token goes to curl in a -K config on a file
# descriptor, never argv. CF_API_BASE (tests only) points it at a stub. Return 0 when it matches, 1 (with ERROR) otherwise,
# including when the schedules cannot be read: never a silent ok.
# Test: deploy/tests/cron-schedules-test.sh.
cron_schedules_readback() {
  local script=$1 want=$2 sched=${3:-* * * * *} base=${CF_API_BASE:-https://api.cloudflare.com/client/v4}
  local acct=${CLOUDFLARE_ACCOUNT_ID:-${ACCOUNT_ID:-}} body got
  [ -n "$acct" ] && [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { echo "ERROR (#1186): cron schedules readback needs CLOUDFLARE_API_TOKEN and the account id" >&2; return 1; }
  body=$(curl -s -m 30 -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") "$base/accounts/$acct/workers/scripts/$script/schedules" 2>/dev/null)
  got=$(printf '%s' "$body" | python3 -I -c 'import json,sys
try:
    d = json.load(sys.stdin)
    assert d.get("success") is True
    print(json.dumps(sorted(s.get("cron") for s in (d.get("result") or {}).get("schedules") or [])))
except Exception:
    print("?")' 2>/dev/null)
  if [ -z "$got" ] || [ "$got" = "?" ]; then
    echo "ERROR (#1186): could not read the Cron Triggers of $script from the schedules API; the cron state is UNKNOWN" >&2; return 1
  fi
  if [ "$want" = off ]; then
    if [ "$got" = "[]" ]; then echo "cron triggers: none (the cron is off; no Cron Trigger on $script)"; return 0; fi
    echo "ERROR (#1186): the cron is OFF for $script, but its Cron Triggers read $got: the cron object would keep running every minute" >&2; return 1
  fi
  if [ "$got" = "$(python3 -I -c 'import json,sys; print(json.dumps([sys.argv[1]]))' "$sched")" ]; then echo "cron triggers: $got (the cron is on)"; return 0; fi
  echo "ERROR (#1186): the cron is ON for $script, but its Cron Triggers read $got, not [\"$sched\"]" >&2; return 1
}
