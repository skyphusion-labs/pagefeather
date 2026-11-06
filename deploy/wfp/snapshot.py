#!/usr/bin/env python3
"""Snapshots of sites, for the isolation proof of "site add" and "site
remove" (issue #35, slice 3; isolation.sh runs it).

  snapshot.py seed <site>...                put a per-site key _snapshots/seed-<site>.txt in each bucket
  snapshot.py take <out.json> <site>...     record each site
  snapshot.py diff <before.json> <after.json>   exit 1 when a site changed

Per site, `take` records:
- its dispatcher wp-<site>: etag and modified_on, from the account's script list;
- its user Worker site-<site>: the hash fields and modified_on, from the namespace list;
- its site map entry: the raw value;
- its media bucket: every key with its ETag and size (R2's S3 API);
- its front page title (a fresh render, ?nocache=).

The dispatcher etag is the same for every site (one script, by design), and
the user Worker etag is the same for every b-dosql site (one bundle; seen
live 2026-11-06). So for scripts, modified_on is what tells one upload from
another: a re-upload of identical code keeps the etag and changes only
modified_on. Both are compared.

A part that cannot be read is recorded as an error, and `diff` fails on it:
an unreadable part is never "unchanged". So is a script with no hash field
and no modified_on (nothing to compare).

Environment: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, NAMESPACE, KV_ID,
SUB. For tests only: WFP_API, WFP_S3_ENDPOINT, WFP_S3_KEY_ID and
WFP_S3_SECRET, and WFP_SITE_URL (a template with {name}). The R2 reads use S3 credentials derived from the API token itself (the
token id as the key id, the SHA-256 of its value as the secret, as R2
documents), so a snapshot makes no key and changes nothing.
"""
import hashlib, json, os, random, re, subprocess, sys, time, urllib.error, urllib.request
import xml.etree.ElementTree as ET

ENV = os.environ
UA = "wp-on-cf-wfp-snapshot"


def http(url, method="GET", data=None, headers=None):
    req = urllib.request.Request(url, data=data, method=method, headers={"User-Agent": UA, **(headers or {})})
    try:
        r = urllib.request.urlopen(req, timeout=60)
        return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except OSError as e:
        return 0, str(e).encode()


def api(path):
    base = ENV.get("WFP_API") or "https://api.cloudflare.com/client/v4/accounts/" + ENV["CLOUDFLARE_ACCOUNT_ID"]
    return http(base + path, headers={"Authorization": "Bearer " + ENV["CLOUDFLARE_API_TOKEN"]})


def api_json(path):
    st, b = api(path)
    try:
        return st, json.loads(b)
    except ValueError:
        return st, None


_creds = []


def s3_creds():
    if ENV.get("WFP_S3_KEY_ID"):
        return ENV["WFP_S3_KEY_ID"], ENV["WFP_S3_SECRET"]
    if not _creds:
        # An account-owned token verifies on the account path, a user token on /user.
        st, d = api_json("/tokens/verify")
        if st != 200 or not (d or {}).get("result", {}).get("id"):
            st2, b = http("https://api.cloudflare.com/client/v4/user/tokens/verify", headers={"Authorization": "Bearer " + ENV["CLOUDFLARE_API_TOKEN"]})
            try:
                d = json.loads(b) if st2 == 200 else None
            except ValueError:
                d = None
            if not (d or {}).get("result", {}).get("id"):
                raise SystemExit("cannot read the token id (/tokens/verify: HTTP %s, then %s), so the buckets cannot be read" % (st, st2))
        _creds.extend([d["result"]["id"], hashlib.sha256(ENV["CLOUDFLARE_API_TOKEN"].encode()).hexdigest()])
    return _creds[0], _creds[1]


def s3(method, path, body=None):
    """curl --aws-sigv4 with the key in a config on stdin (never in argv). Returns (status, body)."""
    kid, sec = s3_creds()
    ep = ENV.get("WFP_S3_ENDPOINT") or "https://%s.r2.cloudflarestorage.com" % ENV["CLOUDFLARE_ACCOUNT_ID"]
    args = ["curl", "-s", "-m", "60", "-K", "-", "--aws-sigv4", "aws:amz:auto:s3", "-X", method, "-w", "\n%{http_code}", ep + path]
    if body is not None:
        args[-1:-1] = ["--data-binary", body.decode("utf-8")]
    r = subprocess.run(args, input=('user = "%s:%s"\n' % (kid, sec)).encode(), capture_output=True)
    out, _, code = r.stdout.rpartition(b"\n")
    return (int(code) if code.strip().isdigit() else 0), out


def bucket_listing(bucket):
    st, b = s3("GET", "/%s?list-type=2" % bucket)
    if st != 200:
        return {"error": "list HTTP %s" % st}
    ns = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
    root = ET.fromstring(b)
    items = []
    for c in root.iter():
        if c.tag.endswith("Contents"):
            get = lambda t: next((x.text for x in c if x.tag.endswith(t)), None)
            items.append([get("Key"), get("ETag"), get("Size")])
    return {"objects": sorted(items)}


