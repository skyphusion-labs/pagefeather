#!/bin/bash
# #1000: vps-run.sh install gb fetches every browser the Gutenberg pin starts.
# The pin's test/e2e/playwright.config.ts starts chromium, webkit (grep @webkit)
# and firefox (grep @firefox). Chromium alone makes the other projects fail at
# launch ("Executable doesn't exist"). A stock gb run then counts them as unexpected.
# DRY=1 prints the install commands and downloads nothing.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d "${TMPDIR:-/tmp}/vps-gb-browsers-test.XXXXXX"); trap 'rm -rf "$t"' EXIT
fail=0
ok() { echo "ok: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

DRY=1 bash "$here/vps-run.sh" install gb "$t/work" >"$t/out" 2>"$t/err"; rc=$?
[ "$rc" = 0 ] && ok "install gb dry: exit 0" || bad "install gb dry: exit $rc"
n=$(grep -c 'npx playwright install --with-deps' "$t/out" || true)
[ "$n" = 1 ] && ok "install gb dry: one playwright install line" || bad "install gb dry: $n playwright install lines, want 1"
want='npx playwright install --with-deps chromium firefox webkit)'
grep -qF "$want" "$t/out" && ok "install gb fetches chromium, firefox and webkit" || bad "install gb line does not end with: $want"
if grep -qE 'npx playwright install --with-deps chromium\)' "$t/out"; then
  bad "install gb fetches Chromium only"
else
  ok "install gb is not Chromium only"
fi

[ "$fail" = 0 ] && echo "vps-gb-browsers-test: all ok" || { echo "vps-gb-browsers-test: FAILED"; echo '--- stdout ---'; cat "$t/out"; echo '--- stderr ---'; cat "$t/err"; exit 1; }
