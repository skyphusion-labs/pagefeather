#!/bin/bash
# #809: no write under a stranded frame, end to end on workerd, through the undo-failure seam (fault-inject.mjs).
# A frame strands when its rollback cannot run (its undo meets the same storage ceiling) and the next recovery fails
# too. The seam (x-pf-fault-undo: on, a throwaway and local measurement under the sql-fail rule) makes every frame
# rollback and recovery undo throw the platform reset until x-pf-fault-undo: off.
#   1. a real value is stored.
#   2. A: the #794 pattern (a failed read, then a default written over the real value) with the undo failing: the
#      rollback cannot run, so the frame strands. The answer is the write-loss 500, NOT "rolled back" (no proof).
#   3. B: the next requests, while recovery keeps failing, answer the retryable 503 (Retry-After, no-store,
#      x-sql-failure) before PHP runs: nothing writes under the stranded frame.
#   4. the cron alarm (CRON_INTERVAL_MS short here) defers its leg (frame-stranded), and runs nothing.
#   5. C: the seam off: that request's recovery succeeds first, and it answers 200. It undoes ONE row, the stranded
#      frame's own write (red without #809: 14, the cron's writes erased with it).
#   6. the derived write is gone: the real value is back (the stranded frame rolled back).
#   7. D: a write after the recovery lands, and stays (no later recovery erases it); the cron no longer defers.
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8797} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT; PW=${ADMIN_PASSWORD:-local-spike-password}; TOK=${SPIKE_TOKEN:-local-spike-token}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/stranded-frame.XXXXXX"); export PERSIST_TO=$STATE/db
# This test builds with its own mu-plugin (IMPORT_CONTENT): it saves build/ first and puts it back EXACTLY on exit
# (as failed-read-rollback-e2e.sh does: a later CI step works on the primed build an earlier step made).
[ -d build ] || { echo "stranded-frame: no build/ (run build.sh first)"; exit 1; }
cp -a build "$STATE/build.saved" || { echo "stranded-frame: could not save build/"; exit 1; }
trap './run.sh --stop > /dev/null 2>&1; rm -rf build && mv "$STATE/build.saved" build || echo "stranded-frame: build/ was NOT restored"; rm -rf "$STATE"' EXIT
mkdir -p "$STATE/content/mu-plugins"
cat > "$STATE/content/mu-plugins/pf-derived-test.php" <<'PHP'
<?php
// #809 test fixture, an e2e build only (tests/stranded-frame-e2e.sh): a failed read followed by a default, and a plain write.
if ( empty( $_SERVER['HTTP_X_PF_DERIVED'] ) ) { return; }
add_action( 'init', function () {
	if ( 'set' === $_SERVER['HTTP_X_PF_DERIVED'] ) { update_option( 'pf_derived_test', (string) ( $_SERVER['HTTP_X_PF_VAL'] ?? 'the-real-value' ), false ); return; }
	if ( false === get_option( 'pf_derived_test' ) ) { add_option( 'pf_derived_test', 'the-default', '', false ); }
} );
PHP
IMPORT_CONTENT="$STATE/content" IMPORT_MU_PLUGINS="pf-derived-test.php" ./build.sh > "$STATE/build.log" 2>&1 || { echo "stranded-frame: build.sh failed"; tail -5 "$STATE/build.log"; exit 1; }
DEV_LOCAL=1 DEV_LOG_LEVEL=log DEV_VARS="PHP_RECYCLE:off FAULT_INJECT:sql-fail REQUEST_FRAMES:on CRON_INTERVAL_MS:5000" ./run.sh _ping > /dev/null || { echo "stranded-frame: wrangler dev did not start"; tail -20 dev.log; exit 1; }
curl -sf -H "x-spike-token: $TOK" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "stranded-frame: /_install failed"; exit 1; }
B=$B TOK=$TOK python3 -I - <<'PY'
import json, os, sys, time, urllib.request, urllib.error
B, TOK = os.environ["B"], os.environ["TOK"]
def get(path, h):
    r = urllib.request.Request(B + path, headers={"x-spike-token": TOK, **h})
    try:
        with urllib.request.urlopen(r, timeout=300) as x: return x.status, {k.lower(): v for k, v in x.headers.items()}, x.read()
    except urllib.error.HTTPError as e: return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()
