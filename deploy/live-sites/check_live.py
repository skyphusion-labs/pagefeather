"""Refuse a code redeploy unless the LIVE Worker matches its site file (fleet-chezmoi#2620).

    F=deploy/live-sites/<name>.env WORKER=<name> ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \\
      python3 deploy/live-sites/check_live.py

Reads the Worker's settings (bindings only) and checks: the MEDIA bucket (when MEDIA=1), the
SITE_ORIGIN var, and the PHP_RUNTIME Durable Object binding. MODE=domains instead prints the Worker's
Custom Domains, which the workflow reads before and after a deploy (a code redeploy must not move them). Exit 0 on a match; any other outcome,
including a Worker that cannot be read, exits non-zero. SETTINGS (a path to a settings JSON) replaces
the API read in tests/live-sites-check-test.py. It never prints a secret: secret bindings carry no value.
"""
import json
import os
import re
import sys
import urllib.request


def site_file(path):
    return dict(line.split("=", 1) for line in open(path).read().splitlines() if re.match(r"^[A-Z_]+=", line))


def live_bindings():
    if os.environ.get("SETTINGS"):
        data = json.load(open(os.environ["SETTINGS"]))
    else:
        url = ("https://api.cloudflare.com/client/v4/accounts/%s/workers/scripts/%s/settings"
               % (os.environ["ACCOUNT_ID"], os.environ["WORKER"]))
        req = urllib.request.Request(url, headers={
            "Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"], "User-Agent": "wp-deploy-workers"})
        data = json.load(urllib.request.urlopen(req, timeout=30))
    return {b["name"]: b for b in data["result"]["bindings"]}


def problems(kv, b):
    bad = []
    if kv.get("MEDIA") == "1":
        live = (b.get("MEDIA") or {}).get("bucket_name")
        if live != kv.get("MEDIA_BUCKET"):
            bad.append("MEDIA bucket live=%r file=%r" % (live, kv.get("MEDIA_BUCKET")))
    origin = (b.get("SITE_ORIGIN") or {}).get("text")
    if origin != kv.get("SITE_ORIGIN"):
        bad.append("SITE_ORIGIN live=%r file=%r" % (origin, kv.get("SITE_ORIGIN")))
    if (b.get("PHP_RUNTIME") or {}).get("type") != "durable_object_namespace":
        bad.append("no PHP_RUNTIME Durable Object binding on the live Worker")
    return bad


def custom_domains():
    """Sorted hostnames of the Worker's Custom Domains (MODE=domains). DOMAINS replaces the read in tests."""
    if os.environ.get("DOMAINS"):
        data = json.load(open(os.environ["DOMAINS"]))
    else:
        url = ("https://api.cloudflare.com/client/v4/accounts/%s/workers/domains?service=%s"
               % (os.environ["ACCOUNT_ID"], os.environ["WORKER"]))
        req = urllib.request.Request(url, headers={
            "Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"], "User-Agent": "wp-deploy-workers"})
        data = json.load(urllib.request.urlopen(req, timeout=30))
    if not data.get("success", True):
        raise RuntimeError("domains read did not succeed")
    return sorted(d["hostname"] for d in data["result"] if d.get("service", os.environ["WORKER"]) == os.environ["WORKER"])


def main():
    if os.environ.get("MODE") == "domains":
        try:
            print(",".join(custom_domains()) or "-")
        except Exception as e:  # noqa: BLE001 -- an unread domain list is never "none"
            print("::error::could not read the Custom Domains of %s (%s)" % (os.environ.get("WORKER"), type(e).__name__))
            return 1
        return 0
    kv = site_file(os.environ["F"])
    try:
        b = live_bindings()
    except Exception as e:  # noqa: BLE001 -- any failure to read is a refusal, never a pass
        print("::error::could not read the live Worker %s (%s); refusing" % (os.environ.get("WORKER"), type(e).__name__))
        return 1
    bad = problems(kv, b)
    if bad:
        print("::error::the live Worker does not match %s: %s" % (os.environ["F"], "; ".join(bad)))
        return 1
    print("live %s matches %s" % (os.environ.get("WORKER"), os.environ["F"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
