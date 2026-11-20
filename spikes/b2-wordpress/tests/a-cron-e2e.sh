#!/bin/bash
# #855: on approach A's shape (PHP in the Worker, the database outside the object), WP-Cron runs.
# tests/a-cron-e2e.sh (in spikes/b2-wordpress, after prepare.sh and build.sh). Local, DEV_ENV=a-shape-local (D1 as the
# outside database, as #646's overflow is tested locally), --test-scheduled.
#   1. A post scheduled 65 s ahead (REST, status future; WordPress publishes one due under 60 s ahead at once).
#   2. The CONTROL: 90 s with NO trigger (past its due time), the post must still be future. Nothing else runs cron on this shape
#      (DISABLE_WP_CRON is on; PHP is in the Worker), so a pass here cannot be a page spawning cron.
#   3. GET /__scheduled runs the Worker's scheduled(): it ticks the "cron" object (an @event cron-tick line, ok true).
#   5. A second trigger while the alarm is set finds it ok and runs nothing (a watchdog, not a second runner).
#   4. Within 150 s (one due hook per leg) the post must be publish: the object ran the cron leg (a cron line in dev.log), with no visitor.
# Red with A_CRON off (A_CRON_OFF=1 runs that arm): the tick does nothing and the post stays future.
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8797} DEV_ENV=a-shape-local
B=http://localhost:$PORT; PW=${ADMIN_PASSWORD:-local-spike-password}; TOK=${SPIKE_TOKEN:-local-spike-token}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/a-cron.XXXXXX"); export PERSIST_TO=$STATE
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE"' EXIT
EXTRA=""; [ "${A_CRON_OFF:-0}" = 1 ] && EXTRA=" A_CRON:off"
DEV_LOCAL=1 DEV_LOG_LEVEL=log DEV_TEST_SCHEDULED=1 DEV_VARS="CRON_INTERVAL_MS:10000$EXTRA" ./run.sh _ping > /dev/null || { echo "a-cron: wrangler dev did not start"; tail -20 dev.log; exit 1; }
curl -sf -H "x-spike-token: $TOK" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "a-cron: /_install failed"; exit 1; }
B=$B SPIKE_TOKEN=$TOK ADMIN_PASSWORD=$PW python3 -I - <<'PY'
import datetime, json, os, re, subprocess, sys, time, urllib.request
sys.path.insert(0, os.path.join(os.getcwd(), "tests"))
import break_lib as BL
B = os.environ["B"]
fails = []
def check(name, cond):
    print("  %-4s %s" % ("ok" if cond else "FAIL", name)); cond or fails.append(name)
o = BL.login()
when = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=65)).strftime("%Y-%m-%dT%H:%M:%S")
r = BL.rest(o, "/wp/v2/posts", {"title": "a-cron %d" % time.time(), "status": "future", "date_gmt": when})
if r["code"] != 201:
    sys.exit("a-cron: creating the future post answered %s %s" % (r["code"], r["body"][:200]))
pid = json.loads(r["body"])["id"]
def status():
    # break_lib.rest sends the REST nonce; a bare GET of a future post is refused (not public yet).
    x = BL.rest(o, "/wp/v2/posts/%d?context=edit&_=%d" % (pid, time.time_ns()))
    try: return json.loads(x["body"]).get("status") or "no status: %s %s" % (x["code"], x["body"][:120])
    except Exception: return "unreadable %s %s" % (x["code"], x["body"][:120])
check("the post is future when made (id %d, due %sZ)" % (pid, when), status() == "future")
time.sleep(90)
s = status()
check("CONTROL: 90 s (past its due time) with no trigger, it is still future (got %s): nothing else runs cron here" % s, s == "future")
def log():
    try: return open("dev.log", errors="replace").read()
    except Exception: return ""
n0 = len(re.findall(r'"m":"cron"', log()))
t = urllib.request.urlopen(B + "/__scheduled?cron=*+*+*+*+*", timeout=30).read()
time.sleep(1)
ticks = [l for l in log().splitlines() if "@event cron-tick" in l]
print("  trigger: %s" % (ticks[-1][-220:] if ticks else "no cron-tick line"))
check("the trigger ticked the cron object (an @event cron-tick line with ok true)", bool(ticks) and '"ok":true' in ticks[-1])
# Each cron leg runs ONE due WP-Cron hook (#323's bounded slice), and a fresh install has about 8 overdue core hooks
# ahead of publish_future_post: at CRON_INTERVAL_MS 10 s that is about 90 s. (On a live site, 60 s legs: minutes.)
deadline = time.time() + 150
while time.time() < deadline and status() != "publish":
    time.sleep(3)
s = status()
check("within 150 s, with no visitor, the post is publish (got %s)" % s, s == "publish")
# #1074: one read of dev.log. Two log() calls can disagree as the file grows. The line is
# written when the leg runs; the file may still be flushing, so wait until it holds the
# line or 10 s pass, then judge that one text.
def until(read, ready, seconds):
    t0 = time.time()
    v = read()
    while not ready(v) and time.time() - t0 < seconds:
        time.sleep(0.05)
        v = read()
    return v
text = until(log, lambda t: len(re.findall(r'"m":"cron"', t)) > n0 or "cron-start" in t, 10)
check("the object ran a cron leg (a cron line in dev.log after the trigger)", len(re.findall(r'"m":"cron"', text)) > n0 or "cron-start" in text)
# 5. A second trigger while the alarm is set runs nothing: the trigger is a watchdog, never a second runner.
urllib.request.urlopen(B + "/__scheduled?cron=*+*+*+*+*", timeout=30).read()
time.sleep(1)
ticks = [l for l in log().splitlines() if "@event cron-tick" in l]
check("a second trigger while the alarm is set finds it ok and runs nothing (a watchdog; got %s)" % (ticks[-1][-160:] if ticks else "none"), bool(ticks) and 'alarm\\":\\"ok' in ticks[-1])
print("%d failing case(s)" % len(fails))
sys.exit(1 if fails else 0)
PY
