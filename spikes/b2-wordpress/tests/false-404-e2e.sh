#!/bin/bash
# #766: a SQL statement that fails at the memory ceiling must not make LATER requests answer 404 for a product that
# exists. tests/false-404-e2e.sh (in spikes/b2-wordpress, after prepare.sh and build.sh).
# dosql-local, PHP_RECYCLE off, FAULT_INJECT=sql-fail (the #766 seam, fault-inject.mjs: a request's first statement
# containing x-pf-fault-sql throws the platform's reset message; the isolate goes on, as measured in #724):
#   1. WooCommerce, one published product; a guest asks for it: 200.
#   2. A post write (a REST draft) moves the posts' last_changed, so the next product query is not a cache hit.
#   3. ONE guest request has its product lookup fail (x-pf-fault-sql: the product's slug). Whatever it answers.
#   4. The next guest requests for the product, which fail nothing, must answer 200 (three in a row). Red: 404.
#   5. The same with a NON-reset failure (x-pf-fault-sql-kind: other): the next three answer 200. (That its own
#      answer is never edge-cached is a unit test, page-cache-ttl.test.mjs: a spike-token request, which the seam
#      needs, is never page-cached anyway, so this e2e cannot show it.)
#   And the failing request's write-loss line (dev.log) must show its cache writes dropped (ocDropped > 0), so a green
#   is the fix at work, not a cache that happened to miss.
set -u
cd "$(dirname "$0")/.." || exit 1
export DEV_ENV=${DEV_ENV:-dosql-local}
# shellcheck source=port.sh
. ./port.sh
PW=${ADMIN_PASSWORD:-local-spike-password}; TOK=${SPIKE_TOKEN:-local-spike-token}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/false-404.XXXXXX"); export PERSIST_TO=$STATE
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE"' EXIT
DEV_LOCAL=1 DEV_LOG_LEVEL=log DEV_VARS="PHP_RECYCLE:off FAULT_INJECT:sql-fail" ./run.sh _ping > /dev/null || { echo "false-404: wrangler dev did not start"; tail -20 dev.log; exit 1; }
server_port || exit 1
B=http://localhost:$PORT
curl -sf -H "x-spike-token: $TOK" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "false-404: /_install failed"; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "x-spike-token: $TOK" -X POST "$B/_activate?plugin=woocommerce/woocommerce.php")" = 200 ] || { echo "false-404: activating WooCommerce failed"; exit 1; }
B=$B SPIKE_TOKEN=$TOK ADMIN_PASSWORD=$PW python3 -I - <<'PY'
import json, os, sys, time, urllib.request
sys.path.insert(0, os.path.join(os.getcwd(), "tests"))
import break_lib as BL
o = BL.login()
T = int(time.time())
r = BL.rest(o, "/wc/v3/products", {"name": "False 404 Mug %d" % T, "type": "simple", "regular_price": "9.00", "status": "publish"})
if r["code"] != 201:
    sys.exit("false-404: creating the product answered %s" % r["code"])
slug = json.loads(r["body"])["slug"]
g = BL.opener()  # a guest (no login cookie); break_lib sends the spike token, which logs nobody in
def ask(extra=None, tag=""):
    x = BL.req(g, "/?product=%s&nocache=%d" % (slug, time.time_ns()), headers=extra or {})
    print("  %-34s %s%s" % (tag, x["code"], ("  x-write-loss " + x["h"].get("x-write-loss")) if x["h"] and x["h"].get("x-write-loss") else ""))
    return x["code"]
fails = []
def check(name, cond):
    print(("  ok   " if cond else "  FAIL ") + name); cond or fails.append(name)
check("1. a guest asks for the product: 200", ask(tag="before") == 200)
w = BL.rest(o, "/wp/v2/posts", {"title": "move last_changed %d" % T, "status": "draft"})
check("2. a post write (REST draft): 201", w["code"] == 201)
ask({"x-pf-fault": "sql-fail", "x-pf-fault-sql": slug}, tag="3. its lookup fails (injected)")
after = [ask(tag="4. after, attempt %d" % (i + 1)) for i in range(3)]
wl = [json.loads(l) for l in open("dev.log", errors="replace") if '"write-loss"' in l and l.lstrip().startswith("{")] if os.path.exists("dev.log") else []
wl = [x for x in wl if x.get("ocDropped") is not None]
print("  the failing request's write-loss line: ocDropped %s, by group %s" % ((wl[-1].get("ocDropped"), wl[-1].get("ocDroppedGroups")) if wl else ("none", "-")))
check("3. the failing request's object-cache writes were dropped (write-loss line, ocDropped > 0)", bool(wl) and wl[-1]["ocDropped"] > 0)
check("4. every later request for the product answers 200 (no false 404)", after == [200, 200, 200])
# 5 (#770 review): a NON-reset failure of the same read. The write-loss answer does not replace it, so PHP answers
# with what it saw; what it cached from the empty read must not reach the later requests.
w2 = BL.rest(o, "/wp/v2/posts", {"title": "move last_changed again %d" % T, "status": "draft"})
check("5. a post write again (REST draft): 201", w2["code"] == 201)
x = BL.req(g, "/?product=%s&nocache=%d" % (slug, time.time_ns()), headers={"x-pf-fault": "sql-fail", "x-pf-fault-sql": slug, "x-pf-fault-sql-kind": "other"})
print("  5. its lookup fails (non-reset)    %s" % x["code"])
after2 = [ask(tag="5. after, attempt %d" % (i + 1)) for i in range(3)]
check("5. every later request for the product answers 200 (no false 404 from a non-reset failure)", after2 == [200, 200, 200])
print("false-404: %d failing" % len(fails))
sys.exit(1 if fails else 0)
PY
