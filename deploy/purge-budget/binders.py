#!/usr/bin/env python3
"""Who still binds pf-purge-budget, the account's purge budget (#699 part B)? down.sh removes it ONLY when nothing
does: checked, never assumed (the lead's ruling).

  binders.py

Reads every dispatch namespace, every script in it and its bindings, and every account script and its settings. A
binder is any script with a durable_object_namespace binding whose script_name is pf-purge-budget (the budget's own
class binding, with no script_name, does not count).
Prints one JSON line {"binders": [...], "unread": [...]} and exits:
  0  nothing binds it, and every script was read;
  1  something binds it (named);
  2  nothing binder was seen, but something could not be read: unknown, so it must be kept.
Environment: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (or ACCOUNT_ID); WFP_API overrides the account base (tests).
Prints names only: never a value, never the token.
"""
import datetime, json, os, re, sys, urllib.error, urllib.parse, urllib.request

BUDGET = "pf-purge-budget"
ENV = os.environ


def api(path):
    acct = ENV.get("CLOUDFLARE_ACCOUNT_ID") or ENV.get("ACCOUNT_ID") or ""
    base = ENV.get("WFP_API") or "https://api.cloudflare.com/client/v4/accounts/" + acct
    req = urllib.request.Request(base + path, headers={"Authorization": "Bearer " + ENV.get("CLOUDFLARE_API_TOKEN", ""), "User-Agent": "pf-purge-budget-binders"})
    try:
        r = urllib.request.urlopen(req, timeout=60)
        return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, None
    except (OSError, ValueError):
        return 0, None


def active_bindings(script):
    """#1063: the bindings of an account script's ACTIVE version, or None when unreadable: the deployment with the
    greatest created_on (the API's order is not trusted), then its version at 100% (a split rollout is not guessed).
    GET .../settings can answer an older version's bindings after a deploy, so a binder could be missed through it."""
    enc = lambda x: urllib.parse.quote(str(x), safe="")
    code, d = api("/workers/scripts/%s/deployments" % enc(script))
    deps = ((d or {}).get("result") or {}).get("deployments") if code == 200 and isinstance(d, dict) else None
    if not isinstance(deps, list) or not deps:
        return None
    def when(x):
        t = re.sub(r"\.(\d+)", lambda m: "." + (m.group(1) + "000000")[:6], str(x.get("created_on")).replace("Z", "+00:00"))
        return datetime.datetime.fromisoformat(t)
    try:
        latest = max(deps, key=when)
    except ValueError:
        return None
    v = next((x for x in latest.get("versions") or [] if float(x.get("percentage") or 0) == 100), None)
    if not v or not v.get("version_id"):
        return None
    code, d = api("/workers/scripts/%s/versions/%s" % (enc(script), enc(v["version_id"])))
    r = ((d or {}).get("result") or {}).get("resources") if code == 200 and isinstance(d, dict) else None
    b = r.get("bindings") if isinstance(r, dict) else None
    return b if isinstance(b, list) else None


def result(path, key=None):
    code, d = api(path)
    if code != 200 or not isinstance(d, dict):
        return None
    r = d.get("result")
    if key is not None:
        r = r.get(key) if isinstance(r, dict) else None
    return r if isinstance(r, list) else None


def binds(bs):
    return any(isinstance(b, dict) and b.get("type") == "durable_object_namespace" and b.get("script_name") == BUDGET for b in bs)


def main():
    q = urllib.parse.quote
    binders, unread = [], []
    nss = result("/workers/dispatch/namespaces")
    if nss is None:
        unread.append("/workers/dispatch/namespaces")
        nss = []
    for n in nss:
        ns = n.get("namespace_name") if isinstance(n, dict) else None
        if not ns:
            unread.append("a namespace with no name")
            continue
        scripts = result("/workers/dispatch/namespaces/%s/scripts?per_page=1000" % q(ns))
        if scripts is None:
            unread.append("namespace %s: its scripts" % ns)
            continue
        for x in scripts:
            s = ((x.get("script") or {}).get("id") or x.get("id")) if isinstance(x, dict) else None
            if not s:
                unread.append("namespace %s: a script with no name" % ns)
                continue
            bs = result("/workers/dispatch/namespaces/%s/scripts/%s/bindings" % (q(ns), q(s)))
            if bs is None:
                unread.append("%s/%s" % (ns, s))
            elif binds(bs):
                binders.append("%s/%s" % (ns, s))
    acct = result("/workers/scripts?per_page=1000")
    if acct is None:
        unread.append("/workers/scripts")
        acct = []
    for x in acct:
        s = x.get("id") if isinstance(x, dict) else None
        if not s:
            unread.append("an account script with no name")
            continue
        if s == BUDGET:
            continue
        bs = active_bindings(s)
        if bs is None:
            unread.append(s)
        elif binds(bs):
            binders.append(s)
    print(json.dumps({"binders": sorted(binders), "unread": sorted(unread)}))
    return 1 if binders else 2 if unread else 0


if __name__ == "__main__":
    sys.exit(main())
