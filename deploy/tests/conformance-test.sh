#!/usr/bin/env bash
# #759: CONFORMANCE, the switch that loads the upstream test plugins (password Basic auth, an option-setting REST
# route, a store-wiping REST route), in BOTH emitters. One rule (deploy/conformance.sh): only "on", only with
# THROWAWAY=1, never for a live site (deploy/live-sites/<name>.env or deploy/wfp/live-sites/<name>), any variant.
# deploy/deploy.sh refuses before any step; deploy/wfp/lib.sh refuses in render_user. It is a measurement flag:
# never recorded, so an update without it turns it off. The same shape as fault-inject-test.sh (#730).
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
line() { env -i PATH="$PATH" ROOT="$ROOT" "$@" bash -c ". '$ROOT/deploy/conformance.sh' && conformance_line"; }

echo "1. the one rule (deploy/conformance.sh)"
chk pf9x; ok "unset: allowed, renders nothing" "$([ $? = 0 ] && [ -z "$(line)" ] && echo 1 || echo 0)"
chk pf9x CONFORMANCE=on THROWAWAY=1; ok "on with THROWAWAY=1 on a throwaway: allowed" "$([ $? = 0 ] && echo 1 || echo 0)"
ok "  and it renders CONFORMANCE = \"on\"" "$([ "$(line CONFORMANCE=on THROWAWAY=1)" = 'CONFORMANCE = "on"' ] && echo 1 || echo 0)"
chk pf9x CONFORMANCE=on; ok "no THROWAWAY: refused (rc 2), named" "$([ $? = 2 ] && grep -q 'CONFORMANCE needs THROWAWAY=1' "$T/chk.err" && echo 1 || echo 0)"
chk pf9x CONFORMANCE=on THROWAWAY=0; ok "THROWAWAY=0: refused" "$([ $? = 2 ] && echo 1 || echo 0)"
for bad in 1 yes ON true off ''x; do chk pf9x CONFORMANCE=$bad THROWAWAY=1; ok "CONFORMANCE=$bad: refused" "$([ $? = 2 ] && grep -q 'CONFORMANCE must be on or unset' "$T/chk.err" && echo 1 || echo 0)"; done
chk zarapo CONFORMANCE=on THROWAWAY=1; ok "a deploy/live-sites/<name>.env site: refused even with THROWAWAY=1" "$([ $? = 2 ] && grep -q 'zarapo is a live site (deploy/live-sites/zarapo.env)' "$T/chk.err" && echo 1 || echo 0)"
chk ggc CONFORMANCE=on THROWAWAY=1; ok "a deploy/wfp/live-sites/<name> site (ggc): refused even with THROWAWAY=1" "$([ $? = 2 ] && grep -q 'ggc is a live site (deploy/wfp/live-sites/ggc)' "$T/chk.err" && echo 1 || echo 0)"
chk ggc-test CONFORMANCE=on THROWAWAY=1; ok "ggc-test: refused even with THROWAWAY=1" "$([ $? = 2 ] && grep -q 'ggc-test is a live site' "$T/chk.err" && echo 1 || echo 0)"
chk '' CONFORMANCE=on THROWAWAY=1; ok "no site name: refused (a nameless run cannot be checked against the live list)" "$([ $? = 2 ] && grep -q "needs the site's name" "$T/chk.err" && echo 1 || echo 0)"

echo "2. deploy/deploy.sh refuses before any step"
refuse "CONFORMANCE needs THROWAWAY=1" VARIANT=b-dosql CONFORMANCE=on
refuse "CONFORMANCE needs THROWAWAY=1" VARIANT=a CONFORMANCE=on
refuse "CONFORMANCE must be on or unset" VARIANT=b-dosql CONFORMANCE=1 THROWAWAY=1
refuse "ggc-test is a live site" VARIANT=b-dosql CONFORMANCE=on THROWAWAY=1 NAME=ggc-test
ok "render-conf.sh renders the line through conformance_line" "$(grep -q 'conformance_line' "$ROOT/deploy/render-conf.sh" && grep -q 'conformance.sh' "$ROOT/deploy/deploy.sh" && echo 1 || echo 0)"

echo "3. deploy/wfp/lib.sh (render_user) uses the same rule"
wv() { local n=$1; shift; env -i PATH="$PATH" HOME="$T" "$@" bash -c ". '$ROOT/deploy/wfp/lib.sh' >/dev/null 2>&1; conformance_var '$n'" 2> "$T/wv.err"; }
o=$(wv pf9x CONFORMANCE=on THROWAWAY=1); rc=$?
ok "a throwaway with THROWAWAY=1 renders the line (rc $rc)" "$([ $rc = 0 ] && [ "$o" = 'CONFORMANCE = "on"' ] && echo 1 || echo 0)"
o=$(wv pf9x); ok "unset renders nothing" "$([ $? = 0 ] && [ -z "$o" ] && echo 1 || echo 0)"
wv pf9x CONFORMANCE=on > /dev/null; ok "no THROWAWAY: refused" "$([ $? = 2 ] && grep -q 'needs THROWAWAY=1' "$T/wv.err" && echo 1 || echo 0)"
wv ggc CONFORMANCE=on THROWAWAY=1 > /dev/null; ok "a live WfP site (ggc): refused even with THROWAWAY=1" "$([ $? = 2 ] && grep -q 'ggc is a live site' "$T/wv.err" && echo 1 || echo 0)"
ok "render_user calls conformance_var and fails on its refusal" "$(grep -qE 'conf=\$\(conformance_var "\$s"\) \|\| return' "$ROOT/deploy/wfp/lib.sh" && echo 1 || echo 0)"
ok "CONFORMANCE is a measurement flag (site_settings.py MEASUREMENT): never recorded" "$(python3 -I -c 'import sys; sys.path.insert(0, sys.argv[1]); import site_settings as s; print(int("CONFORMANCE" in s.MEASUREMENT))' "$ROOT/deploy/wfp" 2>/dev/null)"
echo "$fails failing case(s)"
[ "$fails" = 0 ]
