#!/usr/bin/env python3
"""Wait for the first 200 from a c1 site and watch its boot log (issue #103).

  c1-bootwatch.py <site URL> <R2 endpoint> <replica bucket> <replica path> <stop epoch>

deploy/variants/c1.sh c1_wait runs it after the rollout stop. The container
PUTs its boot log (container/bootlog.sh) to the replica bucket as
<replica path>.boot-<start epoch>.log, about every 10 s. This script:

- sends GET <site URL>/?nocache=... until it answers 200 (as c1_up does), and
  prints the seconds to the first 200 on stdout;
- lists the boot logs with a start epoch of <stop epoch> - BOOT_SKEW_S or
  later (an older log is an earlier container), reads the newest one, and
  prints each new line on stderr;
- fails (exit 1) when there is no such boot log BOOT_LOG_WAIT s after it
  started, or when the boot log got no new line for STALL_S s, or at
  START_TIMEOUT with no 200.

The stall age is measured on this machine, from when this script last saw
the log grow, not from the epoch on the line: a container clock that is off
cannot make a start look stuck or alive. The age includes the upload period
(10 s, then 60 s after 10 minutes), so STALL_S must be well above 60.

When the boot log cannot be listed (no key, or HTTP 401 or 403, or any other
error), the script says so once and only waits for the 200, up to
START_TIMEOUT, as c1_up did before.

Environment: C1_R2_KEY_ID and C1_R2_SECRET (the Litestream key). They go to
curl in a config on stdin, never in the arguments. START_TIMEOUT (900),
BOOT_LOG_WAIT (180), STALL_S (300), BOOT_SKEW_S (10), POLL_S (5),
PROBE_TIMEOUT (120, the -m of each GET).
"""
import os
import random
import re
import subprocess
import sys
import time
import urllib.parse

url, ep, bucket, rpath, stop = sys.argv[1], sys.argv[2].rstrip("/"), sys.argv[3], sys.argv[4], int(sys.argv[5])
env = os.environ
start_timeout = float(env.get("START_TIMEOUT") or 900)
log_wait = float(env.get("BOOT_LOG_WAIT") or 180)
stall_s = float(env.get("STALL_S") or 300)
skew = int(env.get("BOOT_SKEW_S") or 10)
poll = float(env.get("POLL_S") or 5)
probe_timeout = env.get("PROBE_TIMEOUT") or "120"
key_id, secret = env.get("C1_R2_KEY_ID", ""), env.get("C1_R2_SECRET", "")
RECOVER = ("Recover (issue #93): deploy once with a changed container setting (for example INSTANCE_TYPE), "
           "which rolls out a new instance, then deploy again.")
prefix = rpath + ".boot-"
# The first start epoch that can be this start's (the epoch filter).
after = stop - skew


def say(msg):
    print(msg, file=sys.stderr, flush=True)


def s3(path):
    """GET on the R2 S3 API. Returns (HTTP status, body); status 0 is a curl error."""
    cfg = 'user = "%s:%s"\n' % (key_id, secret)
    try:
        r = subprocess.run(["curl", "-s", "-m", "30", "-K", "-", "--aws-sigv4", "aws:amz:auto:s3",
                            "-w", "\n%{http_code}", ep + "/" + path], input=cfg.encode(), capture_output=True)
    except OSError:
        return 0, b""
    body, _, code = r.stdout.rpartition(b"\n")
    return (int(code) if code.strip().isdigit() else 0), body


def newest_log():
    """The key of the newest boot log of this start, None, or False when it cannot be listed."""
    q = urllib.parse.urlencode({"list-type": "2", "prefix": prefix, "start-after": "%s%d" % (prefix, after - 1)})
    code, body = s3(bucket + "?" + q)
    if code != 200:
        return False, code
    best = None
    for k in re.findall(r"<Key>([^<]*)</Key>", body.decode("utf-8", "replace")):
        m = re.fullmatch(re.escape(prefix) + r"(\d+)\.log", k)
        if m and int(m.group(1)) >= after and (best is None or int(m.group(1)) > best[0]):
            best = (int(m.group(1)), k)
    return (best[1] if best else None), code


def probe():
    return subprocess.Popen(["curl", "-s", "-o", "/dev/null", "-m", probe_timeout, "-w", "%{http_code}",
                             "%s/?nocache=%d" % (url, random.randrange(10 ** 9))], stdout=subprocess.PIPE)


def fail(msg, p):
    if p and p.poll() is None:
        p.kill()
    say(msg)
    sys.exit(1)


t0 = time.monotonic()
watch = bool(ep and bucket and key_id and secret)
if not watch:
    say("boot log: no R2 settings: no stall check, waiting up to %d s for a 200" % start_timeout)
key, lines, grew, last_code, p = None, [], t0, "", None
while True:
    now = time.monotonic()
    if p is None:
        p = probe()
    if p.poll() is not None:
        last_code = (p.stdout.read() or b"").decode().strip()
        p = None
        if last_code == "200":
            print(round(now - t0))
            sys.exit(0)
    if watch:
        k, code = newest_log()
        if k is False:
            watch = False
            say("boot log: cannot list %s/%s* (HTTP %s): no stall check, waiting up to %d s for a 200" % (bucket, prefix, code, start_timeout))
        elif k:
            if k != key:
                key, lines, grew = k, [], now
                say("boot log: %s/%s" % (bucket, key))
            code, body = s3(bucket + "/" + urllib.parse.quote(key))
            if code == 200:
                got = body.decode("utf-8", "replace").splitlines()
                if len(got) > len(lines):
                    for line in got[len(lines):]:
                        say("boot: " + line)
                    lines, grew = got, now
            if now - grew >= stall_s:
                fail("no new boot log line for %d s (STALL_S %d) and no 200 from %s/: the start stopped at:\n  %s\n"
                     "The container is probably stuck (issue #103). The whole log: %s/%s\n%s"
                     % (now - grew, stall_s, url, lines[-1] if lines else "(an empty log)", bucket, key, RECOVER), p)
        elif now - t0 >= log_wait:
            fail("no boot log %s/%s<epoch>.log with a start epoch of %d or later %d s after the stop (BOOT_LOG_WAIT %d): "
                 "the container did not reach bootlog.sh, so it is stuck or did not start (issue #103).\n%s"
                 % (bucket, prefix, after, now - t0, log_wait, RECOVER), p)
    if now - t0 >= start_timeout:
        fail("no 200 from %s/ after %d s (last %s)" % (url, start_timeout, last_code or "none"), p)
    time.sleep(poll)
