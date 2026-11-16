# shellcheck shell=bash
# FAULT_INJECT (#730, #589 B): the operator-only post-INSERT fault injector (spikes/b2-wordpress/fault-inject.mjs).
# A MEASUREMENT that kills the PHP object's isolate on purpose, so it is for THROWAWAY sites only. ONE rule for
# both emitters: deploy/deploy.sh (fault_check before any step, render-conf.sh fault_line) and deploy/wfp/lib.sh
# (render_user, fault_inject_var). Allowed only when ALL hold:
#   - FAULT_INJECT is "after-insert" or "sql-fail" (#766: a request's chosen SQL statement fails with the platform's
#     memory-reset message, and the isolate goes on); unset renders nothing; anything else is refused;
#   - the variant is b-dosql (the request frame lives in the object's SQLite);
#   - THROWAWAY=1, so a site nobody marked fails CLOSED;
#   - the site is not live: neither deploy/live-sites/<name>.env nor deploy/wfp/live-sites/<name> exists, and a
#     run with no name is refused (it cannot be checked).
# It is never recorded (deploy/wfp/site_settings.py MEASUREMENT), so the next update without it turns it off.
# Test: deploy/tests/fault-inject-test.sh.

# fault_check <variant> <name>: exit status 2 and the reason on stderr when refused; 0 when allowed or unset.
fault_check() {
  local v=${1:-} n=${2:-} root
  [ -n "${FAULT_INJECT:-}" ] || return 0
  case "$FAULT_INJECT" in after-insert|sql-fail) ;; *) echo "FAULT_INJECT must be after-insert, sql-fail or unset, not ${FAULT_INJECT}" >&2; return 2 ;; esac
  [ "$v" = b-dosql ] || { echo "FAULT_INJECT is for variant b-dosql (the request frame is in the object's SQLite), not ${v:-unset}" >&2; return 2; }
  [ "${THROWAWAY:-}" = 1 ] || { echo "FAULT_INJECT needs THROWAWAY=1 (it kills the PHP object's isolate on purpose; say the site is a throwaway)" >&2; return 2; }
  [ -n "$n" ] || { echo "FAULT_INJECT needs the site's name, to check it is not a live site" >&2; return 2; }
  root=${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
  if [ -e "$root/deploy/live-sites/$n.env" ]; then echo "FAULT_INJECT kills the object on purpose, and $n is a live site (deploy/live-sites/$n.env)" >&2; return 2; fi
  if [ -e "$root/deploy/wfp/live-sites/$n" ]; then echo "FAULT_INJECT kills the object on purpose, and $n is a live site (deploy/wfp/live-sites/$n)" >&2; return 2; fi
  return 0
}

# fault_line: the [vars] line (nothing when unset). Call fault_check first.
fault_line() {
  [ -z "${FAULT_INJECT:-}" ] || echo "FAULT_INJECT = \"$FAULT_INJECT\""
}
