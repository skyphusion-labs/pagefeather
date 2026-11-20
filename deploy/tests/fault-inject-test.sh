#!/usr/bin/env bash
# #730 (#589 B): FAULT_INJECT, the operator-only post-INSERT fault injector, in BOTH emitters. One rule
# (deploy/fault-inject.sh): only after-insert, only variant b-dosql, only with THROWAWAY=1, never for a live site
# (deploy/live-sites/<name>.env or deploy/wfp/live-sites/<name>). deploy/deploy.sh refuses before any step;
# deploy/wfp/lib.sh refuses in render_user. It is a measurement flag: never recorded, so an update without it
# turns it off.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/fault-inject-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
# shellcheck source=SCRIPTDIR/lib.sh
. "$ROOT/deploy/tests/lib.sh"
FENCE="$T/fence"; fence_dir "$FENCE"
chk() { # chk <variant> <name> [VAR=value ...]: rc of fault_check, its stderr in $T/chk.err
  local v=$1 n=$2; shift 2
  env -i PATH="$PATH" ROOT="$ROOT" "$@" bash -c ". '$ROOT/deploy/fault-inject.sh' && fault_check '$v' '$n'" 2> "$T/chk.err"
}
line() { env -i PATH="$PATH" ROOT="$ROOT" "$@" bash -c ". '$ROOT/deploy/fault-inject.sh' && fault_line"; }

