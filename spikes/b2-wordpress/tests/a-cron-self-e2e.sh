#!/bin/bash
# #1310, route (b): on approach A's shape with CRON_SELF_TICK=on, WP-Cron runs with NO Cron Trigger at all, as under
# Workers for Platforms (a namespace user Worker's scheduled() never runs; a Durable Object alarm does).
# tests/a-cron-self-e2e.sh (in spikes/b2-wordpress, after prepare.sh and build.sh). Local, DEV_ENV=a-shape-local,
# WITHOUT --test-scheduled, and nothing calls /__scheduled.
#   1. A post scheduled 65 s ahead (REST, status future).
#   2. With no trigger, the post must be publish within the bound: the Worker's first request kicked the cron object
#      (an @event cron-tick line with cron "self-tick"), and the object's own alarm ran the legs (cron lines in dev.log).
#   3. The kick is once per isolate: one self-tick line, however many requests the test made.
# The CONTROL is the same run with CRON_SELF_TICK unset (SELF_OFF=1): no trigger, no kick, and the post stays future past
# its due time, as a-cron-e2e.sh's control.
# The DYING-LEG arm (FATAL=1, CRON_TEST_FATAL, #471, #855): every leg dies in PHP. With self-tick on, the run record still
# counts each death with its last mark, the death back-off is NOT capped at the interval (it waits minutes while the
# interval is 10 s), and the alarm chain stays armed (/_cron-build alarmAt is set).
# The BOTH arm (BOTH=1): self-tick on AND a Cron Trigger (--test-scheduled), as a deploy.sh site that also set the flag.
# 30 more future posts fall due 4 s apart through the window (65 s out first: WordPress publishes a post under 60 s
# ahead at once), so a new WP-Cron event is due every 4 s. One leg publishes what is due when it runs (one hook, every
# event of it), so correct code needs at most one leg an interval, while a runner the tick drove would run about one a
# due event. Measured on the #855 mutant (the tick calls alarm()): 30 posts due TOGETHER drained in one leg, so it
# stayed green; staggered they keep work due. /__scheduled is hit every 2 s for 120 s (5 ticks an interval). The kick and the tick share
# the watchdog handler, which runs no leg, so completed legs stay at most one an interval (elapsed / 10 s + 1).
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8797} DEV_ENV=a-shape-local
B=http://localhost:$PORT; PW=${ADMIN_PASSWORD:-local-spike-password}; TOK=${SPIKE_TOKEN:-local-spike-token}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/a-cron-self.XXXXXX"); export PERSIST_TO=$STATE
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE"' EXIT
SELF=" CRON_SELF_TICK:on"; [ "${SELF_OFF:-0}" = 1 ] && SELF=""
[ "${FATAL:-0}" = 1 ] && SELF="$SELF CRON_TEST_FATAL:1"
SCHED=""; [ "${BOTH:-0}" = 1 ] && SCHED=1
DEV_LOCAL=1 DEV_LOG_LEVEL=log DEV_TEST_SCHEDULED=$SCHED DEV_VARS="CRON_INTERVAL_MS:10000$SELF" ./run.sh _ping > /dev/null || { echo "a-cron-self: wrangler dev did not start"; tail -20 dev.log; exit 1; }
curl -sf -H "x-spike-token: $TOK" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "a-cron-self: /_install failed"; exit 1; }
B=$B SPIKE_TOKEN=$TOK ADMIN_PASSWORD=$PW SELF_OFF=${SELF_OFF:-0} FATAL=${FATAL:-0} BOTH=${BOTH:-0} python3 -I - <<'PY'
import datetime, json, os, re, sys, time, urllib.request
sys.path.insert(0, os.path.join(os.getcwd(), "tests"))
import break_lib as BL
off = os.environ["SELF_OFF"] == "1"
fatal = os.environ["FATAL"] == "1"
both = os.environ["BOTH"] == "1"
fails = []
def check(name, cond):
    print("  %-4s %s" % ("ok" if cond else "FAIL", name)); cond or fails.append(name)
def log():
    try: return open("dev.log", errors="replace").read()
    except Exception: return ""
o = BL.login()
when = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=65)).strftime("%Y-%m-%dT%H:%M:%S")
r = BL.rest(o, "/wp/v2/posts", {"title": "a-cron-self %d" % time.time(), "status": "future", "date_gmt": when})
if r["code"] != 201:
    sys.exit("a-cron-self: creating the future post answered %s %s" % (r["code"], r["body"][:200]))
