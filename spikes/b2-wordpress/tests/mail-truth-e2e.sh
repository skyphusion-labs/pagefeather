#!/bin/bash
# #1135: a cron-tick wp_mail the platform refuses is not reported to WordPress as delivered. On local workerd (dosql-local,
# the local send_email binding) with the EMAIL_FAULT seam (FAULT_INJECT set, the throwaway/local rule): reject-1 rejects
# the isolate's FIRST send. The fixture pf1135-mail.php (tests/fixtures/mail-truth) sends from a WP-Cron event, run by
# /_runcron (the cron tick's handoff, tickMailFor), and records what wp_mail returned and any wp_mail_failed message.
#   1. send 1 is refused: wp_mail returned false, and wp_mail_failed fired once, naming the refusal and the reason;
#   2. send 2 (the seam has spent its one rejection) is delivered: true, and nothing fired.
# Red before #1135: send 1 returned true and nothing fired (the refusal never reached WordPress).
#   tests/mail-truth-e2e.sh   (in spikes/b2-wordpress, after prepare.sh and build.sh; saves and restores build/)
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8791} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT; PW=${ADMIN_PASSWORD:-local-spike-password}; TOK=${SPIKE_TOKEN:-local-spike-token}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/mail-truth.XXXXXX"); export PERSIST_TO=$STATE/db
[ -d build ] || { echo "mail-truth: no build/ (run build.sh first)"; exit 1; }
cp -a build "$STATE/build.saved" || { echo "mail-truth: could not save build/"; exit 1; }
trap './run.sh --stop > /dev/null 2>&1; rm -rf build && mv "$STATE/build.saved" build || echo "mail-truth: build/ was NOT restored"; rm -rf "$STATE"' EXIT
IMPORT_CONTENT="$PWD/tests/fixtures/mail-truth" IMPORT_MU_PLUGINS=pf1135-mail.php ./build.sh > "$STATE/build.log" 2>&1 || { echo "mail-truth: build failed"; tail -5 "$STATE/build.log"; exit 1; }
DEV_LOCAL=1 DEV_LOG_LEVEL=log DEV_VARS="FAULT_INJECT:sql-fail EMAIL_FAULT:reject-1 MAIL_FROM:wordpress@skyphusion.org CRON_INTERVAL_MS:3600000" ./run.sh _ping > /dev/null || { echo "mail-truth: wrangler dev did not start"; tail -20 dev.log; exit 1; }
curl -sf -m 300 -H "x-spike-token: $TOK" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "mail-truth: /_install failed"; exit 1; }
B=$B TOK=$TOK python3 -I - <<'PY'
import json, os, sys, time, urllib.request
B = os.environ["B"]; TOK = os.environ["TOK"]
def get(path, timeout=120):
    r = urllib.request.Request(B + path, headers={"x-spike-token": TOK})
    with urllib.request.urlopen(r, timeout=timeout) as x: return json.loads(x.read() or b"null")
fails = []
def check(name, cond):
    print("  %-4s %s" % ("ok" if cond else "FAIL", name)); cond or fails.append(name)
def run_until(n):
    get("/?pf1135=schedule&n=%d" % n)
    for _ in range(20):  # one WP-Cron event a leg; a fresh install has overdue core events ahead of it
        get("/_runcron", timeout=180)
        res = get("/?pf1135=read&_=%d" % time.time_ns())
        if str(n) in res: return res[str(n)]
    return None
r1 = run_until(1)
print("  send 1:", json.dumps(r1))
check("send 1 ran", r1 is not None)
check("send 1 (refused by the seam): wp_mail returned false", bool(r1) and r1.get("returned") is False)
f1 = (r1 or {}).get("failed") or []
check("send 1: wp_mail_failed fired once", len(f1) == 1)
check("send 1: the message names the refusal and the reason", bool(f1) and "refused" in f1[0] and "injected rejection" in f1[0])
r2 = run_until(2)
print("  send 2:", json.dumps(r2))
check("send 2 (delivered): wp_mail returned true, nothing fired", bool(r2) and r2.get("returned") is True and not r2.get("failed"))
if fails: print("mail-truth: FAIL"); sys.exit(1)
print("mail-truth: ok: a refused cron-tick send returned false and fired wp_mail_failed with its reason; a delivered one stayed true")
PY
