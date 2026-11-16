#!/usr/bin/env bash
# #764 (#759): the conformance content gate in BOTH emitters. One rule (deploy/conformance.sh): build inputs that carry
# the upstream suites' content (it wipes the store) need THROWAWAY=1 and a named site that is not live. Each trigger
# is planted once: the marker in IMPORT_MU_PLUGINS, each test plugin in IMPORT_PLUGINS, SUITE and THEME_SUITE into
# tests/conformance/, and the marker FILE in an IMPORT_CONTENT tree (whatever IMPORT_* says).
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/conformance-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
# shellcheck source=SCRIPTDIR/lib.sh
. "$ROOT/deploy/tests/lib.sh"
FENCE="$T/fence"; fence_dir "$FENCE"
chk() { # chk <name> [VAR=value ...]: rc of conformance_check, its stderr in $T/chk.err
  local n=$1; shift
  env -i PATH="$PATH" ROOT="$ROOT" "$@" bash -c ". '$ROOT/deploy/conformance.sh' && conformance_check '$n'" 2> "$T/chk.err"
}
mkdir -p "$T/wc-marked/mu-plugins" "$T/wc-plain/mu-plugins"
: > "$T/wc-marked/mu-plugins/pf-conformance-throwaway.php"; : > "$T/wc-plain/mu-plugins/other.php"

