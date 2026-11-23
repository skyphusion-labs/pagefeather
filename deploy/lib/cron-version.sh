# shellcheck shell=bash
# #1152: after a deploy, approach A's cron Durable Object (WP-Cron, Action Scheduler, every queued order email) can keep
# running the PREVIOUS version for minutes (cf759hx, 2026-11-21: all its legs on the old build while the site ran the
# new one at 100%). The engine corrects it on the next Cron Trigger tick (the tick carries the Worker's build; a cron
# object on another build resets itself at the start of its next leg). This readback says whether it has: it asks the
# site's /_cron-build (spike token) for up to CRON_VERSION_WAIT_S (default 600) and WARNS when the object is still on
# another build. 600 s, not 120 (lead, 2026-11-22): an idle cron object parks its next alarm up to IDLE_MAX_MS (5 min,
# cron-idle.mjs) ahead, set by the OLD build, so the first tick on the new build can come 5 min after a deploy (cf759hw:
# 3 min 29 s and 2 min 44 s, both at the parked time). A 120 s wait warned on both; a false alarm teaches people to
# ignore the real one. It never fails the deploy (the lead's ruling): a warning, with both builds named.
# #1360: before that poll, one POST /_cron-wake (spike token) pulls the parked alarm in to now. The route only sets the
# alarm; the object's own alarm runs the tick. A failed wake is printed and never fails the deploy: the poll still runs.
# Test: deploy/tests/cron-version-readback-test.sh.
# One wake. Prints whether it was accepted. Always returns 0.
cron_version_wake() {
  local url=$1 token=$2 body code
  body=$(mktemp "${TMPDIR:-/tmp}/cron-wake.XXXXXX") || { echo "cron wake: not accepted (no temp file); the readback continues"; return 0; }
  code=$(curl -s -m 20 -o "$body" -w '%{http_code}' -X POST -K <(printf 'header = "x-spike-token: %s"\nheader = "cache-control: no-cache"\n' "$token") "$url/_cron-wake" 2>/dev/null) || code=000
  if [ "$code" = 200 ] && python3 -I -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
raise SystemExit(0 if d.get("ok") is True else 1)' < "$body" 2>/dev/null; then
    echo "cron wake: accepted"
  else
    echo "cron wake: not accepted (HTTP ${code:-000}); the readback continues"
  fi
  rm -f "$body"
  return 0
}
cron_version_readback() {
  local url=$1 token=$2 wait=${CRON_VERSION_WAIT_S:-600} every=${CRON_VERSION_EVERY_S:-10} t0=$SECONDS body worker cron alarm
  [ "${VARIANT:-}" = a ] || return 0
  # The cron object exists exactly when a-settings.sh renders it: ask a_cron_on (its default can change, #1164).
  if declare -F a_cron_on > /dev/null; then a_cron_on || return 0; else [ "${A_CRON:-0}" = 1 ] || return 0; fi
  # #1360: once, before the poll. cron_version_wake returns 0 even when the wake is refused or unreachable.
  cron_version_wake "$url" "$token"
  # #1152 proof (cf759hx deploy 2): the build of the code that ANSWERS /_cron-build is not the build that RUNS the legs.
  # ok only when the Worker, the object and the object's last ALARM (its own baked-in BUILD_ID) are one build.
  while :; do
    body=$(curl -s -m 20 -K <(printf 'header = "x-spike-token: %s"\nheader = "cache-control: no-cache"\n' "$token") "$url/_cron-build" 2>/dev/null)
    read -r worker cron alarm < <(printf '%s' "$body" | python3 -I -c 'import json,sys
try:
    d = json.load(sys.stdin); print(d.get("worker") or "-", d.get("cron") or "-", d.get("alarm") or "-")
except Exception:
    print("? ? ?")' 2>/dev/null)
    if [ -n "$worker" ] && [ "$worker" != "?" ] && [ "$worker" != "-" ] && [ "$worker" = "$cron" ] && [ "$worker" = "$alarm" ]; then
      echo "cron object: ok, its last alarm ran the deployed build $worker (lag $((SECONDS - t0)) s after the upload)"
      return 0
    fi
    [ $((SECONDS - t0)) -ge "$wait" ] && break
    sleep "$every"
  done
  if [ "${worker:-?}" = "?" ]; then
    echo "WARNING (#1152): could not read the cron object's build from $url/_cron-build within ${wait} s. Read its legs' scriptVersion in Workers Observability before trusting a cron or order-email change." >&2
  elif [ "${cron:--}" = "$worker" ]; then
    echo "WARNING (#1152): the cron object answers on the deployed build $worker, but its last alarm ran build ${alarm:--} after ${wait} s. Until an alarm runs the new build, a cron or order-email change is not live; read its legs' scriptVersion." >&2
  else
    echo "WARNING (#1152): the cron object is still on build ${cron:--} after ${wait} s (last alarm ${alarm:--}); the Worker is on $worker. The next Cron Trigger tick should reset it; until its legs read the new build, a cron or order-email change is not live." >&2
  fi
  return 0
}