pid = json.loads(r["body"])["id"]
def status():
    x = BL.rest(o, "/wp/v2/posts/%d?context=edit&_=%d" % (pid, time.time_ns()))
    try: return json.loads(x["body"]).get("status") or "no status: %s" % x["code"]
    except Exception: return "unreadable %s" % x["code"]
check("the post is future when made (id %d, due %sZ)" % (pid, when), status() == "future")
if both:
    base = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=65)
    made = [BL.rest(o, "/wp/v2/posts", {"title": "a-cron-self load %d" % i, "status": "future", "date_gmt": (base + datetime.timedelta(seconds=4 * i)).strftime("%Y-%m-%dT%H:%M:%S")})["code"] for i in range(30)]
    check("30 more future posts made, due 4 s apart from %sZ" % base.strftime("%H:%M:%S"), made.count(201) == 30)
    time.sleep(max(0, (base - datetime.datetime.now(datetime.timezone.utc)).total_seconds()))
    t0 = time.time(); n0 = len(re.findall(r'"m":"cron","done"', log())); ticks = 0
    while time.time() - t0 < 120:
        urllib.request.urlopen(os.environ["B"] + "/__scheduled?cron=*+*+*+*+*", timeout=30).read(); ticks += 1
        time.sleep(2)
    elapsed = time.time() - t0
    legs = len(re.findall(r'"m":"cron","done"', log())) - n0
    bound = int(elapsed / 10) + 1
    check("%d Cron Trigger ticks in %.0f s, with work due throughout, ran no extra leg: %d legs, at most %d (one an interval)" % (ticks, elapsed, legs, bound), legs <= bound)
    check("the legs did run while work was due (at least %d of the %d possible; got %d)" % (bound // 2, bound, legs), legs >= bound // 2)
    check("the kick is still once per isolate with the trigger present", len([l for l in log().splitlines() if '"cron":"self-tick"' in l]) == 1)
elif fatal:
    deadline = time.time() + 120
    while time.time() < deadline and '"skipped":"backoff"' not in log():
        time.sleep(3)
    text = log()
    check("each dying leg is counted in the run record, with the hook it died in (a died line naming skyphusion_test_fatal)",
          '"died":' in text and "skyphusion_test_fatal" in text.split('"died":', 1)[-1][:400])
    waits = [int(w) for w in re.findall(r'"skipped":"backoff","deaths":\d+,"waitMs":(\d+)', text)]
    check("the death back-off is not capped at the 10 s interval (a backoff skip waiting at least 60 s; got %s)" % waits[:3], bool(waits) and max(waits) >= 60000)
    req = urllib.request.Request(os.environ["B"] + "/_cron-build", headers={"x-spike-token": os.environ["SPIKE_TOKEN"]})
    cb = json.loads(urllib.request.urlopen(req, timeout=30).read())
    check("the alarm chain stays armed through the deaths (/_cron-build alarmAt set; got %s)" % cb.get("alarmAt"), cb.get("alarmAt") is not None)
    check("the post stays future: a dying leg runs no hook past its death (got %s)" % status(), status() == "future")
elif off:
    time.sleep(90)
    s = status()
    check("CONTROL (CRON_SELF_TICK unset): 90 s, past its due time, with no trigger, it is still future (got %s)" % s, s == "future")
    check("CONTROL: no self-tick kick was sent", '"cron":"self-tick"' not in log())
else:
    # One due WP-Cron hook per leg (#323), about 8 overdue core hooks on a fresh install, 10 s legs: as a-cron-e2e.sh.
    deadline = time.time() + 240
    while time.time() < deadline and status() != "publish":
        time.sleep(3)
    s = status()
    check("within 240 s, with NO Cron Trigger, the post is publish (got %s)" % s, s == "publish")
    text = log()
    kicks = [l for l in text.splitlines() if "@event cron-tick" in l and '"cron":"self-tick"' in l]
    check("the Worker kicked the cron object (an @event cron-tick line, cron self-tick, ok true)", bool(kicks) and '"ok":true' in kicks[0])
    check("the kick is once per isolate: one self-tick line across every request (got %d)" % len(kicks), len(kicks) == 1)
    check("the object's alarm ran cron legs (cron lines in dev.log)", len(re.findall(r'"m":"cron"', text)) > 0)
    check("no Cron Trigger ran (no scheduled() tick line)", not [l for l in text.splitlines() if "@event cron-tick" in l and '"cron":"self-tick"' not in l])
print("%d failing case(s)" % len(fails))
sys.exit(1 if fails else 0)
PY
