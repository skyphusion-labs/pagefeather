#!/bin/bash
# Test of the deploy/wfp Turnstile wiring (#340): lib.sh turnstile_vars / render_user and
# site_secrets_json. No account, no network.
#   deploy/wfp/tests/turnstile-wiring-test.sh [another lib.sh]
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=${1:-$HERE/../lib.sh}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
# shellcheck disable=SC1090
. "$LIB"
fails=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
R=https://wp-one.sub.workers.dev
KEY=1x00000000000000000000AA
SECRET=1x0000000000000000000000000000000AA
# render_user: off by default, the site key in [vars] when set, the switches only as "off".
ok "no TURNSTILE_SITEKEY: no TURNSTILE var is rendered" "$(render_user one $R | grep -c '^TURNSTILE' | grep -qx 0 && echo 1 || echo 0)"
out=$(TURNSTILE_SITEKEY=$KEY render_user one $R)
ok "TURNSTILE_SITEKEY renders in [vars]" "$(printf '%s\n' "$out" | sed -n '/^\[vars\]/,/^\[/p' | grep -qx "TURNSTILE_SITEKEY = \"$KEY\"" && echo 1 || echo 0)"
out=$(TURNSTILE_SITEKEY=$KEY TURNSTILE_WOO=off TURNSTILE_COMMENTS=off render_user one $R)
ok "TURNSTILE_WOO=off and TURNSTILE_COMMENTS=off render, TURNSTILE_LOGIN does not" "$(printf '%s\n' "$out" | grep -cE '^TURNSTILE_WOO = "off"$|^TURNSTILE_COMMENTS = "off"$' | grep -qx 2 && ! printf '%s\n' "$out" | grep -q '^TURNSTILE_LOGIN' && echo 1 || echo 0)"
ok "a site key with a quote (TOML injection) fails the render" "$(TURNSTILE_SITEKEY='ab"cd' render_user one $R >/dev/null 2>&1 && echo 0 || echo 1)"
ok "a site key over 64 characters fails the render" "$(TURNSTILE_SITEKEY=$(printf 'a%.0s' $(seq 1 65)) render_user one $R >/dev/null 2>&1 && echo 0 || echo 1)"
ok "a switch other than off fails the render" "$(TURNSTILE_SITEKEY=$KEY TURNSTILE_WOO=on render_user one $R >/dev/null 2>&1 && echo 0 || echo 1)"
ok "the secret never reaches the rendered config" "$(TURNSTILE_SITEKEY=$KEY TURNSTILE_SECRET=$SECRET render_user one $R | grep -c "$SECRET" | grep -qx 0 && echo 1 || echo 0)"
# site_secrets_json: the workspace secrets, plus TURNSTILE_SECRET from the environment.
tf='{"wp_salt":{"value":"salt-1"},"spike_token":{"value":"tok-1"},"hostname":{"value":"h"}}'
printf '%s' "$tf" | env -u TURNSTILE_SECRET bash -c ". \"$LIB\"; site_secrets_json \"$T/a.json\"" > "$T/a.out"
ok "no TURNSTILE_SECRET: exactly WP_SALT and SPIKE_TOKEN" "$(python3 -I -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])) == {"WP_SALT":"salt-1","SPIKE_TOKEN":"tok-1"} else 1)' "$T/a.json" && echo 1 || echo 0)"
printf '%s' "$tf" | TURNSTILE_SECRET=$SECRET bash -c ". \"$LIB\"; site_secrets_json \"$T/b.json\"" > "$T/b.out"
ok "TURNSTILE_SECRET set: it is added to the secrets JSON" "$(python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("TURNSTILE_SECRET") == sys.argv[2] and d["WP_SALT"] == "salt-1" else 1)' "$T/b.json" "$SECRET" && echo 1 || echo 0)"
ok "nothing is printed to stdout (no secret in a log)" "$([ ! -s "$T/a.out" ] && [ ! -s "$T/b.out" ] && echo 1 || echo 0)"
# GNU stat first: on ubuntu, BSD "stat -f" means filesystem status and prints no mode (CI, #342).
mode=$(stat -c '%a' "$T/b.json" 2>/dev/null || stat -f '%Lp' "$T/b.json")
ok "the secrets file is mode 600 (got $mode)" "$([ "$mode" = 600 ] && echo 1 || echo 0)"
# The three deploy paths use the one writer (site.sh up, site update, the update rollback).
ok "site.sh up, site update and its rollback all write secrets through site_secrets_json" "$([ "$(cat "$HERE/../site.sh" "$HERE/../site" | grep -c 'site_secrets_json')" = 3 ] && ! grep -qE '"SPIKE_TOKEN": ?o\["spike_token"\]' "$HERE/../site.sh" "$HERE/../site" && echo 1 || echo 0)"
echo "$fails failing check(s)"
exit $fails