echo "1. the one rule (deploy/fault-inject.sh)"
chk b-dosql pf9x; ok "unset: allowed, renders nothing" "$([ $? = 0 ] && [ -z "$(line)" ] && echo 1 || echo 0)"
chk b-dosql pf9x FAULT_INJECT=after-insert THROWAWAY=1; ok "after-insert with THROWAWAY=1 on a throwaway: allowed" "$([ $? = 0 ] && echo 1 || echo 0)"
ok "  and it renders FAULT_INJECT = \"after-insert\"" "$([ "$(line FAULT_INJECT=after-insert THROWAWAY=1)" = 'FAULT_INJECT = "after-insert"' ] && echo 1 || echo 0)"
chk b-dosql pf9x FAULT_INJECT=after-insert; ok "no THROWAWAY: refused (rc 2), named" "$([ $? = 2 ] && grep -q 'FAULT_INJECT needs THROWAWAY=1' "$T/chk.err" && echo 1 || echo 0)"
chk b-dosql pf9x FAULT_INJECT=after-insert THROWAWAY=0; ok "THROWAWAY=0: refused" "$([ $? = 2 ] && echo 1 || echo 0)"
chk b-dosql pf9x FAULT_INJECT=sql-fail THROWAWAY=1; ok "sql-fail (#766) with THROWAWAY=1 on a throwaway: allowed" "$([ $? = 0 ] && echo 1 || echo 0)"
ok "  and it renders FAULT_INJECT = \"sql-fail\"" "$([ "$(line FAULT_INJECT=sql-fail THROWAWAY=1)" = 'FAULT_INJECT = "sql-fail"' ] && echo 1 || echo 0)"
chk b-dosql pf9x FAULT_INJECT=sql-fail; ok "sql-fail without THROWAWAY: refused (rc 2)" "$([ $? = 2 ] && grep -q 'FAULT_INJECT needs THROWAWAY=1' "$T/chk.err" && echo 1 || echo 0)"
chk b-dosql zarapo FAULT_INJECT=sql-fail THROWAWAY=1; ok "sql-fail on a live site: refused even with THROWAWAY=1" "$([ $? = 2 ] && grep -q 'zarapo is a live site' "$T/chk.err" && echo 1 || echo 0)"
for bad in on 1 yes after_insert sql_fail ''x; do chk b-dosql pf9x FAULT_INJECT=$bad THROWAWAY=1; ok "FAULT_INJECT=$bad: refused" "$([ $? = 2 ] && grep -q 'FAULT_INJECT must be after-insert, sql-fail, email or unset' "$T/chk.err" && echo 1 || echo 0)"; done
# #1062 (strummer on cf759hx): the email rejection seam (EMAIL_FAULT=reject-N, spikes/b2-wordpress/fault-inject.mjs) had no
# deploy path on approach A. FAULT_INJECT=email arms it: it kills no isolate (N sends reject), so it is allowed on b-dosql
# AND a, the two tiers with this mail path, under the same THROWAWAY=1 and live-site rule. It needs EMAIL_FAULT=reject-N.
o=$(line FAULT_INJECT=email EMAIL_FAULT=reject-1 THROWAWAY=1)
chk a pf9x FAULT_INJECT=email EMAIL_FAULT=reject-1 THROWAWAY=1; ok "email on variant a with EMAIL_FAULT=reject-1 and THROWAWAY=1: allowed" "$([ $? = 0 ] && echo 1 || echo 0)"
ok "  and it renders FAULT_INJECT = \"email\" and EMAIL_FAULT = \"reject-1\"" "$([ "$o" = "$(printf 'FAULT_INJECT = "email"\nEMAIL_FAULT = "reject-1"')" ] && echo 1 || echo 0)"
chk b-dosql pf9x FAULT_INJECT=email EMAIL_FAULT=reject-3 THROWAWAY=1; ok "email on b-dosql: allowed" "$([ $? = 0 ] && echo 1 || echo 0)"
for v in b-do c1; do chk $v pf9x FAULT_INJECT=email EMAIL_FAULT=reject-1 THROWAWAY=1; ok "email on variant $v: refused" "$([ $? = 2 ] && grep -q 'FAULT_INJECT=email is for variant a or b-dosql' "$T/chk.err" && echo 1 || echo 0)"; done
chk a pf9x FAULT_INJECT=email THROWAWAY=1; ok "email without EMAIL_FAULT: refused, named" "$([ $? = 2 ] && grep -q 'FAULT_INJECT=email needs EMAIL_FAULT=reject-N' "$T/chk.err" && echo 1 || echo 0)"
for bad in reject-0 reject-1000 reject on 1 'reject-1 '; do chk a pf9x FAULT_INJECT=email "EMAIL_FAULT=$bad" THROWAWAY=1; ok "EMAIL_FAULT=$bad: refused" "$([ $? = 2 ] && grep -q 'EMAIL_FAULT must be reject-N' "$T/chk.err" && echo 1 || echo 0)"; done
chk a pf9x EMAIL_FAULT=reject-1 THROWAWAY=1; ok "EMAIL_FAULT without FAULT_INJECT=email: refused (a half-armed seam)" "$([ $? = 2 ] && grep -q 'EMAIL_FAULT needs FAULT_INJECT=email' "$T/chk.err" && echo 1 || echo 0)"
chk b-dosql pf9x FAULT_INJECT=sql-fail EMAIL_FAULT=reject-1 THROWAWAY=1; ok "EMAIL_FAULT with another fault: refused" "$([ $? = 2 ] && grep -q 'EMAIL_FAULT needs FAULT_INJECT=email' "$T/chk.err" && echo 1 || echo 0)"
chk a pf9x FAULT_INJECT=email EMAIL_FAULT=reject-1; ok "email without THROWAWAY: refused" "$([ $? = 2 ] && grep -q 'FAULT_INJECT needs THROWAWAY=1' "$T/chk.err" && echo 1 || echo 0)"
chk a zarapo FAULT_INJECT=email EMAIL_FAULT=reject-1 THROWAWAY=1; ok "email on a live site: refused even with THROWAWAY=1" "$([ $? = 2 ] && grep -q 'zarapo is a live site' "$T/chk.err" && echo 1 || echo 0)"
chk a pf9x FAULT_INJECT=after-insert THROWAWAY=1; ok "after-insert stays b-dosql only" "$([ $? = 2 ] && grep -q 'FAULT_INJECT is for variant b-dosql' "$T/chk.err" && echo 1 || echo 0)"
for v in a b-do c1; do chk $v pf9x FAULT_INJECT=after-insert THROWAWAY=1; ok "variant $v: refused (frames are b-dosql)" "$([ $? = 2 ] && grep -q 'FAULT_INJECT is for variant b-dosql' "$T/chk.err" && echo 1 || echo 0)"; done
chk b-dosql zarapo FAULT_INJECT=after-insert THROWAWAY=1; ok "a deploy/live-sites/<name>.env site: refused even with THROWAWAY=1" "$([ $? = 2 ] && grep -q 'zarapo is a live site (deploy/live-sites/zarapo.env)' "$T/chk.err" && echo 1 || echo 0)"
chk b-dosql ggc FAULT_INJECT=after-insert THROWAWAY=1; ok "a deploy/wfp/live-sites/<name> site: refused even with THROWAWAY=1" "$([ $? = 2 ] && grep -q 'ggc is a live site (deploy/wfp/live-sites/ggc)' "$T/chk.err" && echo 1 || echo 0)"
chk b-dosql '' FAULT_INJECT=after-insert THROWAWAY=1; ok "no site name: refused (a nameless run cannot be checked against the live list)" "$([ $? = 2 ] && echo 1 || echo 0)"

