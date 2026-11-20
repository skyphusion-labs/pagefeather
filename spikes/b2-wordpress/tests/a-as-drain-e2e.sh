#!/bin/bash
# #1120: on approach A's shape (a-shape-local, A_CRON's cron object), an order burst's emails drain in a few cron legs,
# not one leg per email. ORDERS orders (default 50, each queues WooCommerce's deferred order emails, about 100 due
# woocommerce_send_queued_transactional_email actions), one Cron Trigger, legs every 10 s (CRON_INTERVAL_MS).
# Pass: every due email ran within MAX_LEGS legs (default 6), every leg stopped for a stated reason or ran out of work,
# and no leg reset or died. Red on main: one action a leg (#323's bound) needs about 100 legs.
# The guards, each watched firing (a leg must stop with that as_stop, and the burst still drains):
#   EXPECT_STOP=budget STOP_VARS="CRON_AS_BUDGET_MS:1000" MAX_LEGS=20
#   EXPECT_STOP=heap STOP_VARS="RECYCLE_WASM_MIB:120" ORDERS=20 MAX_LEGS=10: a heap stop at 112 MiB, between the 107 a
#     leg starts at and the 116 a 20-email leg reaches. WebAssembly memory never shrinks and the cron leg does not
#     recycle its runtime (a late-collected heap plus a fresh boot stacks two, recycle-line.mjs), so once the heap is
#     past the stop every later leg runs ONE action, the bound before #1120: never worse than it.
#   tests/a-as-drain-e2e.sh   (in spikes/b2-wordpress, after prepare.sh and build.sh)
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8798} DEV_ENV=a-shape-local
B=http://localhost:$PORT; PW=${ADMIN_PASSWORD:-local-spike-password}; TOK=${SPIKE_TOKEN:-local-spike-token}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/a-as-drain.XXXXXX"); export PERSIST_TO=$STATE
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE"' EXIT
DEV_LOCAL=1 DEV_LOG_LEVEL=log DEV_TEST_SCHEDULED=1 DEV_VARS="CRON_INTERVAL_MS:10000 ${STOP_VARS:-}" ./run.sh _ping > /dev/null || { echo "a-as-drain: wrangler dev did not start"; tail -20 dev.log; exit 1; }
curl -sf -m 300 -H "x-spike-token: $TOK" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "a-as-drain: /_install failed"; exit 1; }
curl -sf -m 300 -H "x-spike-token: $TOK" "$B/_activate?plugin=woocommerce/woocommerce.php" > /dev/null || { echo "a-as-drain: WooCommerce did not activate"; exit 1; }
B=$B SPIKE_TOKEN=$TOK ADMIN_PASSWORD=$PW ORDERS=${ORDERS:-50} MAX_LEGS=${MAX_LEGS:-6} EXPECT_STOP=${EXPECT_STOP:-} python3 -I - <<'PY'
import json, os, re, sys, time, urllib.request
sys.path.insert(0, os.path.join(os.getcwd(), "tests"))
import break_lib as BL
B = os.environ["B"]; ORDERS = int(os.environ["ORDERS"]); MAX_LEGS = int(os.environ["MAX_LEGS"])
HOOK = "woocommerce_send_queued_transactional_email"
o = BL.login()
r = BL.rest(o, "/wc/v3/products", {"name": "a-as-drain", "type": "simple", "regular_price": "9", "status": "publish"}, "POST")
if r["code"] != 201: sys.exit("a-as-drain: product answered %s %s" % (r["code"], r["body"][:200]))
pid = json.loads(r["body"])["id"]
for i in range(ORDERS):
    r = BL.rest(o, "/wc/v3/orders", {"status": "processing", "set_paid": True, "billing": {"email": "buyer%d@example.invalid" % i, "first_name": "B"}, "line_items": [{"product_id": pid, "quantity": 1}]}, "POST")
    if r["code"] != 201: sys.exit("a-as-drain: order %d answered %s %s" % (i, r["code"], r["body"][:200]))
def log():
    try: return open("dev.log", errors="replace").read()
    except Exception: return ""
def legs():
    out = []
    for l in log().splitlines():
        if '"m":"cron","done":1' in l: out.append(json.loads(l[l.index("{"):]))
    return out
urllib.request.urlopen(B + "/__scheduled?cron=*+*+*+*+*", timeout=60).read()
fails = []
def check(name, cond):
    print("  %-4s %s" % ("ok" if cond else "FAIL", name)); cond or fails.append(name)
def emails(d):
    m = re.search(re.escape(HOOK) + r":(\d+)", d.get("as_hooks") or ""); return int(m.group(1)) if m else 0
deadline = time.time() + 20 + 12 * MAX_LEGS
first_due = None
while time.time() < deadline:
    L = legs()
    if L and first_due is None: first_due = (L[0].get("as_due") or 0) + (L[0].get("as_actions") or 0)
    if L and not any(emails(d) for d in L[-1:]) and sum(emails(d) for d in L) > 0: break
    time.sleep(3)
L = legs()
for i, d in enumerate(L):
    print("  leg %d: as_actions %s (emails %d) stop %s pass %s due_after %s legMs %s wasmMib %s" % (i + 1, d.get("as_actions"), emails(d), d.get("as_stop"), d.get("as_pass"), d.get("as_due"), d.get("legMs"), d.get("wasmMib")))
ran = sum(emails(d) for d in L)
eleg = [d for d in L if emails(d)]
check("the burst queued at least %d due emails (first leg saw %s due)" % (ORDERS, first_due), (first_due or 0) >= ORDERS)
check("every due email ran (%d) within %d legs (%d legs ran emails)" % (ran, MAX_LEGS, len(eleg)), ran >= ORDERS and len(eleg) <= MAX_LEGS and eleg and not emails(L[-1]))
check("each email leg ran more than one action, or stopped for a stated reason", all(emails(d) > 1 or d.get("as_stop") in ("budget", "heap") or d is eleg[-1] for d in eleg))
want = os.environ.get("EXPECT_STOP") or ""
if want:
    check("a leg stopped for %s (the guard fired)" % want, any(d.get("as_stop") == want for d in eleg))
lg = log()
check("no leg died: no cron fatal, no isolate reset", '"fatal"' not in lg and not re.search(r'"m":"(?:isolate-reset|runtime-recycled)"', lg))
if fails: print("a-as-drain: FAIL"); sys.exit(1)
print("a-as-drain: ok: %d due emails ran in %d legs, not one a leg" % (ran, len(eleg)))
PY