def script_record(item):
    if not isinstance(item, dict):
        return None
    sc = item.get("script") if isinstance(item.get("script"), dict) else {}
    rec = {k: (item.get(k) or sc.get(k)) for k in ("etag", "modified_on", "id")}
    return rec


def take(out, sites):
    snap = {"utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "sites": {}}
    st, acct = api_json("/workers/scripts")
    acct_items = {x.get("id"): x for x in (acct or {}).get("result") or [] if isinstance(x, dict)} if st == 200 else None
    st, nsl = api_json("/workers/dispatch/namespaces/%s/scripts?per_page=1000" % ENV["NAMESPACE"])
    ns_items = {}
    if st == 200 and isinstance((nsl or {}).get("result"), list):
        for x in nsl["result"]:
            r = script_record(x)
            if r and r.get("id"):
                ns_items[r["id"]] = r
    else:
        ns_items = None
    for s in sites:
        rec = {}
        d = "wp-" + s
        if acct_items is None:
            rec["dispatcher"] = {"error": "script list unreadable"}
        elif d in acct_items:
            rec["dispatcher"] = {"etag": acct_items[d].get("etag"), "modified_on": acct_items[d].get("modified_on")}
        else:
            rec["dispatcher"] = {"error": "absent"}
        u = "site-" + s
        if ns_items is None:
            rec["user_script"] = {"error": "namespace list unreadable"}
        elif u in ns_items:
            r = ns_items[u]
            rec["user_script"] = {"etag": r.get("etag"), "modified_on": r.get("modified_on")}
            if not r.get("etag") and not r.get("modified_on"):
                rec["user_script"]["error"] = "no hash and no modified_on in the namespace list: nothing to compare"
        else:
            rec["user_script"] = {"error": "absent"}
        host = "%s.%s.workers.dev" % (d, ENV["SUB"])
        stc, b = api("/storage/kv/namespaces/%s/values/%s" % (ENV["KV_ID"], host))
        rec["entry"] = b.decode("utf-8", "replace") if stc == 200 else {"error": "HTTP %s" % stc}
        rec["bucket"] = bucket_listing("wp-wfp-%s-media" % s)
        site_url = ENV["WFP_SITE_URL"].format(name=d) if ENV.get("WFP_SITE_URL") else "https://" + host
        stc, b = http("%s/?nocache=%d" % (site_url, random.randrange(10 ** 9)))
        m = re.search(rb"<title>([^<]*)</title>", b)
        rec["title"] = m.group(1).decode("utf-8", "replace") if (stc == 200 and m) else {"error": "HTTP %s, title %s" % (stc, "found" if m else "none")}
        snap["sites"][s] = rec
    json.dump(snap, open(out, "w"), indent=1)
    print(json.dumps(snap, indent=1))


def has_error(v):
    if isinstance(v, dict):
        return "error" in v or any(has_error(x) for x in v.values())
    return False


def diff(a_path, b_path):
    a, b = json.load(open(a_path)), json.load(open(b_path))
    bad = []
    for s in a["sites"]:
        if s not in b["sites"]:
            bad.append("%s: not in the second snapshot" % s)
            continue
        for part in ("dispatcher", "user_script", "entry", "bucket", "title"):
            va, vb = a["sites"][s].get(part), b["sites"][s].get(part)
            if has_error(va) or has_error(vb):
                bad.append("%s %s: cannot compare (%s / %s)" % (s, part, va, vb))
            elif va != vb:
                bad.append("%s %s CHANGED: %s -> %s" % (s, part, json.dumps(va)[:200], json.dumps(vb)[:200]))
            else:
                print("unchanged %s %s" % (s, part))
    for x in bad:
        print("FAIL " + x)
    print("%d difference(s) or unreadable part(s)" % len(bad))
    return 1 if bad else 0


def seed(sites):
    for s in sites:
        # A DISTINCT key per site under a prefix the Worker never serves
        # (_snapshots/, not uploads/): so one site listing its own bucket can
        # never be mistaken for seeing another site's object (issue #35).
        st, _ = s3("PUT", "/wp-wfp-%s-media/_snapshots/seed-%s.txt" % (s, s), ("seed of site %s, %s\n" % (s, time.time())).encode())
        print("seed %s: HTTP %s" % (s, st))
        if st != 200:
            raise SystemExit(1)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "take":
        take(sys.argv[2], sys.argv[3:])
    elif cmd == "diff":
        sys.exit(diff(sys.argv[2], sys.argv[3]))
    elif cmd == "seed":
        seed(sys.argv[2:])
    else:
        sys.exit(__doc__)
