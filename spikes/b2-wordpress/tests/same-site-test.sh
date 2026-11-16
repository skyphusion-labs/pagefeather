#!/usr/bin/env bash
# #760: same-site.sh's same_site_location, the redirect check of e2e.sh (row and getl). A protocol-relative
# Location to another host (//elsewhere.example/...) is OFF site; joan's review found the "/..." arm let it through.
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=../same-site.sh
. "$HERE/same-site.sh"
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
B=http://localhost:8797
on() { same_site_location "$B" "$1" && echo 1 || echo 0; }
off() { same_site_location "$B" "$1" && echo 0 || echo 1; }
ok "no Location" "$(on '')"
ok "the site itself" "$(on "$B")"
ok "a page on the site" "$(on "$B/2026/11/16/hello-world/")"
ok "a path" "$(on /hello-world/)"
ok "protocol-relative to the site's own host:port" "$(on //localhost:8797/hello-world/)"
ok "protocol-relative to another host: OFF" "$(off //elsewhere.example/x)"
ok "protocol-relative to the same host on another port: OFF" "$(off //localhost:9999/x)"
ok "protocol-relative, bare //: OFF" "$(off //)"
ok "another origin: OFF" "$(off https://elsewhere.example/x)"
ok "the same host, other scheme: OFF" "$(off https://localhost:8797/x)"
ok "a host that only starts like the site's: OFF" "$(off http://localhost:87970/x)"
ok "e2e.sh uses it in row and getl, and has no case arm of its own" "$(grep -c 'same_site_location "\$B" "\$loc"' "$HERE/e2e.sh" | grep -qx 2 && ! grep -qE 'case "\$loc" in' "$HERE/e2e.sh" && echo 1 || echo 0)"
echo "$fails failing case(s)"
[ "$fails" = 0 ]
