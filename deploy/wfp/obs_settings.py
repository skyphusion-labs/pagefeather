#!/usr/bin/env python3
"""Redact the query string in a site's Workers Logs (#issue: privacy of the live store's logs).

    obs_settings.py redact <namespace> <script>    set redact_query_string = true, read it back
    obs_settings.py redact-or-off <namespace> <script>
                                                   the same; if it does not read back, turn the
                                                   script's observability OFF and read that back
                                                   (fail closed: never leave unredacted logs on)
    obs_settings.py show <namespace> <script>      print the script's observability settings
A namespace of "-" means an ordinary Worker, not a dispatch-namespace script (approach A's
wp-a-lean, deployed with `wrangler deploy --env a-paid-lean`, #394).

OBSERVABILITY=1 (deploy/wfp/lib.sh) logs events only, but every event still carries the request's
URL, and a store's query strings hold order keys and logins. The pinned wrangler (4.107) has no
config key for it, so `site update` sets it through the script-settings API right after the upload,
then reads it back. The token comes from CLOUDFLARE_API_TOKEN in the environment, never argv.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

API = os.environ.get("WFP_API") or "https://api.cloudflare.com/client/v4/accounts/%s" % os.environ.get("ACCOUNT_ID", os.environ.get("CLOUDFLARE_ACCOUNT_ID", ""))


def call(method, path, body=None, ctype=None):
    req = urllib.request.Request(API + path, data=body, method=method, headers={"Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"]})
    if ctype:
        req.add_header("Content-Type", ctype)
    try:
        return json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e:
        return {"success": False, "status": e.code, "errors": [{"message": e.read()[:200].decode("utf-8", "replace")}]}


def settings_path(ns, script):
    if ns == "-":
        return "/workers/scripts/%s/settings" % script
    return "/workers/dispatch/namespaces/%s/scripts/%s/settings" % (ns, script)


def show(ns, script):
    d = call("GET", settings_path(ns, script))
    return (d.get("result") or {}).get("observability") if d.get("success") else None


def redact(ns, script):
    obs = show(ns, script)
    if not obs or not obs.get("enabled"):
        print("obs settings: %s has no observability on; nothing to redact" % script)
        return 0
    obs = dict(obs, redact_query_string=True)
    b = "----wfp" + uuid.uuid4().hex
    body = ("--%s\r\nContent-Disposition: form-data; name=\"settings\"; filename=\"settings.json\"\r\nContent-Type: application/json\r\n\r\n%s\r\n--%s--\r\n" % (b, json.dumps({"observability": obs}), b)).encode()
    d = call("PATCH", settings_path(ns, script), body, "multipart/form-data; boundary=" + b)
    if not d.get("success"):
        print("obs settings: the PATCH of %s failed: %s" % (script, d.get("errors")), file=sys.stderr)
        return 1
    # The settings API can read back the old value right after a good PATCH (#481: false once,
    # true on a rerun two minutes later). Read back a few times with a short backoff before we
    # declare failure. If it still reads false, fail as before: the caller fails closed.
    delays = readback_delays()
    for n, wait in enumerate(delays, 1):
        if wait:
            time.sleep(wait)
        after = show(ns, script) or {}
        got = after.get("redact_query_string")
        print("obs settings: %s read-back %d/%d: redact_query_string=%r" % (script, n, len(delays), got), file=sys.stderr)
        if got is True:
            print("obs settings: %s query strings redacted in its logs (read back)" % script)
            return 0
    print("obs settings: %s reads back redact_query_string=%r after %d read-backs" % (script, got, len(delays)), file=sys.stderr)
    return 1


def readback_delays():
    """Seconds to wait before each read-back. Default 0,2,3,5: 4 attempts over about 10 s (#481).
    OBS_READBACK_DELAYS (comma list) overrides it, for the tests."""
    raw = os.environ.get("OBS_READBACK_DELAYS") or "0,2,3,5"
    try:
        d = [max(0.0, float(x)) for x in raw.split(",") if x.strip()]
    except ValueError:
        d = []
    return d or [0.0]


def patch_obs(ns, script, obs):
    b = "----wfp" + uuid.uuid4().hex
    body = ("--%s\r\nContent-Disposition: form-data; name=\"settings\"; filename=\"settings.json\"\r\nContent-Type: application/json\r\n\r\n%s\r\n--%s--\r\n" % (b, json.dumps({"observability": obs}), b)).encode()
    return call("PATCH", settings_path(ns, script), body, "multipart/form-data; boundary=" + b)


def redact_or_off(ns, script):
    """Redact, or else turn the logs off (#394): a failed redaction never leaves query strings logged."""
    if redact(ns, script) == 0:
        return 0
    obs = dict(show(ns, script) or {}, enabled=False)
    d = patch_obs(ns, script, obs)
    after = show(ns, script) or {}
    if d.get("success") and after.get("enabled") is False:
        print("obs settings: %s: the redaction did not apply, so its observability is now OFF (read back)" % script, file=sys.stderr)
    else:
        print("obs settings: %s: the redaction did not apply AND observability could not be turned off: turn it off by hand" % script, file=sys.stderr)
    return 1


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] not in ("redact", "redact-or-off", "show"):
        sys.exit(__doc__)
    if sys.argv[1] == "show":
        print(json.dumps(show(sys.argv[2], sys.argv[3]))); sys.exit(0)
    if sys.argv[1] == "redact-or-off":
        sys.exit(redact_or_off(sys.argv[2], sys.argv[3]))
    sys.exit(redact(sys.argv[2], sys.argv[3]))
