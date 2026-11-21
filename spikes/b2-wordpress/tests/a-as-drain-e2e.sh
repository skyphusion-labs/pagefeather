#!/bin/bash
# #1120: on approach A's shape (a-shape-local, A_CRON's cron object), an order burst's emails drain in a few cron legs,
# not one leg per email. ORDERS orders (default 50, each queues WooCommerce's deferred order emails, about 100 due
# woocommerce_send_queued_transactional_email actions), one Cron Trigger, legs every 10 s (CRON_INTERVAL_MS).
# Pass: every due email ran within MAX_LEGS legs (default 6), every leg stopped for a stated reason or ran out of work,
# and no leg reset or died. Red on main: one action a leg (#323's bound) needs about 100 legs.
# The guards, each watched firing (a leg must stop with that as_stop, and the burst still drains):
#   EXPECT_STOP=budget STOP_VARS="CRON_AS_BUDGET_MS:1000" MAX_LEGS=20
#   EXPECT_STOP=heap STOP_VARS="RECYCLE_WASM_MIB:100" ORDERS=20 MAX_LEGS=10: the stop then comes from the recycle line
#     (8 under it, 92 MiB). The default run stops for heap too, at the absolute 112 MiB (under the 128 MiB wall).
#     WebAssembly memory never shrinks and the cron leg does not recycle its runtime (a late-collected heap plus a fresh
#     boot stacks two, recycle-line.mjs), so the stop fires only when THIS leg grew the heap past it; a runtime that
#     reuses its memory goes on. Measured locally: 50 emails in legs of 13, 16 and 21, heap 114 to 119 MiB.
#   The backlog alarm (#1120): INTERVAL_MS=60000 STOP_VARS="CRON_AS_BUDGET_MS:1000" EXPECT_STOP=budget MAX_LEGS=20
#     MAX_GAP_S=20 DRAIN_WITHIN_S=300: legs cut short by the budget come CRON_BACKLOG_GAP_MS (5 s) apart, not a minute
#     apart. MAX_GAP_S checks THAT: every gap between consecutive email legs (when each leg's line first appears, polled
#     every 3 s, so it includes the leg and up to 3 s) is at most MAX_GAP_S. The total (DRAIN_WITHIN_S) is a loose
#     backstop only: how many legs a burst needs depends on the runner (CI runs about 3 emails in a 1 s budget, locally
#     about 8), so a fixed total failed on slow runners while the 5 s gap held (#1120: 6 CI runs, 108 to 114 s against
#     90). The red arm: STOP_VARS="CRON_AS_BUDGET_MS:1000 CRON_BACKLOG_GAP_MS:60000" (the gap becomes the interval, as
#     with no backlog alarm) must FAIL the gap check. The first leg waits for the alarm already armed (#855).
#   tests/a-as-drain-e2e.sh   (in spikes/b2-wordpress, after prepare.sh and build.sh)
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8799} DEV_ENV=a-shape-local  # not 8798: opcache-a.sh holds that one
B=http://localhost:$PORT; PW=${ADMIN_PASSWORD:-local-spike-password}; TOK=${SPIKE_TOKEN:-local-spike-token}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/a-as-drain.XXXXXX"); export PERSIST_TO=$STATE
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE"' EXIT
DEV_LOCAL=1 DEV_LOG_LEVEL=log DEV_TEST_SCHEDULED=1 DEV_VARS="CRON_INTERVAL_MS:${INTERVAL_MS:-10000} ${STOP_VARS:-}" ./run.sh _ping > /dev/null || { echo "a-as-drain: wrangler dev did not start"; tail -20 dev.log; exit 1; }
curl -sf -m 300 -H "x-spike-token: $TOK" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "a-as-drain: /_install failed"; exit 1; }
curl -sf -m 300 -H "x-spike-token: $TOK" "$B/_activate?plugin=woocommerce/woocommerce.php" > /dev/null || { echo "a-as-drain: WooCommerce did not activate"; exit 1; }
B=$B SPIKE_TOKEN=$TOK ADMIN_PASSWORD=$PW ORDERS=${ORDERS:-50} MAX_LEGS=${MAX_LEGS:-6} EXPECT_STOP=${EXPECT_STOP:-} DRAIN_WITHIN_S=${DRAIN_WITHIN_S:-} python3 -I - <<'PY'
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
t_trigger = time.time(); t_first = None
fails = []
def check(name, cond):
    print("  %-4s %s" % ("ok" if cond else "FAIL", name)); cond or fails.append(name)
def emails(d):
    m = re.search(re.escape(HOOK) + r":(\d+)", d.get("as_hooks") or ""); return int(m.group(1)) if m else 0
deadline = time.time() + 20 + 12 * MAX_LEGS
first_due = None
seen_at = []  # #1120: when each leg's line first appeared (the poll's time)
while time.time() < deadline:
    L = legs()
    while len(seen_at) < len(L): seen_at.append(time.time())
    if L and first_due is None: first_due = (L[0].get("as_due") or 0) + (L[0].get("as_actions") or 0); t_first = time.time()
    if L and not any(emails(d) for d in L[-1:]) and sum(emails(d) for d in L) > 0: break
    time.sleep(3)
drain_s = time.time() - (t_first or t_trigger)  # from the first leg: the first waits for the alarm already armed (#855)
L = legs()
for i, d in enumerate(L):
    print("  leg %d: as_actions %s (emails %d) stop %s pass %s due_after %s legMs %s wasmMib %s" % (i + 1, d.get("as_actions"), emails(d), d.get("as_stop"), d.get("as_pass"), d.get("as_due"), d.get("legMs"), d.get("wasmMib")))
ran = sum(emails(d) for d in L)
eleg = [d for d in L if emails(d)]
check("the burst queued at least %d due emails (first leg saw %s due)" % (ORDERS, first_due), (first_due or 0) >= ORDERS)
check("every due email ran (%d) within %d legs (%d legs ran emails)" % (ran, MAX_LEGS, len(eleg)), ran >= ORDERS and len(eleg) <= MAX_LEGS and eleg and not emails(L[-1]))
check("each email leg ran more than one action, or stopped for a stated reason", all(emails(d) > 1 or d.get("as_stop") in ("budget", "heap") or d is eleg[-1] for d in eleg))
within = os.environ.get("DRAIN_WITHIN_S") or ""
if within:
    check("the burst drained within %s s of its first leg (took %.0f s; first leg %.0f s after the trigger)" % (within, drain_s, (t_first or t_trigger) - t_trigger), drain_s <= float(within) and ran >= ORDERS)
max_gap = os.environ.get("MAX_GAP_S") or ""
if max_gap:
    ei = [i for i, d in enumerate(L) if emails(d)]
    gaps = [round(seen_at[b] - seen_at[a], 1) for a, b in zip(ei, ei[1:]) if b < len(seen_at)]
    check("#1120: every gap between email legs is at most %s s (the backlog alarm, not the interval): gaps %s" % (max_gap, gaps), bool(gaps) and max(gaps) <= float(max_gap))
want = os.environ.get("EXPECT_STOP") or ""
if want:
    check("a leg stopped for %s (the guard fired)" % want, any(d.get("as_stop") == want for d in eleg))
lg = log()
check("no leg died: no cron fatal, no isolate reset", '"fatal"' not in lg and not re.search(r'"m":"(?:isolate-reset|runtime-recycled)"', lg))
if fails: print("a-as-drain: FAIL"); sys.exit(1)
print("a-as-drain: ok: %d due emails ran in %d legs, not one a leg" % (ran, len(eleg)))
PY
