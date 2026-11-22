#!/usr/bin/env bash
# #924: LOCAL_HTTPS=1 serves dosql-local over HTTPS (wrangler dev --local-protocol https), so a local seed can run
# the application password step: WordPress allows application passwords only over HTTPS (or a "local" environment
# type, which the engine does not set for a test). port.sh local_scheme turns LOCAL_HTTPS into the scheme, curl's
# flag and wrangler's flag; run.sh uses it at its three sites. This test starts no server.
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=../port.sh
. "$HERE/port.sh"
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
is() { [ "$1" = "$2" ] && echo 1 || echo 0; }

if ! declare -F local_scheme > /dev/null; then
	echo "  FAIL port.sh defines local_scheme"; echo "1 failing case(s)"; exit 1
fi
(unset LOCAL_HTTPS; local_scheme) > /dev/null 2>&1; ok "unset LOCAL_HTTPS is accepted" "$(is $? 0)"
unset LOCAL_HTTPS; local_scheme
ok "unset: http" "$(is "$LOCAL_SCHEME" http)"
ok "unset: no curl -k" "$(is "${LOCAL_CURL_K[*]:-}" "")"
ok "unset: no wrangler protocol flag" "$(is "${LOCAL_PROTO_ARGS[*]:-}" "")"
LOCAL_HTTPS=0 local_scheme
ok "0: http, and no flags" "$(is "$LOCAL_SCHEME ${LOCAL_CURL_K[*]:-}${LOCAL_PROTO_ARGS[*]:-}" "http ")"
LOCAL_HTTPS=1 local_scheme
ok "1: https" "$(is "$LOCAL_SCHEME" https)"
ok "1: curl -k (the certificate is wrangler's own self-signed one)" "$(is "${LOCAL_CURL_K[*]}" "-k")"
ok "1: wrangler --local-protocol https" "$(is "${LOCAL_PROTO_ARGS[*]}" "--local-protocol https")"
for bad in yes on true 2 " 1"; do
	(LOCAL_HTTPS="$bad" local_scheme) > /dev/null 2>&1
	ok "LOCAL_HTTPS=\"$bad\" is refused, never read as on or off" "$(is $? 1)"
done

# run.sh: the guard's INPUT, at each of its three sites.
R="$HERE/run.sh"
ok "run.sh calls local_scheme before it starts wrangler" "$(awk '/^local_scheme( |$)/{l=NR} /"\$WR" dev /{w=NR} END{print (l && w && l < w) ? 1 : 0}' "$R")"
ok "run.sh passes the protocol flag to wrangler dev" "$(grep -c '"\$WR" dev "\${LOCAL_PROTO_ARGS\[@\]}"' "$R" | grep -qx 1 && echo 1 || echo 0)"
ok "run.sh's SITE_ORIGIN takes the scheme" "$(grep -c 'SITE_ORIGIN:\$LOCAL_SCHEME://localhost:\$PORT' "$R" | grep -qx 1 && echo 1 || echo 0)"
ok "run.sh's ping and its one request both use the scheme and curl's flag" "$(grep -c 'curl "\${LOCAL_CURL_K\[@\]}" .*"\$LOCAL_SCHEME://localhost:\$PORT/' "$R" | grep -qx 2 && echo 1 || echo 0)"
ok "run.sh has no http-only localhost URL left" "$(grep -qE '"(http://)?localhost:\$PORT/' "$R" && echo 0 || echo 1)"

echo "$fails failing case(s)"
[ "$fails" = 0 ]
