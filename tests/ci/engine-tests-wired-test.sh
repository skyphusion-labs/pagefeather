#!/bin/bash
# #1010: every engine unit test is named in a workflow, so CI can go red on it. A test that no
# workflow runs reads like a passed one: on 2026-11-20 seven of them (comment-rest-headroom-test.php,
# wp-mail-queue-test.php, slash-path, purge-after-php, template-boot, ocv-missing and
# remote-perf-boot .test.mjs) ran nowhere; CI only ran `php -l` on the PHP ones.
#   tests/ci/engine-tests-wired-test.sh [tests dir] [workflows dir]
# A test counts as wired when its file name appears in a workflow file. It prints every unwired test
# and the count of tests it checked (the denominator), and exits 1 on any unwired one or on zero tests.
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TD=${1:-$ROOT/spikes/b2-wordpress/tests}
WD=${2:-$ROOT/.github/workflows}
n=0 bad=0
for f in "$TD"/*-test.php "$TD"/*.test.mjs; do
  [ -e "$f" ] || continue
  n=$((n + 1))
  b=$(basename "$f")
  if ! grep -rqF -- "$b" "$WD"; then echo "  UNWIRED $b (no workflow under $WD names it)"; bad=$((bad + 1)); fi
done
echo "engine tests checked: $n, unwired: $bad"
[ "$n" -gt 0 ] || { echo "  no test file found under $TD: the check measured nothing" >&2; exit 1; }
[ "$bad" = 0 ]
