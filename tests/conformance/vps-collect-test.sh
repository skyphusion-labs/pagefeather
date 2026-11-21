#!/bin/bash
# #1211: vps-run.sh collect tars <run-dir>/test-results (Playwright's outputDir copy), and STOPS (exit 3) when there is
# nothing to collect, instead of writing an empty archive (sb1120 wcb2 tarred the wrong folder and lost every trace).
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d "${TMPDIR:-/tmp}/vps-collect-test.XXXXXX"); trap 'rm -rf "$t"' EXIT
fail=0
ok() { echo "ok: $1"; }
bad() { echo "FAIL: $1"; fail=1; }
V="bash $here/vps-run.sh collect wc $t/work"
# 1. no test-results folder: exit 3, no tarball.
mkdir -p "$t/run1/artifacts"; touch "$t/run1/artifacts/trace.zip"
$V "$t/run1" "$t/run1.tgz" > "$t/o1" 2>&1; rc=$?
[ "$rc" = 3 ] && ok "no test-results: exit 3" || bad "no test-results: exit $rc, want 3"
[ ! -e "$t/run1.tgz" ] && ok "no test-results: no tarball" || bad "no test-results: a tarball was written"
grep -q "STOP: no .*test-results" "$t/o1" && ok "no test-results: says why" || bad "no test-results: no STOP line"
# 2. an empty test-results folder: exit 3, no tarball.
mkdir -p "$t/run2/test-results/x"
$V "$t/run2" "$t/run2.tgz" > "$t/o2" 2>&1; rc=$?
[ "$rc" = 3 ] && ok "empty test-results: exit 3" || bad "empty test-results: exit $rc, want 3"
[ ! -e "$t/run2.tgz" ] && ok "empty test-results: no tarball" || bad "empty test-results: a tarball was written"
# 3. a real one: exit 0, the archive holds the traces, and the counts are printed.
mkdir -p "$t/run3/test-results/a-e2e-pf" "$t/run3/test-results/b-e2e-pf"
echo z > "$t/run3/test-results/a-e2e-pf/trace.zip"; echo z > "$t/run3/test-results/b-e2e-pf/trace.zip"; echo p > "$t/run3/test-results/b-e2e-pf/test-failed-1.png"
$V "$t/run3" "$t/run3.tgz" > "$t/o3" 2>&1; rc=$?
[ "$rc" = 0 ] && ok "test-results: exit 0" || { bad "test-results: exit $rc, want 0"; cat "$t/o3"; }
n=$(tar -tzf "$t/run3.tgz" 2>/dev/null | grep -c 'trace.zip$'); [ "$n" = 2 ] && ok "test-results: 2 trace.zip in the archive" || bad "test-results: $n trace.zip in the archive, want 2"
grep -q "collected 3 files .*2 trace.zip, 1 png, 0 webm" "$t/o3" && ok "test-results: counts printed" || { bad "test-results: counts line"; cat "$t/o3"; }
# 3b. #1265: the wp and gb suites write their outputDir under <run-dir>/artifacts/test-results. collect finds it there, and
# the archive opens to test-results/ as the wc one does.
for su in wp gb; do
  mkdir -p "$t/run-$su/artifacts/test-results/x-chromium"; echo z > "$t/run-$su/artifacts/test-results/x-chromium/trace.zip"
  bash "$here/vps-run.sh" collect $su "$t/work" "$t/run-$su" "$t/run-$su.tgz" > "$t/o-$su" 2>&1; rc=$?
  [ "$rc" = 0 ] && ok "$su: collect reads artifacts/test-results (exit 0)" || { bad "$su: exit $rc, want 0"; cat "$t/o-$su"; }
  n=$(tar -tzf "$t/run-$su.tgz" 2>/dev/null | grep -c '^test-results/.*trace.zip$'); [ "$n" = 1 ] && ok "$su: the archive holds test-results/.../trace.zip" || bad "$su: $n trace.zip under test-results/ in the archive, want 1"
