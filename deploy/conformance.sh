# shellcheck shell=bash
# The conformance content gate (#759, #764). The upstream test suites' content (tests/conformance/prepare-content.sh,
# #763) holds WooCommerce Cleanup (a REST route that DELETES every order, product, coupon and term and truncates
# tables), the WooCommerce e2e test helper (set and delete any option over REST), Gutenberg's test plugins, and the
# throwaway marker mu-plugin; both upstream suites also delete all posts. So a deploy whose build inputs carry that
# content is for a THROWAWAY site only. The gate keys on the CONTENT, never on a flag, so the content cannot reach a
# site by a path that skips it. Same shape as FAULT_INJECT (deploy/fault-inject.sh), the one rule for both emitters:
# deploy/deploy.sh (before any step) and deploy/wfp (every entry, after an update restores its recorded inputs, and
# render_user as the last guard). The content is present when ANY holds:
#   - IMPORT_MU_PLUGINS names pf-conformance-throwaway.php (the marker);
#   - IMPORT_PLUGINS names woocommerce-cleanup, woocommerce-e2e-test-helper or gutenberg-test-plugins;
#   - SUITE or THEME_SUITE points into tests/conformance/ (the conformance-only pins: plugins.txt, themes.txt);
#   - IMPORT_CONTENT is a wp-content that holds mu-plugins/pf-conformance-throwaway.php, whatever IMPORT_* says.
# #1427: that imported copy can be from an older prepare-content.sh, so a marker fix never reached the site.
# When CONFORMANCE=on, conformance_marker_install copies tests/conformance/php/pf-conformance-throwaway.php
# over it. build.sh calls that after content.sh --mu.
# Then it is allowed only when ALL hold: CONFORMANCE=on (the run states it carries this content: a deploy-time
# statement only, never rendered or recorded, so not a runtime switch), THROWAWAY=1, and the site is named and not
# live (neither
# deploy/live-sites/<name>.env nor deploy/wfp/live-sites/<name>; ggc and ggc-test are refused).
# #940: that throwaway also needs Cloudflare's always-pass Turnstile test pair, and TURNSTILE_LOGIN=off.
# #973: it also needs TURNSTILE_LOSTPASSWORD=off. The lost-password posts cannot complete the challenge.
# The checkout and comment gates stay on. A real site key is refused. The test secret is public.
# Test: deploy/tests/conformance-test.sh, deploy/wfp/tests/conformance-early-test.sh.

CONFORMANCE_PLUGINS="woocommerce-cleanup woocommerce-e2e-test-helper gutenberg-test-plugins"
CONFORMANCE_MARKER=pf-conformance-throwaway.php
# Cloudflare documents this pair. The site key widget passes with no challenge.
# The secret makes siteverify return success. Both values are public.
CONFORMANCE_TURNSTILE_SITEKEY=1x00000000000000000000AA
CONFORMANCE_TURNSTILE_SECRET=1x0000000000000000000000000000000AA

