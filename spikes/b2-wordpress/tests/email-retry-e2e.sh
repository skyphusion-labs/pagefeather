#!/bin/bash
# #1057: a rejected wp_mail send is retried from the durable store, after its backoff, and sent once.
# On WordPress in local workerd (dosql-local; the local send_email binding), through the EMAIL_FAULT seam (fault-inject.mjs,
# the throwaway/local measurement rule: FAULT_INJECT set): EMAIL_FAULT=reject-1 rejects the first send of the isolate.
#   1. a password reset (wp_mail) is sent and REJECTED: "email send: 1 of 1 failed";
#   2. within 100 s (backoff 1 min, alarm every 10 s) the alarm retries it: an email-retry sent line, attempt 2;
#   3. it is sent ONCE: exactly one email-sent, and no further retry in the next 75 s.
# Red before #1057: the rejected send is dropped, and no retry ever comes.
#   tests/email-retry-e2e.sh   (in spikes/b2-wordpress, after prepare.sh and build.sh)
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8789} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT; PW=${ADMIN_PASSWORD:-local-spike-password}; TOK=${SPIKE_TOKEN:-local-spike-token}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/email-retry.XXXXXX"); export PERSIST_TO=$STATE
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE"' EXIT
DEV_LOCAL=1 DEV_LOG_LEVEL=log DEV_VARS="FAULT_INJECT:sql-fail EMAIL_FAULT:reject-1 MAIL_FROM:wordpress@skyphusion.org CRON_INTERVAL_MS:10000" ./run.sh _ping > /dev/null || { echo "email-retry: wrangler dev did not start"; tail -20 dev.log; exit 1; }
curl -sf -m 300 -H "x-spike-token: $TOK" -H "x-admin-email: pf1057-test@skyphusion.org" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "email-retry: /_install failed"; exit 1; }
curl -s -m 60 -o /dev/null "$B/" # a real request arms the cron alarm
curl -s -m 120 -o /dev/null -X POST --data-urlencode "user_login=admin" "$B/wp-login.php?action=lostpassword"
python3 -I - <<'PY'
import re, sys, time
fails = []
def check(name, cond):
    print("  %-4s %s" % ("ok" if cond else "FAIL", name)); cond or fails.append(name)
def log():
    try: return open("dev.log", errors="replace").read()
    except Exception: return ""
t0 = time.time()
while time.time() - t0 < 15 and "email send: 1 of 1 failed" not in log(): time.sleep(1)
check("the password reset send was rejected (email send: 1 of 1 failed)", "email send: 1 of 1 failed" in log())
t0 = time.time()
while time.time() - t0 < 100 and '"m":"email-retry","sent":1' not in log(): time.sleep(2)
ok = re.search(r'\{"m":"email-retry","sent":1,"attempt":(\d+)', log())
print("  retried after %d s" % (time.time() - t0))
check("the alarm retried it after its backoff and it was sent (attempt %s)" % (ok.group(1) if ok else None), bool(ok) and ok.group(1) == "2")
time.sleep(75)
sent = len(re.findall(r'"m":"email-sent"', log()))
retries = len(re.findall(r'"m":"email-retry","sent":1', log()))
check("sent ONCE: one email-sent and one retry in all (got %d sent, %d retries)" % (sent, retries), sent == 1 and retries == 1)
check("nothing was dead-lettered", "email-dead" not in log())
print("%d failing case(s)" % len(fails))
sys.exit(1 if fails else 0)
PY