done
# 3c. a wc run dir holds no artifacts/test-results path, and a wp run dir no top-level one: each suite reads only its own.
mkdir -p "$t/run-wcx/artifacts/test-results/y"; echo z > "$t/run-wcx/artifacts/test-results/y/trace.zip"
bash "$here/vps-run.sh" collect wc "$t/work" "$t/run-wcx" "$t/run-wcx.tgz" > /dev/null 2>&1; rc=$?
[ "$rc" = 3 ] && ok "wc: a run dir with only artifacts/test-results is a STOP (exit 3), not the wp folder" || bad "wc on artifacts-only: exit $rc, want 3"
mkdir -p "$t/run-wpx/test-results/y"; echo z > "$t/run-wpx/test-results/y/trace.zip"
bash "$here/vps-run.sh" collect wp "$t/work" "$t/run-wpx" "$t/run-wpx.tgz" > /dev/null 2>&1; rc=$?
[ "$rc" = 3 ] && ok "wp: a run dir with only test-results is a STOP (exit 3)" || bad "wp on top-level-only: exit $rc, want 3"
# 3d. an unknown suite is refused and writes no archive (the lead's review: an empty folder name would tar the whole run
# directory, which holds <run>/env with the site passwords). Whichever layer refuses it, no tarball and a non-zero exit.
mkdir -p "$t/run-unk/test-results/x"; echo z > "$t/run-unk/test-results/x/trace.zip"; echo "WP_PASSWORD=secret" > "$t/run-unk/env"
bash "$here/vps-run.sh" collect nosuch "$t/work" "$t/run-unk" "$t/run-unk.tgz" > "$t/o-unk" 2>&1; rc=$?
[ "$rc" != 0 ] && [ ! -e "$t/run-unk.tgz" ] && ok "an unknown suite is refused (exit $rc) and writes no archive" || bad "unknown suite: exit $rc, tarball $( [ -e "$t/run-unk.tgz" ] && echo WRITTEN || echo none)"
# The collect step's own guard, reached directly: with the top-level suite list bypassed, collect still STOPS on a name
# it has no folder for (exit 3), never an empty-folder tar.
grep -q "\*) echo \"vps-run: STOP: collect has no trace folder for suite" "$here/vps-run.sh" && ok "collect has its own STOP for a suite with no trace folder" || bad "collect lacks its own unknown-suite STOP"
# 5. #1291: credentials are redacted before anything is collected. Both shapes a failing request's dump prints:
# URL userinfo and an Authorization header in any quoting. CRED counts what must never survive.
CRED='://[^/ :@"'"'"']+:[^@ "'"'"'/*]+@|[Aa]uthorization["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?[[:space:]]*([Bb]asic|[Bb]earer)[[:space:]]+[A-Za-z0-9+/=._~-]{4,}'
fx="$t/fixture.log"
cat > "$fx" <<'FX'
_currentUrl: 'https://admin:secretPW123@wp-x.example.workers.dev/wp-json/wc/v3/taxes/7',
responseUrl: 'https://admin:secretPW123@wp-x.example.workers.dev/wp-json/',
  authorization: 'Basic YWRtaW46c2VjcmV0UFcxMjM=',
Authorization: Basic YWRtaW46c2VjcmV0UFcxMjM=
{"authorization":"Bearer abc.def.ghi-123"}
    - authorization: Basic YWRtaW46c2VjcmV0UFcxMjM=
