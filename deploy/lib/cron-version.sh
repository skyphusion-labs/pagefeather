# shellcheck shell=bash
# #1152: after a deploy, approach A's cron Durable Object (WP-Cron, Action Scheduler, every queued order email) can keep
# running the PREVIOUS version for minutes (cf759hx, 2026-11-21: all its legs on the old build while the site ran the
# new one at 100%). The engine corrects it on the next Cron Trigger tick (the tick carries the Worker's build; a cron
# object on another build resets itself at the start of its next leg). This readback says whether it has: it asks the
# site's /_cron-build (spike token) for up to CRON_VERSION_WAIT_S (default 120) and WARNS when the object is still on
# another build. It never fails the deploy (the lead's ruling): a warning, with both builds named.
# Test: deploy/tests/cron-version-readback-test.sh.
cron_version_readback() {
  local url=$1 token=$2 wait=${CRON_VERSION_WAIT_S:-120} every=${CRON_VERSION_EVERY_S:-10} t0=$SECONDS body worker cron
  [ "${VARIANT:-}" = a ] && [ "${A_CRON:-0}" = 1 ] || return 0
  while :; do
    body=$(curl -s -m 20 -K <(printf 'header = "x-spike-token: %s"\nheader = "cache-control: no-cache"\n' "$token") "$url/_cron-build" 2>/dev/null)
    read -r worker cron < <(printf '%s' "$body" | python3 -I -c 'import json,sys
try:
    d = json.load(sys.stdin); print(d.get("worker") or "-", d.get("cron") or "-")
except Exception:
    print("? ?")' 2>/dev/null)
    if [ -n "$worker" ] && [ "$worker" != "?" ] && [ "$worker" != "-" ] && [ "$worker" = "$cron" ]; then
      echo "cron object: ok, on the deployed build $worker ($((SECONDS - t0)) s)"
      return 0
    fi
    [ $((SECONDS - t0)) -ge "$wait" ] && break
    sleep "$every"
  done
  if [ "${worker:-?}" = "?" ]; then
    echo "WARNING (#1152): could not read the cron object's build from $url/_cron-build within ${wait} s. Read its legs' scriptVersion in Workers Observability before trusting a cron or order-email change." >&2
  else
    echo "WARNING (#1152): the cron object is still on build ${cron:--} after ${wait} s; the Worker is on $worker. The next Cron Trigger tick should reset it; until its legs read the new build, a cron or order-email change is not live." >&2
  fi
  return 0
}
