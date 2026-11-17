#!/bin/bash
# #661: deploy.sh accepts a WooCommerce activation only when /_activate answers active AND installed.
# A retry that found a dead attempt's install lock answered active while WooCommerce never installed (no version,
# no roles, every REST write 403), and deploy.sh passed on "active" alone. This runs deploy.sh's OWN acceptance
# condition (the `if grep ...; then` line of the activation loop, extracted) against the answers /_activate gives.
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
cond=$(awk '/for act_n in/ {f=1} f && /^    if .*act_out.*; then$/ {print; exit}' "$ROOT/deploy/deploy.sh" | sed 's/^    if //; s/; then$//')
ok "the activation loop's acceptance condition is found" "$([ -n "$cond" ] && echo 1 || echo 0)"
accepts() { act_out=$1; eval "$cond" && echo 1 || echo 0; }
# The answers, as /_activate prints them (the PHP JSON inside the out string, so its quotes are escaped).
both='{"out":"{\"active\":true,\"error\":null,\"installed\":true,\"install\":{\"lock\":0}}","errors":""}'
skipped='{"out":"{\"active\":true,\"error\":null,\"installed\":false,\"install\":{\"version\":null,\"lock\":1}}","errors":""}'
old='{"out":"{\"active\":true,\"error\":null,\"exited\":false}","errors":""}'
dead='{"out":"","errors":"isolate exceeded its memory limit and was reset"}'
ok "active AND installed is accepted" "$(accepts "$both")"
ok "active with installed false (the skipped install, #661) is refused" "$([ "$(accepts "$skipped")" = 0 ] && echo 1 || echo 0)"
ok "active with no installed field (a pre-#661 /_activate) is refused" "$([ "$(accepts "$old")" = 0 ] && echo 1 || echo 0)"
ok "a dead attempt is refused" "$([ "$(accepts "$dead")" = 0 ] && echo 1 || echo 0)"
echo "$fails failing case(s)"
[ "$fails" = 0 ]
