#!/usr/bin/env bash
# #1323: kind-a.sh reads EVERY page of the Hyperdrive config list (20 a page by default). A stub api() serves 45
# configs over 3 pages of 20, 20 and 5; the site's own config is on page 3. Controls: one page only (the #1321 bug
# shape) must miss it, and an unreadable page must fail, never count as empty.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
WFP="$ROOT/deploy/wfp"
# shellcheck source=../kind-a.sh
. "$WFP/kind-a.sh"
PAGES_BAD=0
api() { # api GET /hyperdrive/configs?per_page=100&page=<n>: the stand-in, 20 a page whatever per_page says
  local p; p=$(printf '%s' "$2" | sed -n 's/.*[?&]page=\([0-9]*\).*/\1/p'); p=${p:-1}
  if [ "$PAGES_BAD" = "$p" ]; then printf 'oops\n500'; return 0; fi
  python3 -I -c 'import json, sys
p = int(sys.argv[1]); n = 45; per = 20
ids = ["%032x" % i for i in range(n)]
names = ["cfg-%d" % i for i in range(n)]; names[42] = "wp-wfp-shop"
r = [{"id": ids[i], "name": names[i]} for i in range((p - 1) * per, min(p * per, n))]
print(json.dumps({"success": True, "result": r, "result_info": {"page": p, "per_page": per, "count": len(r), "total_count": n, "total_pages": 3}}))' "$p"
  printf '200'
}
api_code() { api "$@" | tail -1; }
n=$(hd_configs | grep -c .)
ok "every page is read: 45 configs over 3 pages (got $n)" "$([ "$n" = 45 ] && echo 1 || echo 0)"
id=$(hd_find shop)
ok "the site's config on page 3 is found (got ${id:-nothing})" "$([ "$id" = "$(printf '%032x' 42)" ] && echo 1 || echo 0)"
ok "hd_state reads yes for it" "$([ "$(hd_state shop)" = yes ] && echo 1 || echo 0)"
ok "control: page 1 alone (the #1321 shape) does not hold it" "$(api GET '/hyperdrive/configs?per_page=100&page=1' | grep -q wp-wfp-shop && echo 0 || echo 1)"
HYPERDRIVE_CONFIG_LIMIT=25 hd_limit_check > /dev/null 2>&1; rc=$?
ok "45 configs against a limit of 25 is REFUSED (rc $rc; one page counted 20 and passed)" "$([ "$rc" = 2 ] && echo 1 || echo 0)"
HYPERDRIVE_CONFIG_LIMIT=50 hd_limit_check > /dev/null 2>&1; rc=$?
ok "45 configs against a limit of 50 passes (rc $rc)" "$([ "$rc" = 0 ] && echo 1 || echo 0)"
PAGES_BAD=2
hd_configs > /dev/null 2>&1; rc=$?
ok "an unreadable page 2 fails the list (rc $rc), never counts as empty" "$([ "$rc" != 0 ] && echo 1 || echo 0)"
ok "hd_state reads unknown, not no, when a page is unread" "$([ "$(hd_state shop)" = unknown ] && echo 1 || echo 0)"
# bindings.py own_hyperdrive: the same three pages, through its own api().
r=$(python3 -I - "$WFP" <<'PYB'
import json, sys
sys.path.insert(0, sys.argv[1]); import bindings
def stub(path, bad=None):
    import re
    p = int((re.search(r"[?&]page=(\d+)", path) or [0, 1])[1])
    if p == bad: return 500, None
    n, per = 45, 20; names = ["cfg-%d" % i for i in range(n)]; names[42] = "wp-wfp-shop"
    r = [{"id": "%032x" % i, "name": names[i]} for i in range((p - 1) * per, min(p * per, n))]
    return 200, {"success": True, "result": r, "result_info": {"page": p, "total_pages": 3}}
bindings.api = stub
a = bindings.own_hyperdrive("shop") == "%032x" % 42
bindings.api = lambda path: stub(path, bad=2)
b = bindings.own_hyperdrive("shop") is None
print("%d %d" % (a, b))
PYB
)
ok "bindings.py finds the site's config on page 3" "$([ "${r%% *}" = 1 ] && echo 1 || echo 0)"
ok "bindings.py reads an unread page as no config (the site then fails its check)" "$([ "${r##* }" = 1 ] && echo 1 || echo 0)"
[ "$fails" = 0 ] && echo "kind-a-pages: all checks pass" || echo "kind-a-pages: $fails failing check(s)"
exit $((fails > 0))
