#!/bin/bash
# #354: the sample-store loader's admin-login read-back against a Turnstile-gated login.
#   tests/fixtures/tests/sample-store-login-test.sh
# Drives admin_login_check (sourced from sample-store-login.sh, the same file the loader sources)
# with a fake curl that behaves like a gated wp-login.php: GET serves the widget (or not), POST
# answers 302 + a logged-in cookie only when the token the gate wants is in the form, else 200.
# A stub proves the decision path, not the live site; the live proof is a real load on a gated site.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
fails=0
check() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }

T=$(mktemp -d "${TMPDIR:-/tmp}/ss-login-test.XXXXXX"); trap 'rm -rf "$T"' EXIT
mkdir "$T/bin"
cat > "$T/bin/curl" <<'FAKE'
#!/bin/bash
# fake curl: GET -> $FAKE_PAGE; POST (--data-binary @file) -> $FAKE_LOG gets the form, answer by $FAKE_WANT
out=""; dump=""; form=""; fmt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift ;; -D) dump=$2; shift ;; -w) fmt=$2; shift ;;
    --data-binary) form=${2#@}; shift ;;
    -m|-b) shift ;;
  esac
  shift
done
if [ -z "$form" ]; then cat "$FAKE_PAGE"; exit 0; fi
cp "$form" "$FAKE_LOG"
if [ -z "$FAKE_WANT" ] || grep -q "cf-turnstile-response=$FAKE_WANT" "$form"; then
  printf 'HTTP/2 302\r\nset-cookie: wordpress_logged_in_x=1; path=/\r\n' > "$dump"; code=302
else
  printf 'HTTP/2 200\r\n' > "$dump"; code=200
fi
[ -n "$fmt" ] && printf '%s' "$code"
exit 0
FAKE
chmod +x "$T/bin/curl"
export PATH="$T/bin:$PATH"

printf 'hunter2\n' > "$T/pw"
fails_in=0; skipped=0
want() { if [ "$2" = "$3" ]; then echo "  ok   $1: $2"; else echo "  FAIL $1: got $2, want $3"; fails_in=$((fails_in + 1)); fi; }
# shellcheck disable=SC1091
. "$HERE/../sample-store-login.sh"

run() { # run <page html> <token the gate wants, empty = no gate>
  printf '%s\n' "$1" > "$T/page"; : > "$T/log"
  export FAKE_PAGE="$T/page" FAKE_LOG="$T/log" FAKE_WANT="$2"
  fails_in=0; skipped=0
  # Not in $( ): a subshell would lose the want() and skipped counters this test reads.
  admin_login_check "https://site.example" "admin" "$T/pw" "$T" > "$T/out" 2>&1
  out=$(cat "$T/out")
}

# 1. Control: no gate, no token sent, plain login passes.
run '<form id="loginform"></form>' ""
check "no gate: login checks pass" "$([ "$fails_in" = 0 ] && [ "$skipped" = 0 ] && echo 1 || echo 0)"
check "no gate: no cf-turnstile-response in the form" "$(grep -q cf-turnstile-response "$T/log" && echo 0 || echo 1)"

# 2. The test key (#342 wires TURNSTILE_SITEKEY=1x00...AA): the test token is sent, and the login passes.
run '<div class="cf-turnstile" data-sitekey="1x00000000000000000000AA" data-action="turnstile-spin-v1"></div>' "XXXX.DUMMY.TOKEN.XXXX"
check "test key: the dummy token is in the login POST" "$(grep -q 'cf-turnstile-response=XXXX.DUMMY.TOKEN.XXXX' "$T/log" && echo 1 || echo 0)"
check "test key: the gated login passes (302 + cookie)" "$([ "$fails_in" = 0 ] && [ "$skipped" = 0 ] && echo 1 || echo 0)"

# 3. The other passing test keys (invisible, forced interactive) are test keys too.
for k in 2x00000000000000000000AB 3x00000000000000000000FF; do
  run "<div class=\"cf-turnstile\" data-sitekey=\"$k\"></div>" "XXXX.DUMMY.TOKEN.XXXX"
  check "test key $k: login passes" "$([ "$fails_in" = 0 ] && echo 1 || echo 0)"
done

# 4. A real key cannot pass the gate: say so. Not a pass (no want line), not a fail (no FAIL), no POST.
run '<div class="cf-turnstile" data-sitekey="0x4AAAAAAAbCdEfGhIjKlMn"></div>' "REALTOKEN"
check "real key: reported as not checked" "$(printf '%s' "$out" | grep -q 'not checked (Turnstile gate on' && echo 1 || echo 0)"
check "real key: counted as skipped, not failed" "$([ "$skipped" = 1 ] && [ "$fails_in" = 0 ] && echo 1 || echo 0)"
check "real key: no false pass line" "$(printf '%s' "$out" | grep -q 'ok   admin login' && echo 0 || echo 1)"
check "real key: no login POST was sent" "$([ ! -s "$T/log" ] && echo 1 || echo 0)"

# 5. A test key that ALWAYS BLOCKS (1x..BB) cannot be passed either: not checked, not a false fail.
run '<div class="cf-turnstile" data-sitekey="1x00000000000000000000BB"></div>' "REALTOKEN"
check "always-blocks test key: not checked" "$([ "$skipped" = 1 ] && [ "$fails_in" = 0 ] && echo 1 || echo 0)"

# 6. A gate that wants a token we did not send still FAILS (the check can go red).
run '<form></form>' "XXXX.DUMMY.TOKEN.XXXX"
check "gate on but no widget seen: the login check fails (can go red)" "$([ "$fails_in" = 2 ] && echo 1 || echo 0)"

[ "$fails" = 0 ] || { echo "$fails check(s) failed" >&2; exit 1; }
echo "all passed"
