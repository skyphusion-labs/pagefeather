# shellcheck shell=bash
# CONFORMANCE (#759): the switch that runs WordPress's and WooCommerce's own test suites against a site. It
# turns on three upstream test plugins (spikes/b2-wordpress/conformance/, loaded by php/conformance.php):
# JSON Basic Authentication (the admin's LOGIN PASSWORD works over HTTP Basic auth), the WooCommerce e2e
# test helper (set and delete any option over REST) and WooCommerce Cleanup (a REST route that DELETES every
# order, product, coupon and term and truncates tables). So it is for THROWAWAY sites only, the same shape as
# FAULT_INJECT (deploy/fault-inject.sh). ONE rule for both emitters: deploy/deploy.sh (conformance_check before
# any step, render-conf.sh conformance_line) and deploy/wfp (every entry, and render_user, conformance_var).
# Allowed only when ALL hold:
#   - CONFORMANCE is "on" (unset renders nothing; anything else is refused);
#   - THROWAWAY=1, so a site nobody marked fails CLOSED;
#   - the site is not live: neither deploy/live-sites/<name>.env nor deploy/wfp/live-sites/<name> exists, and a
#     run with no name is refused (it cannot be checked).
# Any variant: the conformance matrix covers every tier. It is never recorded (deploy/wfp/site_settings.py
# MEASUREMENT), so the next update without it turns it off. Test: deploy/tests/conformance-test.sh.

# conformance_check <name>: exit status 2 and the reason on stderr when refused; 0 when allowed or unset.
conformance_check() {
  local n=${1:-} root
  [ -n "${CONFORMANCE:-}" ] || return 0
  [ "$CONFORMANCE" = on ] || { echo "CONFORMANCE must be on or unset, not ${CONFORMANCE}" >&2; return 2; }
  [ "${THROWAWAY:-}" = 1 ] || { echo "CONFORMANCE needs THROWAWAY=1 (it turns on password Basic auth and a REST route that wipes the store; say the site is a throwaway)" >&2; return 2; }
  [ -n "$n" ] || { echo "CONFORMANCE needs the site's name, to check it is not a live site" >&2; return 2; }
  root=${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
  if [ -e "$root/deploy/live-sites/$n.env" ]; then echo "CONFORMANCE can wipe the store, and $n is a live site (deploy/live-sites/$n.env)" >&2; return 2; fi
  if [ -e "$root/deploy/wfp/live-sites/$n" ]; then echo "CONFORMANCE can wipe the store, and $n is a live site (deploy/wfp/live-sites/$n)" >&2; return 2; fi
  return 0
}

# conformance_line: the [vars] line (nothing when unset). Call conformance_check first.
conformance_line() {
  [ -z "${CONFORMANCE:-}" ] || echo 'CONFORMANCE = "on"'
}
