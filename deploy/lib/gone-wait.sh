# shellcheck shell=bash
# The bounded "gone" check (#789), ONE helper for deploy/destroy.sh and deploy/wfp (site.sh down, down.sh).
#
# Cloudflare's API can still show a just-deleted script for a while: measured 2026-11-16, five removes stopped on
# "NOT gone (API 200)", "NOT known to be gone (present)" or "STILL EXISTS (API: 200)", and each passed when run
# again 30 to 45 s later. A single read believed it. So a gone check POLLS: it reads every GONE_POLL_S seconds
# (default 5) for up to GONE_WAIT_S (default 90, at most 600), and passes at the first "gone".
#
# wait_gone <probe> [args...]: runs the probe until it prints "gone". The probe prints ONE word: gone, or the state
# it saw (present, unknown, an HTTP code). An unreadable answer (000, a 5xx, unknown) is never gone: it is read
# again within the same cap. A word that starts with "fatal" ends the wait at once (a refused credential: waiting
# cannot change it). Returns 0 when gone, 1 at the cap or on fatal; sets GONE_LAST (the last word, "fatal-" taken
# off), GONE_READS (how many reads) and GONE_WAITED (seconds since the first read). The caller prints its messages.
#
# gone_http_state <HTTP code>: the word for a GET of the deleted thing: 404 gone, 401 and 403 fatal, else the code.
# Test: deploy/wfp/tests/gone-wait-test.sh (and deploy/tests/destroy-test.sh, cases 9 and 10).

gone_http_state() {
  case "${1:-000}" in
    404) echo gone ;;
    401|403) echo "fatal-$1" ;;
    *) echo "${1:-000}" ;;
  esac
}

# GONE_LAST, GONE_READS and GONE_WAITED are this helper's OUTPUTS, read by its callers (destroy.sh, wfp lib.sh).
# shellcheck disable=SC2034
wait_gone() {
  local cap=${GONE_WAIT_S:-90} poll=${GONE_POLL_S:-5} t0 now st
  [[ "$cap" =~ ^[0-9]+$ ]] && [ "$cap" -ge 1 ] && [ "$cap" -le 600 ] || { echo "GONE_WAIT_S must be 1 to 600 seconds, not $cap" >&2; return 2; }
  [[ "$poll" =~ ^[0-9]+(\.[0-9]+)?$ ]] && [ "$poll" != 0 ] || { echo "GONE_POLL_S must be a number of seconds above 0, not $poll" >&2; return 2; }
  t0=$(date +%s)
  GONE_LAST="" GONE_WAITED=0 GONE_READS=0
  while :; do
    st=$("$@" 2>/dev/null) || true
    GONE_READS=$((GONE_READS + 1))
    st=${st:-unknown}
    now=$(date +%s); GONE_WAITED=$((now - t0))
    case "$st" in
      gone) GONE_LAST=gone; return 0 ;;
      fatal*) GONE_LAST=${st#fatal-}; return 1 ;;
    esac
    GONE_LAST=$st
    [ "$GONE_WAITED" -lt "$cap" ] || return 1
    sleep "$poll"
  done
}

# A note for the messages: "; after N reads over S s" when the check had to read again, nothing when the first
# read said gone.
gone_waited_note() {
  [ "${GONE_READS:-1}" -gt 1 ] && echo "; after ${GONE_READS} reads over ${GONE_WAITED} s" || true
}
