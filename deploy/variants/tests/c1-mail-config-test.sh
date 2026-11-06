#!/bin/bash
# Test of the c1 mail configuration (issue #104): the send_email block that
# c1-config.sh writes, and c1_mail_check in c1.sh against fake-cf-email.py.
#   deploy/variants/tests/c1-mail-config-test.sh [another c1.sh]
# Exits 0 only when every case gives what it must. Needs bash, curl, python3.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
C1SH=${1:-$ROOT/deploy/variants/c1.sh}
CFG=$ROOT/deploy/variants/c1-config.sh
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fails=0
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }
E="NAME=tsite PUBLIC_HOST=tsite.x.workers.dev REPLICA=tsite-db MEDIA_BUCKET=tsite-media R2_ENDPOINT=https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com COMPAT=2026-11-01 INSTANCE_TYPE=standard-1 PHP_WORKERS=4 IDLE_SECONDS=900"

# 1. The config.
# shellcheck disable=SC2086
env $E "$CFG" > "$T/none.toml" && ! grep -q "send_email" "$T/none.toml" && grep -q '^MAIL_FROM = ""$' "$T/none.toml" && ok "config: no MAIL_FROM, no send_email" || bad "config: no MAIL_FROM, no send_email"
# shellcheck disable=SC2086
env $E MAIL_FROM=wp@wpmail-test.skyphusion.org "$CFG" > "$T/set.toml" \
  && grep -q '^\[\[send_email\]\]$' "$T/set.toml" && grep -q '^name = "EMAIL"$' "$T/set.toml" \
  && grep -q '^allowed_sender_addresses = \["wp@wpmail-test.skyphusion.org"\]$' "$T/set.toml" && ! grep -q allowed_destination "$T/set.toml" \
  && ok "config: MAIL_FROM gives a send_email binding restricted to it" || bad "config: MAIL_FROM gives a send_email binding restricted to it"
# shellcheck disable=SC2086
env $E MAIL_FROM=wp@wpmail-test.skyphusion.org MAIL_ALLOWED_TO=mackaye@skyphusion.org,b@example.org "$CFG" > "$T/allow.toml" \
  && grep -q '^allowed_destination_addresses = \["mackaye@skyphusion.org", "b@example.org"\]$' "$T/allow.toml" \
  && ok "config: MAIL_ALLOWED_TO gives allowed_destination_addresses" || bad "config: MAIL_ALLOWED_TO gives allowed_destination_addresses"
# shellcheck disable=SC2086
env $E MAIL_FROM=wp@wpmail-test.skyphusion.org ADMIN_EMAIL=owner@shop.example.co "$CFG" > "$T/admin.toml" \
  && grep -q '^ADMIN_EMAIL = "owner@shop.example.co"$' "$T/admin.toml" \
  && ok "config: ADMIN_EMAIL in the vars" || bad "config: ADMIN_EMAIL in the vars"
# shellcheck disable=SC2086
if env $E ADMIN_EMAIL=not-an-address "$CFG" > /dev/null 2>&1; then bad "config: a bad ADMIN_EMAIL is refused"; else ok "config: a bad ADMIN_EMAIL is refused"; fi
# shellcheck disable=SC2086
if env $E 'MAIL_FROM=x"y@z.org' "$CFG" > /dev/null 2>&1; then bad "config: a quote in MAIL_FROM is refused"; else ok "config: a quote in MAIL_FROM is refused"; fi
# shellcheck disable=SC2086
if env $E MAIL_ALLOWED_TO=a@b.org "$CFG" > /dev/null 2>&1; then bad "config: MAIL_ALLOWED_TO without MAIL_FROM is refused"; else ok "config: MAIL_ALLOWED_TO without MAIL_FROM is refused"; fi

# 2. c1_mail_check.
check_case() {
	local name=$1 mode=$2 want=$3 from=$4 skip=${5:-1} port pid rc out
	rm -f "$T/port"
	python3 -I "$HERE/fake-cf-email.py" "$T/port" "$mode" & pid=$!
	for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
	port=$(cat "$T/port")
	out=$(
		ROOT=$ROOT; log() { :; }
		# shellcheck disable=SC1090
		. "$C1SH"
		MAIL_FROM=$from MAIL_CHECK=$skip CLOUDFLARE_API_TOKEN=test ACCOUNT_ID=acc C1_CF_API=http://127.0.0.1:$port c1_mail_check 2>&1
	); rc=$?
	kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
	if [ "$rc" = "$want" ]; then ok "check $name: exit $rc"; else bad "check $name: exit $rc (want $want)"; fi
	printf '%s\n' "$out" | sed 's/^/   /'
}
check_case "no MAIL_FROM" enabled 0 ""
check_case "an enabled sending subdomain (the zone found from its parent)" enabled 0 wp@wpmail-test.skyphusion.org
check_case "onboarded but not enabled" disabled 1 wp@wpmail-test.skyphusion.org
check_case "not onboarded (another subdomain is)" other 1 wp@wpmail-test.skyphusion.org
check_case "no zone holds the domain" enabled 1 wp@example.net
check_case "the zones cannot be read (403)" zones-403 1 wp@wpmail-test.skyphusion.org
check_case "MAIL_CHECK=0 skips it" other 0 wp@wpmail-test.skyphusion.org 0
echo "$fails failing case(s)"
exit $fails
