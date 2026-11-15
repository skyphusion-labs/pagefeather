# shellcheck shell=bash
# OBSERVABILITY for deploy/deploy.sh (variants b-do, b-dosql and a): Workers Logs for one site, off
# unless set, so a deploy without it renders as before. The three values are deploy/wfp's
# (render_user, deploy/wfp/lib.sh), so the two deploy paths agree:
#   unset   nothing (today's render: a re-upload keeps the script's logging as it was)
#   0       an explicit enabled = false, a deliberate off
#   1       events only: our structured lines and uncaught exceptions, no request metadata
#   full    the invocation logs too (each request's outcome, URL, client IP, user agent). Throwaway only:
#           it needs THROWAWAY=1, and is refused for a site in deploy/live-sites/ even then.
# Every event carries the request URL, and a store's query strings hold order keys and logins. The
# pinned wrangler has no key for the redaction, so obs_redact sets redact_query_string through the
# script-settings API right after the upload and reads it back. If it does not read back, the logs
# are turned OFF and the deploy fails (deploy/wfp/obs_settings.py redact-or-off: fail closed, as
# spikes/b2-wordpress/deploy-a-lean.sh does). For 1 AND full: both log the URL.
# Test: deploy/tests/observability-test.sh.

# obs_check <variant>: exit status 2 and the reason on stderr when the setting is wrong.
obs_check() {
  [ -n "${OBSERVABILITY:-}" ] || return 0
  case "$1" in b-do|b-dosql|a) ;; *) echo "OBSERVABILITY is for variants b-do, b-dosql and a (c1 has its own steps), not $1" >&2; return 2 ;; esac
  case "$OBSERVABILITY" in 0|1|full) ;; *) echo "OBSERVABILITY must be 0, 1 (events only) or full (a throwaway only), not ${OBSERVABILITY}" >&2; return 2 ;; esac
  # full is a throwaway-only setting, enforced (the lead's ruling): the run must say so with THROWAWAY=1,
  # so a site nobody marked fails CLOSED. A list would fail open for the next live store not on it.
  if [ "$OBSERVABILITY" = full ] && [ "${THROWAWAY:-}" != 1 ]; then
    echo "OBSERVABILITY=full needs THROWAWAY=1 (it logs every request's URL, client IP and user agent; say the site is a throwaway, or use 1, events only)" >&2; return 2
  fi
  # A second guard: a site with a deploy/live-sites/<NAME>.env is live, whatever THROWAWAY says.
  if [ "$OBSERVABILITY" = full ] && [ -n "${NAME:-}" ] && [ -e "${ROOT:-.}/deploy/live-sites/$NAME.env" ]; then
    echo "OBSERVABILITY=full logs every request's URL, client IP and user agent, and $NAME is a live site (deploy/live-sites/$NAME.env): use 1 (events only)" >&2; return 2
  fi
}

# obs_block: the [observability] block of the Wrangler config (nothing when unset).
obs_block() {
  case "${OBSERVABILITY:-}" in
    '') ;;
    0) printf '[observability]\nenabled = false\n' ;;
    1) printf '[observability]\nenabled = true\nhead_sampling_rate = 1\n[observability.logs]\nenabled = true\ninvocation_logs = false\n' ;;
    full) printf '[observability]\nenabled = true\nhead_sampling_rate = 1\n[observability.logs]\nenabled = true\ninvocation_logs = true\n' ;;
  esac
  return 0
}

# obs_wants_redact: true when the logs are on (1 or full).
obs_wants_redact() { [ "${OBSERVABILITY:-}" = 1 ] || [ "${OBSERVABILITY:-}" = full ]; }

# obs_redact <script name>: redact the query string in the script's logs, read back; on failure the
# logs are turned off and this returns 1. Needs ROOT, CLOUDFLARE_API_TOKEN and the account in the
# environment (obs_settings.py reads them; the token never goes in argv).
obs_redact() {
  obs_wants_redact || return 0
  python3 -I "$ROOT/deploy/wfp/obs_settings.py" redact-or-off - "$1" && return 0
  echo "$1 is DEPLOYED, but the query-string redaction did not read back, so its logs are OFF (obs_settings.py redact-or-off). Deploy again to retry." >&2
  return 1
}
