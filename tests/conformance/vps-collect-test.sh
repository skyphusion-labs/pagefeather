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
# 4. missing arguments: a usage error, not a collect.
$V > /dev/null 2>&1; rc=$?
[ "$rc" != 0 ] && ok "no run-dir: refused (exit $rc)" || bad "no run-dir: exit 0"
[ "$fail" = 0 ] && echo "vps-collect-test: all ok" || { echo "vps-collect-test: FAILED"; exit 1; }