echo "1. the triggers (each planted; without CONFORMANCE=on: refused, named; with it but no THROWAWAY: refused)"
for t in "IMPORT_MU_PLUGINS=pf-conformance-throwaway.php|IMPORT_MU_PLUGINS names" \
         "IMPORT_MU_PLUGINS=a.php pf-conformance-throwaway.php|IMPORT_MU_PLUGINS names" \
         "IMPORT_PLUGINS=woocommerce woocommerce-cleanup|IMPORT_PLUGINS names woocommerce-cleanup" \
         "IMPORT_PLUGINS=woocommerce-e2e-test-helper|IMPORT_PLUGINS names woocommerce-e2e-test-helper" \
         "IMPORT_PLUGINS=gutenberg-test-plugins|IMPORT_PLUGINS names gutenberg-test-plugins" \
         "SUITE=$ROOT/tests/conformance/plugins.txt|SUITE points into tests/conformance/" \
         "SUITE=tests/conformance/plugins.txt|SUITE points into tests/conformance/" \
         "THEME_SUITE=$ROOT/tests/conformance/themes.txt|THEME_SUITE points into tests/conformance/" \
         "IMPORT_CONTENT=$T/wc-marked|IMPORT_CONTENT holds mu-plugins/pf-conformance-throwaway.php"; do
  kv=${t%%|*}; want=${t#*|}
  chk pf9x "$kv"; rc=$?
  ok "$kv: refused without CONFORMANCE=on (rc $rc), names it" "$([ $rc = 2 ] && grep -qF "$want" "$T/chk.err" && grep -q 'needs CONFORMANCE=on' "$T/chk.err" && echo 1 || echo 0)"
  chk pf9x "$kv" CONFORMANCE=on; rc=$?
  ok "  with CONFORMANCE=on but no THROWAWAY: refused (rc $rc)" "$([ $rc = 2 ] && grep -q 'needs THROWAWAY=1' "$T/chk.err" && echo 1 || echo 0)"
  chk pf9x "$kv" CONFORMANCE=on THROWAWAY=1; rc=$?
  ok "  with CONFORMANCE=on and THROWAWAY=1 on a throwaway: allowed (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"
done
chk pf9x "IMPORT_CONTENT=$T/wc-marked" IMPORT_MU_PLUGINS= IMPORT_PLUGINS=woocommerce CONFORMANCE=on; ok "the marker FILE in IMPORT_CONTENT is found even when IMPORT_* name nothing of it" "$([ $? = 2 ] && echo 1 || echo 0)"
echo "2. not conformance content: allowed, no CONFORMANCE or THROWAWAY needed (a normal deploy)"
chk pf9x; ok "no inputs" "$([ $? = 0 ] && echo 1 || echo 0)"
chk pf9x IMPORT_PLUGINS="woocommerce akismet" IMPORT_MU_PLUGINS=custom.php SUITE=/x/plugins.txt THEME_SUITE=/x/themes.txt "IMPORT_CONTENT=$T/wc-plain"; ok "a store's own inputs" "$([ $? = 0 ] && echo 1 || echo 0)"
chk pf9x IMPORT_PLUGINS=woocommerce-cleanup-extra; ok "a name that only starts like one (woocommerce-cleanup-extra)" "$([ $? = 0 ] && echo 1 || echo 0)"
for bad in 1 yes ON off; do chk pf9x CONFORMANCE=$bad; ok "CONFORMANCE=$bad: refused even without content" "$([ $? = 2 ] && grep -q 'CONFORMANCE must be on or unset' "$T/chk.err" && echo 1 || echo 0)"; done
echo "3. with the content and CONFORMANCE=on: THROWAWAY=1 and not live"
chk pf9x IMPORT_PLUGINS=woocommerce-cleanup CONFORMANCE=on THROWAWAY=1; ok "THROWAWAY=1 on a throwaway: allowed" "$([ $? = 0 ] && echo 1 || echo 0)"
chk pf9x IMPORT_PLUGINS=woocommerce-cleanup CONFORMANCE=on THROWAWAY=0; ok "THROWAWAY=0: refused" "$([ $? = 2 ] && echo 1 || echo 0)"
for live in ggc ggc-test; do chk $live IMPORT_PLUGINS=woocommerce-cleanup CONFORMANCE=on THROWAWAY=1; ok "$live (deploy/wfp/live-sites): refused even with THROWAWAY=1" "$([ $? = 2 ] && grep -q "$live is a live site (deploy/wfp/live-sites/$live" "$T/chk.err" && echo 1 || echo 0)"; done
chk zarapo IMPORT_PLUGINS=woocommerce-cleanup CONFORMANCE=on THROWAWAY=1; ok "zarapo (deploy/live-sites/<name>.env): refused even with THROWAWAY=1" "$([ $? = 2 ] && grep -q 'zarapo is a live site (deploy/live-sites/zarapo.env' "$T/chk.err" && echo 1 || echo 0)"
chk '' IMPORT_PLUGINS=woocommerce-cleanup CONFORMANCE=on THROWAWAY=1; ok "no site name: refused" "$([ $? = 2 ] && grep -q "needs the site's name" "$T/chk.err" && echo 1 || echo 0)"
echo "4. deploy/deploy.sh refuses before any step"
refuse "conformance content needs CONFORMANCE=on" VARIANT=b-dosql IMPORT_PLUGINS=woocommerce-cleanup
refuse "conformance content needs THROWAWAY=1" VARIANT=b-dosql IMPORT_PLUGINS=woocommerce-cleanup CONFORMANCE=on
refuse "conformance content needs THROWAWAY=1" VARIANT=a "IMPORT_CONTENT=$T/wc-marked" CONFORMANCE=on
refuse "ggc-test is a live site" VARIANT=b-dosql IMPORT_MU_PLUGINS=pf-conformance-throwaway.php CONFORMANCE=on THROWAWAY=1 NAME=ggc-test
echo "5. deploy/wfp/lib.sh uses the same rule"
wv() { local n=$1; shift; env -i PATH="$PATH" HOME="$T" "$@" bash -c ". '$ROOT/deploy/wfp/lib.sh' >/dev/null 2>&1; conformance_var '$n'" > "$T/wv.out" 2> "$T/wv.err"; }
wv pf9x IMPORT_PLUGINS=woocommerce-cleanup CONFORMANCE=on THROWAWAY=1; ok "a throwaway: allowed, and it renders nothing" "$([ $? = 0 ] && [ ! -s "$T/wv.out" ] && echo 1 || echo 0)"
wv ggc IMPORT_PLUGINS=woocommerce-cleanup CONFORMANCE=on THROWAWAY=1; ok "a live WfP site: refused" "$([ $? = 2 ] && grep -q 'ggc is a live site' "$T/wv.err" && echo 1 || echo 0)"
ok "render_user calls conformance_var and fails on its refusal" "$(grep -qE '^  conformance_var "\$s" \|\| return 2' "$ROOT/deploy/wfp/lib.sh" && echo 1 || echo 0)"
ok "site update checks the RECORDED inputs (after use_recorded_inputs)" "$(awk '/^update_one_inner\(\)/,/^}/' "$ROOT/deploy/wfp/site" | awk '/use_recorded_inputs/{f=1} f && /conformance_var/{n++} END{print (n ? "after" : "none")}' | grep -qx after && echo 1 || echo 0)"
echo "$fails failing case(s)"
[ "$fails" = 0 ]
