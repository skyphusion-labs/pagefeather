#!/usr/bin/env python3
# Regression for issue #208: the DB_IN_DO cron alarm must bind the object's own
# SQLite before it runs WordPress. The fetch path sets sqlDb per request; the
# alarm runs on a woken (hibernated) isolate where the module globals are gone,
# so without the bind sqlDb is null and every cron DB query misses the object
# store. A b-dosql deploy has no D1 binding, so the driver connect then fatals
# with "Cannot escape data without an active database connection".
#
# A single persistent local isolate never reproduces a hibernated wake, so the
# Worker takes a test seam: CRON_SIMULATE_COLD=1 nulls the module DB globals at
# the start of every alarm, making the local alarm take the same cold path. The
# fix re-binds; without it the cron run crashes (no "ran", only a parse stub).
#
# Run (b-dosql, WooCommerce not required):
#   DEV_ENV=dosql-local DEV_VARS="CRON_SIMULATE_COLD:1 CRON_INTERVAL_MS:3000" ./run.sh _ping
#   B=http://localhost:8797 SPIKE_TOKEN=local-spike-token ADMIN_PASSWORD=local-spike-password \
#     python3 tests/cron-cold.py
# Exits 0 when a fresh cold alarm ran WP-Cron green against the object DB, 1 otherwise.
import json, os, sys, time, urllib.request, urllib.error

B = os.environ.get("B", "http://localhost:8797").rstrip("/")
TOKEN = os.environ.get("SPIKE_TOKEN", "local-spike-token")
ADMIN = os.environ.get("ADMIN_PASSWORD", "local-spike-password")

def call(path, method="GET", spike=False, admin=False, timeout=180):
    h = {"User-Agent": "cron-cold-test"}
    if spike:
        h["x-spike-token"] = TOKEN
    if admin:
        h["x-admin-password"] = ADMIN
    r = urllib.request.Request(B + path, headers=h, method=method)
    try:
        resp = urllib.request.urlopen(r, timeout=timeout)
        return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()

def purgestate():
    code, body = call("/_purgestate", spike=True, timeout=10)
    if code != 200:
        return {}
    try:
        return json.loads(body)
    except Exception:
        return {}

def fail(msg):
    print("FAIL cron-cold: " + msg)
    sys.exit(1)

# Install + activate WooCommerce are idempotent ("already" when present). WooCommerce
# makes the cron run exercise Action Scheduler, the real deferred-email path (#185).
call("/_install", method="POST", spike=True, admin=True)
call("/_activate?plugin=woocommerce/woocommerce.php", method="POST", spike=True, admin=True)

# Baseline: the cron timestamp before this run, so we wait for a NEW one.
base = (purgestate().get("cron") or {}).get("t", 0)

# A non-"_" request arms the cron alarm (index.js arms it only for a real visit).
code, _ = call("/", timeout=60)
if code not in (200, 301, 302):
    fail("arming request GET / returned %s" % code)

# Wait for a fresh cold alarm to run. CRON_INTERVAL_MS governs the cadence.
deadline = time.time() + 40
cron = None
while time.time() < deadline:
    time.sleep(2)
    cron = purgestate().get("cron") or {}
    if cron.get("t", 0) > base and ("ran" in cron or "parse" in cron):
        break
else:
    fail("no fresh cron run within 40s (cron=%s). Is CRON_SIMULATE_COLD=1 and the interval short?" % cron)

# The cold alarm must have run WP-Cron against the object DB: "ran" is the success
# shape ({"ran": ["action_scheduler", ...]}); "parse" is runCron's failure stub,
# written when the WP-Cron php.run produced no valid JSON (the #208 crash).
if "parse" in cron and "ran" not in cron:
    fail("cold alarm crashed WP-Cron (parse stub, no object DB bound): %s" % cron)
if not cron.get("ran"):
    fail("cold alarm produced no 'ran' list: %s" % cron)

print("PASS cron-cold: cold alarm ran WP-Cron against the object DB  ran=%s wp_cron_events=%s"
      % (cron.get("ran"), cron.get("wp_cron_events")))
sys.exit(0)