echo "2. deploy/deploy.sh refuses before any step"
refuse "FAULT_INJECT needs THROWAWAY=1" VARIANT=b-dosql FAULT_INJECT=after-insert
refuse "FAULT_INJECT is for variant b-dosql" VARIANT=a FAULT_INJECT=after-insert THROWAWAY=1
refuse "FAULT_INJECT must be after-insert, sql-fail, email or unset" VARIANT=b-dosql FAULT_INJECT=on THROWAWAY=1
refuse "ggc-test is a live site" VARIANT=b-dosql FAULT_INJECT=after-insert THROWAWAY=1 NAME=ggc-test
ok "render-conf.sh renders the line through fault_line" "$(grep -q 'fault_line' "$ROOT/deploy/render-conf.sh" && grep -q 'fault-inject.sh' "$ROOT/deploy/deploy.sh" && echo 1 || echo 0)"

echo "3. deploy/wfp/lib.sh (render_user) uses the same rule"
wv() { local n=$1; shift; env -i PATH="$PATH" HOME="$T" "$@" bash -c ". '$ROOT/deploy/wfp/lib.sh' >/dev/null 2>&1; fault_inject_var '$n'" 2> "$T/wv.err"; }
o=$(wv pf9x FAULT_INJECT=after-insert THROWAWAY=1); rc=$?
ok "a throwaway with THROWAWAY=1 renders the line (rc $rc)" "$([ $rc = 0 ] && [ "$o" = 'FAULT_INJECT = "after-insert"' ] && echo 1 || echo 0)"
o=$(wv pf9x); ok "unset renders nothing" "$([ $? = 0 ] && [ -z "$o" ] && echo 1 || echo 0)"
wv pf9x FAULT_INJECT=after-insert > /dev/null; ok "no THROWAWAY: refused" "$([ $? = 2 ] && grep -q 'needs THROWAWAY=1' "$T/wv.err" && echo 1 || echo 0)"
wv ggc-test FAULT_INJECT=after-insert THROWAWAY=1 > /dev/null; ok "a live WfP site: refused even with THROWAWAY=1" "$([ $? = 2 ] && grep -q 'ggc-test is a live site' "$T/wv.err" && echo 1 || echo 0)"
o=$(wv pf9x FAULT_INJECT=email EMAIL_FAULT=reject-2 THROWAWAY=1); ok "#1062 wfp: email renders both lines" "$([ $? = 0 ] && [ "$o" = "$(printf 'FAULT_INJECT = "email"\nEMAIL_FAULT = "reject-2"')" ] && echo 1 || echo 0)"
ok "#1062 EMAIL_FAULT is a measurement flag too (never recorded)" "$(python3 -I -c 'import sys; sys.path.insert(0, sys.argv[1]); import site_settings as s; print(int("EMAIL_FAULT" in s.MEASUREMENT))' "$ROOT/deploy/wfp" 2>/dev/null)"
ok "render_user calls fault_inject_var and fails on its refusal" "$(grep -qE 'fault=\$\(fault_inject_var "\$s"\) \|\| return' "$ROOT/deploy/wfp/lib.sh" && echo 1 || echo 0)"
ok "FAULT_INJECT is a measurement flag (site_settings.py MEASUREMENT): never recorded" "$(python3 -I -c 'import sys; sys.path.insert(0, sys.argv[1]); import site_settings as s; print(int("FAULT_INJECT" in s.MEASUREMENT and "FAULT_INJECT" not in s.SETTINGS if hasattr(s, "SETTINGS") else "FAULT_INJECT" in s.MEASUREMENT))' "$ROOT/deploy/wfp" 2>/dev/null)"
echo "$fails failing case(s)"
[ "$fails" = 0 ]
