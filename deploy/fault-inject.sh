# shellcheck shell=bash
# FAULT_INJECT (#730, #589 B): the operator-only post-INSERT fault injector (spikes/b2-wordpress/fault-inject.mjs).
# A MEASUREMENT that kills the PHP object's isolate on purpose, so it is for THROWAWAY sites only. ONE rule for
# both emitters: deploy/deploy.sh (fault_check before any step, render-conf.sh fault_line) and deploy/wfp/lib.sh
# (render_user, fault_inject_var). Allowed only when ALL hold:
#   - FAULT_INJECT is "after-insert" or "sql-fail" (#766: a request's chosen SQL statement fails with the platform's
#     memory-reset message, and the isolate goes on; #809: with x-pf-fault-undo: on, the frame rollback and recovery
#     undo fail too, until off, so a frame strands); unset renders nothing; anything else is refused;
#   - the variant is b-dosql (the request frame lives in the object's SQLite);
#   - THROWAWAY=1, so a site nobody marked fails CLOSED;
#   - the site is not live: neither deploy/live-sites/<name>.env nor deploy/wfp/live-sites/<name> exists, and a
#     run with no name is refused (it cannot be checked).
#   FAULT_INJECT=email (#1062) is the email rejection seam instead: EMAIL_FAULT=reject-N (N 1 to 999) makes the next N
#   env.EMAIL.send calls of an isolate reject, so the retry path runs as for a real refusal. It kills no isolate, so it is
#   allowed on variant a AND b-dosql (the two tiers with this mail path), under the same THROWAWAY=1 and live-site rule.
#   EMAIL_FAULT without FAULT_INJECT=email is refused (a half-armed seam).
# Neither is ever recorded (deploy/wfp/site_settings.py MEASUREMENT), so the next update without them turns them off.
# Test: deploy/tests/fault-inject-test.sh.

# fault_check <variant> <name>: exit status 2 and the reason on stderr when refused; 0 when allowed or unset.
fault_check() {
  local v=${1:-} n=${2:-} root
  if [ -n "${EMAIL_FAULT:-}" ] && [ "${FAULT_INJECT:-}" != email ]; then echo "EMAIL_FAULT needs FAULT_INJECT=email (a half-armed seam is refused)" >&2; return 2; fi
  [ -n "${FAULT_INJECT:-}" ] || return 0
  case "$FAULT_INJECT" in after-insert|sql-fail|email) ;; *) echo "FAULT_INJECT must be after-insert, sql-fail, email or unset, not ${FAULT_INJECT}" >&2; return 2 ;; esac
  if [ "$FAULT_INJECT" = email ]; then
    case "$v" in a|b-dosql) ;; *) echo "FAULT_INJECT=email is for variant a or b-dosql (the wp_mail path with the #1057 retry), not ${v:-unset}" >&2; return 2 ;; esac
    [ -n "${EMAIL_FAULT:-}" ] || { echo "FAULT_INJECT=email needs EMAIL_FAULT=reject-N (how many sends reject)" >&2; return 2; }
    [[ "$EMAIL_FAULT" =~ ^reject-([1-9][0-9]{0,2})$ ]] || { echo "EMAIL_FAULT must be reject-N with N from 1 to 999, not ${EMAIL_FAULT}" >&2; return 2; }
  else
    [ "$v" = b-dosql ] || { echo "FAULT_INJECT is for variant b-dosql (the request frame is in the object's SQLite), not ${v:-unset}" >&2; return 2; }
  fi
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
  [ "${FAULT_INJECT:-}" != email ] || echo "EMAIL_FAULT = \"$EMAIL_FAULT\""
}
