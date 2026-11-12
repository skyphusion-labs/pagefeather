#!/bin/bash
# Sourced by load-sample-store.sh: the admin-login read-back, split out so a test can drive it with a
# fake curl (tests/fixtures/tests/sample-store-login-test.sh). Needs want() and `skipped` from the caller.
#
# #354: a site with the Turnstile login gate ON answers the login POST with 200 "Please complete the
# challenge to sign in." The gate shows itself on GET wp-login.php as data-sitekey="<key>", so the
# site key is read from the site, not from the operator's environment. Then:
#   no widget                    -> log in as before
#   a Cloudflare test key that passes (AA, AB, FF) -> send the documented test token
#   anything else (a real key, or a test key that always blocks) -> the gate cannot be passed from
#     here: say "not checked", never a false pass and never a false fail.
TS_DUMMY_TOKEN="XXXX.DUMMY.TOKEN.XXXX"
TS_PASSING_TEST_KEYS=" 1x00000000000000000000AA 2x00000000000000000000AB 3x00000000000000000000FF "

# login_gate <login page file>: prints off | test | real
login_gate() {
  local key
  key=$(grep -o 'data-sitekey="[A-Za-z0-9_-]*"' "$1" | head -1 | cut -d'"' -f2 || true)
  if [ -z "$key" ]; then echo off
  elif [[ "$TS_PASSING_TEST_KEYS" == *" $key "* ]]; then echo test
  else echo real; fi
}

# admin_login_check <origin> <login> <password file> <work dir>
admin_login_check() {
  local O=$1 LOGIN=$2 PW=$3 WORK=$4 gate token="" code
  curl -s -m 120 "$O/wp-login.php" > "$WORK/login.page" || true
  gate=$(login_gate "$WORK/login.page")
  if [ "$gate" = real ]; then
    echo "  skip admin login: not checked (Turnstile gate on with a site key that cannot be passed from here)"
    skipped=$((skipped + 1))
    return 0
  fi
  [ "$gate" = test ] && token=$TS_DUMMY_TOKEN
  # A real login with the new password: wp-login answers 302 with a logged-in cookie.
  python3 -I -c 'import sys, urllib.parse; f = "log=" + urllib.parse.quote(sys.argv[1]) + "&pwd=" + urllib.parse.quote(open(sys.argv[2]).read().rstrip("\n")) + "&testcookie=1"
if sys.argv[3]: f += "&cf-turnstile-response=" + urllib.parse.quote(sys.argv[3])
print(f)' "$LOGIN" "$PW" "$token" > "$WORK/login.form"
  code=$(curl -s -o /dev/null -D "$WORK/login.h" -m 120 -b "wordpress_test_cookie=WP+Cookie+check" --data-binary "@$WORK/login.form" -w '%{http_code}' "$O/wp-login.php")
  want "admin login (302)" "$code" 302
  want "admin login sets a logged-in cookie" "$(grep -ic '^set-cookie: wordpress_logged_in' "$WORK/login.h")" 1
}
