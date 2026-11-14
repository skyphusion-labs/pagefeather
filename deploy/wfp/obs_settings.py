#!/usr/bin/env python3
"""Redact the query string in a site's Workers Logs (#issue: privacy of the live store's logs).

    obs_settings.py redact <namespace> <script>    set redact_query_string = true, read it back
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
    after = show(ns, script) or {}
    if after.get("redact_query_string") is not True:
        print("obs settings: %s reads back redact_query_string=%r" % (script, after.get("redact_query_string")), file=sys.stderr)
        return 1
    print("obs settings: %s query strings redacted in its logs (read back)" % script)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] not in ("redact", "show"):
        sys.exit(__doc__)
    if sys.argv[1] == "show":
        print(json.dumps(show(sys.argv[2], sys.argv[3]))); sys.exit(0)
    sys.exit(redact(sys.argv[2], sys.argv[3]))