def option():
    after = None
    while True:
        st, _, b = get("/_mysqlexport?table=wp_options&limit=500" + ("&after=%s" % after if after else ""), {})
        if st != 200: return "(export answered %s)" % st
        d = json.loads(b); cols = d.get("columns") or []; rows = d.get("rows") or []
        for r in rows:
            m = dict(zip(cols, r))
            if m.get("option_name") == "pf_derived_test": return m.get("option_value")
        after = d.get("next") or d.get("after")
        if not rows or not after: return None
def logs(event):
    if not os.path.exists("dev.log"): return []
    out = []
    for l in open("dev.log", errors="replace"):
        if event in l and "{" in l:
            try: out.append(json.loads(l[l.index("{"):]))
            except ValueError: pass
    return out
def cron_deferred(): return [x for x in logs('"m":"cron"') if x.get("deferred") == "frame-stranded"]
fails = []
def check(name, cond, detail=""):
    print(("  ok   " if cond else "  FAIL ") + name + (("  (" + detail + ")") if detail else "")); cond or fails.append(name)
SEAM = {"x-pf-fault": "sql-fail"}
get("/?sf=1", {"x-pf-derived": "set"})
check("1. the real value is stored", option() == "the-real-value", repr(option()))
st, h, _ = get("/?sf=2", {**SEAM, "x-pf-derived": "check", "x-oc-off": "1", "x-pf-fault-sql": "pf_derived_test", "x-pf-fault-undo": "on"})
stranded = logs('"frame-stranded"')
print("  2. A: %s, x-write-loss %s; frame-stranded logged %d" % (st, h.get("x-write-loss"), len(stranded)))
check("2. A: the rollback could not run: the frame stranded (logged)", len(stranded) >= 1)
check("2. A: the answer is the write-loss 500, never 'rolled back' (there is no proof)", st == 500 and h.get("x-write-loss") != "rolled-back", "%s %s" % (st, h.get("x-write-loss")))
for i in (1, 2):
    st, h, _ = get("/?sf=3%d" % i, {})
    print("  3. B%d: %s, retry-after %s, x-sql-failure %s, cache-control %s" % (i, st, h.get("retry-after"), h.get("x-sql-failure"), h.get("cache-control")))
    check("3. B%d: while recovery fails, the retryable 503 before PHP runs (Retry-After, no-store, x-sql-failure)" % i, st == 503 and h.get("retry-after") and "no-store" in (h.get("cache-control") or "") and h.get("x-sql-failure") == "1", str(st))
check("3. and it is logged as the stranded refusal", len(logs('"frame-stranded-refused"')) >= 2, str(len(logs('"frame-stranded-refused"'))))
t0 = time.time()
while not cron_deferred() and time.time() - t0 < 40: time.sleep(1)
d0 = len(cron_deferred())
check("4. the cron alarm defers its leg while the frame is stranded (frame-stranded), and runs nothing", d0 >= 1, "%d after %.0f s" % (d0, time.time() - t0))
st, h, _ = get("/?sf=5", {**SEAM, "x-pf-fault-undo": "off"})
rec = [x for x in logs('"frame-recover"') if x.get("active") == 1]
print("  5. C (the seam off): %s; recoveries that undid a frame: %s" % (st, [(x.get("req"), x.get("undone")) for x in rec[-2:]]))
check("5. C: its recovery succeeds first, and it answers 200", st == 200 and len(rec) >= 1, str(st))
# Red without #809's protections: the recovery undid 14 rows (the cron's writes, logged under the stranded frame).
check("5. and it undid ONLY the stranded frame's own write: nothing was written under it", bool(rec) and rec[-1].get("undone") == 1, str(rec[-1].get("undone") if rec else None))
v = option()
check("6. the derived write is gone: the real value is back (the stranded frame rolled back)", v == "the-real-value", repr(v))
st, _, _ = get("/?sf=7", {"x-pf-derived": "set", "x-pf-val": "after-recovery"})
time.sleep(12)  # at least two cron ticks
get("/?sf=8", {})
v = option()
check("7. D: a write after the recovery lands and stays (no later recovery erases it)", st == 200 and v == "after-recovery", "%s %r" % (st, v))
check("7. and the cron no longer defers", len(cron_deferred()) == d0, "%d then %d" % (d0, len(cron_deferred())))
print("stranded-frame: %d failing" % len(fails))
sys.exit(1 if fails else 0)
PY
