#!/bin/bash
# #390: an idle site's alarm must not boot PHP for a cron pass with nothing due (cron-idle.mjs), and work scheduled by
# a request must still run on time. On WordPress in local workerd (dosql-local, CRON_INTERVAL_MS 10 s):
#   1. after /_install, the overdue core hooks drain (one per leg, #323);
#   2. IDLE: a 60 s window with nothing due logs `skipped: idle` and NO cron pass (`"done":1`), and the interval grows;
#   3. a post scheduled 75 s ahead (a request: it pulls the backed-off alarm in) is future, then publishes within 40 s of its time.
# Red with CRON_IDLE_GATE=off (IDLE_GATE_OFF=1 runs that arm): every tick in step 2 runs a pass.
#   tests/cron-idle-e2e.sh   (in spikes/b2-wordpress, after prepare.sh and build.sh)
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8791} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT; PW=${ADMIN_PASSWORD:-local-spike-password}; TOK=${SPIKE_TOKEN:-local-spike-token}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/cron-idle.XXXXXX"); export PERSIST_TO=$STATE
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE"' EXIT
EXTRA=""; [ "${IDLE_GATE_OFF:-0}" = 1 ] && EXTRA=" CRON_IDLE_GATE:off"
DEV_LOCAL=1 DEV_LOG_LEVEL=log DEV_VARS="CRON_INTERVAL_MS:10000$EXTRA" ./run.sh _ping > /dev/null || { echo "cron-idle: wrangler dev did not start"; tail -20 dev.log; exit 1; }
curl -sf -m 300 -H "x-spike-token: $TOK" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "cron-idle: /_install failed"; exit 1; }
curl -s -m 60 -o /dev/null "$B/" # a real request arms the cron alarm
B=$B SPIKE_TOKEN=$TOK ADMIN_PASSWORD=$PW python3 -I - <<'PY'
import datetime, json, os, re, sys, time
sys.path.insert(0, os.path.join(os.getcwd(), "tests"))
import break_lib as BL
fails = []
def check(name, cond):
    print("  %-4s %s" % ("ok" if cond else "FAIL", name)); cond or fails.append(name)
def log():
    try: return open("dev.log", errors="replace").read()
    except Exception: return ""
def lines(): return [l for l in log().splitlines() if l.startswith('{"m":"cron"')]
# 1. drain: wait until a leg reports no due WP-Cron hook left, or 4 minutes.
t0 = time.time()
while time.time() - t0 < 240:
    done = [l for l in lines() if '"done":1' in l]
    if done and '"wp_cron_due":""' in done[-1]: break
    if any('"skipped":"idle"' in l for l in lines()): break
    time.sleep(3)
print("  drained after %d s" % (time.time() - t0))
# 2. an idle window
n_done0 = sum('"done":1' in l for l in lines()); n_idle0 = sum('"skipped":"idle"' in l for l in lines())
time.sleep(60)
n_done = sum('"done":1' in l for l in lines()) - n_done0
idle = [l for l in lines() if '"skipped":"idle"' in l][n_idle0:]
print("  idle window: %d cron passes, %d idle skips" % (n_done, len(idle)))
check("IDLE: 60 s with nothing due runs NO cron pass (got %d)" % n_done, n_done == 0)
check("IDLE: the ticks log skipped idle (got %d)" % len(idle), len(idle) >= 1)
waits = [json.loads(l).get("nextInMs") for l in idle]
check("IDLE: the interval grows (%s)" % waits, len(waits) >= 2 and waits[-1] > waits[0] or len(waits) == 1 and waits[0] > 10000)
# 3. scheduled work still runs on time
o = BL.login()
due = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=75)  # under 60 s WordPress publishes at once
r = BL.rest(o, "/wp/v2/posts", {"title": "cron-idle %d" % time.time(), "status": "future", "date_gmt": due.strftime("%Y-%m-%dT%H:%M:%S")})
pid = json.loads(r["body"])["id"] if r["code"] == 201 else None
check("a future post is made (%s)" % r["code"], pid is not None)
def status():
    x = BL.rest(o, "/wp/v2/posts/%d?context=edit&_=%d" % (pid, time.time_ns()))
    try: return json.loads(x["body"]).get("status")
    except Exception: return None
check("it is future when made (got %s)" % (status() if pid else None), pid and status() == "future")
deadline = due.timestamp() + 40
while pid and time.time() < deadline and status() != "publish": time.sleep(3)
late = time.time() - due.timestamp()
check("the scheduled post publishes within 40 s of its time, through the back-off (status %s, %.0f s after due)" % (status() if pid else None, late), pid and status() == "publish")
print("%d failing case(s)" % len(fails))
sys.exit(1 if fails else 0)
PY