FX
grep -Eq "$CRED" "$fx" && ok "redact fixture: the planted credentials are found before (the check can see them)" || bad "redact fixture: CRED finds nothing (the check is blind)"
python3 -I "$here/redact.py" "$fx" > "$t/r5" 2>&1; rc=$?
n=$(grep -Ec "$CRED" "$fx" || true)
[ "$rc" = 0 ] && [ "$n" = 0 ] && ok "redact: 0 credential matches left in the fixture" || { bad "redact: exit $rc, $n matches left"; cat "$fx"; }
grep -q "https://admin:\*\*\*@wp-x.example.workers.dev" "$fx" && ok "redact: admin:secret@ is written as admin:***@" || bad "redact: no admin:***@"
grep -q "Authorization: Basic \*\*\*" "$fx" && grep -q '"authorization":"Bearer \*\*\*"' "$fx" && ok "redact: Basic and Bearer values become ***" || bad "redact: a header value survived"
grep -q "^redact: [0-9]* credential matches redacted in 1 of 1 files" "$t/r5" && ok "redact: prints one summary line" || { bad "redact summary"; cat "$t/r5"; }
printf 'a clean line\nhttps://wp-x.example.workers.dev/wp-json/ user@example.org\nAuthorization header absent\n' > "$t/clean.log"; cp "$t/clean.log" "$t/clean.orig"
python3 -I "$here/redact.py" "$t/clean.log" > /dev/null 2>&1
cmp -s "$t/clean.log" "$t/clean.orig" && ok "redact: a clean log comes out byte-identical" || bad "redact: a clean log was changed"
printf 'PK\0\0Authorization: Basic YWRtaW46c2VjcmV0UFcxMjM=' > "$t/bin.dat"; cp "$t/bin.dat" "$t/bin.orig"
python3 -I "$here/redact.py" "$t/bin.dat" > /dev/null 2>&1
cmp -s "$t/bin.dat" "$t/bin.orig" && ok "redact: a binary file (a NUL in it) is left as it is" || bad "redact: a binary file was rewritten"
python3 -I "$here/redact.py" "$t/no-such-path" > /dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok "redact: a missing path is exit 2 (a STOP for collect)" || bad "redact: a missing path exit $rc, want 2"
# 6. collect redacts the collected text files and the run's report.json before archiving; trace.zip stays as it is.
mkdir -p "$t/run6/test-results/c-e2e-pf"
printf "responseUrl: 'https://admin:secretPW123@h.example/x'\n  authorization: 'Basic YWRtaW46c2VjcmV0UFcxMjM='\n" > "$t/run6/test-results/c-e2e-pf/error-context.md"
grep -Eq "$CRED" "$t/run6/test-results/c-e2e-pf/error-context.md" && ok "collect fixture: credentials are present before collect" || bad "collect fixture: no credentials to redact (a blind test)"
printf 'PK\0\0Authorization: Basic YWRtaW46c2VjcmV0UFcxMjM=' > "$t/run6/test-results/c-e2e-pf/trace.zip"; cp "$t/run6/test-results/c-e2e-pf/trace.zip" "$t/trace6.orig"
printf '{"error":{"message":"responseUrl: https://admin:secretPW123@h.example/wp-json/"}}\n' > "$t/run6/report.json"
$V "$t/run6" "$t/run6.tgz" > "$t/o6" 2>&1; rc=$?
[ "$rc" = 0 ] && ok "collect with credentials: exit 0" || { bad "collect with credentials: exit $rc"; cat "$t/o6"; }
mkdir -p "$t/x6"; tar -xzf "$t/run6.tgz" -C "$t/x6" 2>/dev/null
n=$(grep -Ec "$CRED" "$t/x6/test-results/c-e2e-pf/error-context.md" 2>/dev/null || true)
[ -f "$t/x6/test-results/c-e2e-pf/error-context.md" ] && [ "$n" = 0 ] && ok "collect: the archived error-context.md has 0 credential matches" || bad "collect: $n credential matches in the archived error-context.md"
n=$(grep -Ec "$CRED" "$t/run6/report.json" || true)
[ "$n" = 0 ] && grep -q "admin:\*\*\*@" "$t/run6/report.json" && ok "collect: report.json is redacted in place" || bad "collect: report.json kept $n credential matches"
cmp -s "$t/x6/test-results/c-e2e-pf/trace.zip" "$t/trace6.orig" && ok "collect: trace.zip is archived as it is (traces stay laptop-only)" || bad "collect: trace.zip was changed"
# 7. the redact action, for a box script's own run log.
printf "responseUrl: 'https://admin:secretPW123@h.example/x'\n" > "$t/run7.log"
bash "$here/vps-run.sh" redact "$t/run7.log" > /dev/null 2>&1; rc=$?
n=$(grep -Ec "$CRED" "$t/run7.log" || true)
[ "$rc" = 0 ] && [ "$n" = 0 ] && ok "vps-run.sh redact <log>: 0 credential matches left" || bad "vps-run.sh redact: exit $rc, $n left"
# 4. missing arguments: a usage error, not a collect.
$V > /dev/null 2>&1; rc=$?
[ "$rc" != 0 ] && ok "no run-dir: refused (exit $rc)" || bad "no run-dir: exit 0"
[ "$fail" = 0 ] && echo "vps-collect-test: all ok" || { echo "vps-collect-test: FAILED"; exit 1; }
