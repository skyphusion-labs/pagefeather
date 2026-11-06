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
- fails (exit 1) when a container runs but there is no such boot log
  BOOT_LOG_WAIT s after it was first seen running, or when the boot log got
  no new line for STALL_S s, or at START_TIMEOUT with no 200.

"Runs" is `running` in /_store-info (issue #120). While the platform has
placed no container (running false), no boot log is expected, and a
redeploy would not help: seen 2026-11-06 on a new application, whose first
container came after 4 min while the containers API answered 500 and 408.
So that wait goes on, up to START_TIMEOUT, and its failure says the
platform started no container. When /_store-info cannot be read, the
BOOT_LOG_WAIT counts from the start, as before, and the script says so
once. Every failure names the answers the GET / probes got.

The stall age is measured on this machine, from when this script last saw
the log grow, not from the epoch on the line: a container clock that is off
cannot make a start look stuck or alive. The age includes the upload period
(10 s, then 60 s after 10 minutes), so STALL_S must be well above 60.

When the boot log cannot be listed (no key, or HTTP 401 or 403, or any other
error), the script says so once and only waits for the 200, up to
START_TIMEOUT, as c1_up did before.

Environment: C1_R2_KEY_ID and C1_R2_SECRET (the Litestream key), and
C1_SPIKE_TOKEN (for /_store-info). They go to curl in a config on stdin,
never in the arguments. START_TIMEOUT (900),
BOOT_LOG_WAIT (180), STALL_S (300), BOOT_SKEW_S (10), POLL_S (5),
PROBE_TIMEOUT (120, the -m of each GET).
"""
import json
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
spike_token = env.get("C1_SPIKE_TOKEN", "")
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


def store_running():
    """`running` from /_store-info: True, False, or None when it cannot be read."""
    if not spike_token:
        return None
    cfg = 'header = "x-spike-token: %s"\n' % spike_token
    try:
        r = subprocess.run(["curl", "-s", "-m", "30", "-K", "-", url + "/_store-info"], input=cfg.encode(), capture_output=True)
        v = json.loads(r.stdout).get("running")
    except (OSError, ValueError, AttributeError):
        return None
    return v if isinstance(v, bool) else None


def probes_text():
    return "probes %d (%s)" % (sum(codes.values()), ", ".join("%s x%d" % (c, n) for c, n in sorted(codes.items())) or "none answered")


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
codes = {}
# When a container was first seen running (issue #120): the BOOT_LOG_WAIT
# counts from there. None: not seen yet. info_ok False: /_store-info could
# not be read, so it counts from t0.
run_since, info_ok = None, True
while True:
    now = time.monotonic()
    if p is None:
        p = probe()
    if p.poll() is not None:
        last_code = (p.stdout.read() or b"").decode().strip() or "000"
        codes[last_code] = codes.get(last_code, 0) + 1
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
                fail("no new boot log line for %d s (STALL_S %d) and no 200 from %s/ (%s): the start stopped at:\n  %s\n"
                     "The container is probably stuck (issue #103). The whole log: %s/%s\n%s"
                     % (now - grew, stall_s, url, probes_text(), lines[-1] if lines else "(an empty log)", bucket, key, RECOVER), p)
        else:
            if info_ok:
                r = store_running()
                if r is None:
                    info_ok, run_since = False, t0
                    say("boot log: cannot read %s/_store-info: the BOOT_LOG_WAIT counts from the stop" % url)
                elif r:
                    run_since = run_since or now
                else:
                    run_since = None
            if run_since is not None and now - run_since >= log_wait:
                fail("no boot log %s/%s<epoch>.log with a start epoch of %d or later, %d s after %s (BOOT_LOG_WAIT %d; %s): "
                     "the container did not reach bootlog.sh, so it is stuck (issue #103).\n%s"
                     % (bucket, prefix, after, now - run_since, "the stop" if not info_ok else "a container was first seen running",
                        log_wait, probes_text(), RECOVER), p)
    if now - t0 >= start_timeout:
        if watch and key is None and info_ok and run_since is None:
            fail("no 200 from %s/ after %d s (%s), and the platform started no container (/_store-info running false, "
                 "no boot log): a placement or start problem, not a stuck container (issue #120). Deploy again later."
                 % (url, start_timeout, probes_text()), p)
        fail("no 200 from %s/ after %d s (last %s; %s)" % (url, start_timeout, last_code or "none", probes_text()), p)
    time.sleep(poll)
