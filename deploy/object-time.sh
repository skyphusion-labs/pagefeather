# shellcheck shell=bash
# object_time_vars: the [vars] lines of the two PHP-object time bounds (#703, #708), on stdout, or the reason
# on stderr and return 1. One rule for every emitter: deploy/render-conf.sh (deploy.sh) and deploy/wfp/lib.sh
# (render_user) both call it, so the escape hatch OBJECT_START_BY_S=off has an IaC path and is recorded
# (deploy/wfp/site_settings.py SETTINGS). Unset writes no line: the code default (spikes/b2-wordpress
# object-deadline.mjs, start-by.mjs).
#   OBJECT_CALL_DEADLINE_S  off, or seconds from 1 to 600 (a decimal is allowed)
#   OBJECT_START_BY_S       off, or seconds from 1 to 600 (a decimal is allowed)
# The code takes a deadline from 0.01 s; the recorded setting asks for 1 s or more, so a typo such as 0.09
# for 90 is refused, not deployed.
# An explicit OBJECT_START_BY_S is at most the deadline minus the run allowance (30 s, or a third of a deadline under
# 90 s: 60 at the default 90), the same cap as start-by.mjs startByMs. A larger value is refused here, so the operator
# learns it at deploy time instead of getting a silent clamp (#715 review3 1). With the deadline off there is no cap.
object_time_vars() {
  local n v
  for n in OBJECT_CALL_DEADLINE_S OBJECT_START_BY_S; do
    v=${!n:-}
    [ -n "$v" ] || continue
    if [ "$v" != off ]; then
      if ! [[ "$v" =~ ^[0-9]+(\.[0-9]+)?$ ]] || ! awk -v x="$v" 'BEGIN { exit !(x >= 1 && x <= 600) }'; then
        echo "$n must be off or seconds from 1 to 600, not $v" >&2
        return 1
      fi
    fi
    echo "$n = \"$v\""
  done
  local sb=${OBJECT_START_BY_S:-} dl=${OBJECT_CALL_DEADLINE_S:-90} cap
  if [ -n "$sb" ] && [ "$sb" != off ] && [ "$dl" != off ]; then
    cap=$(awk -v d="$dl" 'BEGIN { ms = d * 1000; a = int(ms / 3); if (a > 30000) a = 30000; printf "%g", (ms - a) / 1000 }')
    if ! awk -v x="$sb" -v c="$cap" 'BEGIN { exit !(x <= c) }'; then
      echo "OBJECT_START_BY_S must be at most $cap with a $dl s deadline (the deadline minus the run allowance), not $sb" >&2
      return 1
    fi
  fi
}