# conformance_marker_install <build wp-content>: when CONFORMANCE=on, install the tree's marker
# over whatever IMPORT_CONTENT brought in. One line on stderr says so. Otherwise change nothing.
# The tree file is tests/conformance/php/pf-conformance-throwaway.php (#1427).
conformance_marker_install() {
  [ "${CONFORMANCE:-}" = on ] || return 0
  local dst=${1:?build wp-content} root src
  root=${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
  src="$root/tests/conformance/php/$CONFORMANCE_MARKER"
  [ -f "$src" ] || { echo "conformance: the build tree has no $src" >&2; return 1; }
  mkdir -p "$dst/mu-plugins"
  cp "$src" "$dst/mu-plugins/$CONFORMANCE_MARKER"
  echo "conformance: installed $CONFORMANCE_MARKER from the build tree over any copy from IMPORT_CONTENT" >&2
}

# conformance_content: prints the first trigger found, nothing when the inputs carry no conformance content.
conformance_content() {
  local w p
  for w in ${IMPORT_MU_PLUGINS:-}; do [ "$w" = "$CONFORMANCE_MARKER" ] && { echo "IMPORT_MU_PLUGINS names $CONFORMANCE_MARKER"; return 0; }; done
  for w in ${IMPORT_PLUGINS:-}; do for p in $CONFORMANCE_PLUGINS; do [ "$w" = "$p" ] && { echo "IMPORT_PLUGINS names $p"; return 0; }; done; done
  for p in SUITE THEME_SUITE; do
    case "${!p:-}" in */tests/conformance/*|tests/conformance/*) echo "$p points into tests/conformance/ (${!p})"; return 0 ;; esac
  done
  if [ -n "${IMPORT_CONTENT:-}" ] && [ -e "${IMPORT_CONTENT}/mu-plugins/$CONFORMANCE_MARKER" ]; then
    echo "IMPORT_CONTENT holds mu-plugins/$CONFORMANCE_MARKER"; return 0
  fi
  return 0
}

# conformance_turnstile: the checkout gate stays on, with the always-pass test pair.
# Login is off because the suite login post carries no token.
# Lost password is off because those posts cannot complete the challenge (#973).
# A missing pair is refused so an empty site key cannot skip the gate.
# The secret value is never printed.
conformance_turnstile() {
  [ "${TURNSTILE:-}" != off ] || { echo "conformance refuses TURNSTILE=off. The checkout gate stays on." >&2; return 2; }
  [ "${TURNSTILE_LOGIN:-}" = off ] || { echo "conformance needs TURNSTILE_LOGIN=off. The suite login post has no token." >&2; return 2; }
  [ "${TURNSTILE_LOSTPASSWORD:-}" = off ] || { echo "conformance needs TURNSTILE_LOSTPASSWORD=off. The suite lost-password posts cannot complete the challenge." >&2; return 2; }
  [ "${TURNSTILE_WOO:-}" != off ] || { echo "conformance refuses TURNSTILE_WOO=off. The checkout gate stays on." >&2; return 2; }
  [ "${TURNSTILE_COMMENTS:-}" != off ] || { echo "conformance refuses TURNSTILE_COMMENTS=off. The comment gate stays on." >&2; return 2; }
  [ "${TURNSTILE_SITEKEY:-}" = "$CONFORMANCE_TURNSTILE_SITEKEY" ] || { echo "conformance needs TURNSTILE_SITEKEY=${CONFORMANCE_TURNSTILE_SITEKEY}. A real site key stops classic checkout." >&2; return 2; }
  # Compare only. Do not echo TURNSTILE_SECRET.
  [ "${TURNSTILE_SECRET:-}" = "$CONFORMANCE_TURNSTILE_SECRET" ] || { echo "conformance needs the always-pass TURNSTILE_SECRET. A real secret rejects the test token." >&2; return 2; }
  return 0
}

# conformance_check <name>: exit status 2 and the reason on stderr when refused; 0 when allowed or no content.
conformance_check() {
  local n=${1:-} why root
  case "${CONFORMANCE:-}" in ""|on) ;; *) echo "CONFORMANCE must be on or unset, not ${CONFORMANCE}" >&2; return 2 ;; esac
  why=$(conformance_content)
  [ -n "$why" ] || return 0
  [ "${CONFORMANCE:-}" = on ] || { echo "conformance content needs CONFORMANCE=on ($why): state that this build carries the upstream suites' content, which wipes the store" >&2; return 2; }
  [ "${THROWAWAY:-}" = 1 ] || { echo "conformance content needs THROWAWAY=1 ($why): it wipes the store and deletes all posts; say the site is a throwaway" >&2; return 2; }
  [ -n "$n" ] || { echo "conformance content needs the site's name, to check it is not a live site ($why)" >&2; return 2; }
  root=${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
  if [ -e "$root/deploy/live-sites/$n.env" ]; then echo "conformance content wipes the store, and $n is a live site (deploy/live-sites/$n.env; $why)" >&2; return 2; fi
  if [ -e "$root/deploy/wfp/live-sites/$n" ]; then echo "conformance content wipes the store, and $n is a live site (deploy/wfp/live-sites/$n; $why)" >&2; return 2; fi
  conformance_turnstile || return 2
  return 0
}
