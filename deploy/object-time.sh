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
}
