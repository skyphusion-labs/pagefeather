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
import hashlib, json, os, random, re, shutil, subprocess, sys, tempfile, time, urllib.error, urllib.request
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
    """curl --aws-sigv4 with the key in a config on stdin (never in argv). Returns (status, body).
    A body goes through a file in a private temp directory (--data-binary @file), never through argv:
    a real site's snapshot is megabytes, and as an argument it failed with "Argument list too long"
    (measured 2026-11-11, a WooCommerce store's export; Linux caps one argument at 128 KiB)."""
    kid, sec = s3_creds()
    ep = ENV.get("WFP_S3_ENDPOINT") or "https://%s.r2.cloudflarestorage.com" % ENV["CLOUDFLARE_ACCOUNT_ID"]
    args = ["curl", "-s", "-m", "300", "-K", "-", "--aws-sigv4", "aws:amz:auto:s3", "-X", method, "-w", "\n%{http_code}", ep + path]
    tmp = None
    try:
        if body is not None:
            tmp = tempfile.mkdtemp(prefix="wfp-s3-")
            f = os.path.join(tmp, "body")
            with open(os.open(f, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as fh:
                fh.write(body)
            args[-1:-1] = ["--data-binary", "@" + f]
        r = subprocess.run(args, input=('user = "%s:%s"\n' % (kid, sec)).encode(), capture_output=True)
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)
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


def _dbexport(origin, token):
    st, b = http(origin + "/_dbexport", headers={"x-spike-token": token})
    rows = sum(1 for line in b.splitlines() if line.strip())
    return st, b, rows


def dbsnapshot(origin, token, bucket, key):
    """GET the object's SQLite export, verify it, PUT it to R2 under
    _snapshots/, and read it back (size and rows). Prints JSON; nonzero on any
    failure, so a rollback is never trusted to a snapshot that did not store."""
    st, body, rows = _dbexport(origin, token)
    if st != 200 or rows == 0:
        print(json.dumps({"ok": False, "stage": "export", "status": st, "rows": rows})); return 1
    full = "_snapshots/" + key
    pst, _ = s3("PUT", "/%s/%s" % (bucket, full), body)
    if pst not in (200, 201):
        print(json.dumps({"ok": False, "stage": "put", "status": pst})); return 1
    # Read it back: the stored object must have the bytes we sent (condition c).
    gst, gb = s3("GET", "/%s/%s" % (bucket, full))
    grows = sum(1 for line in gb.splitlines() if line.strip())
    if gst != 200 or len(gb) != len(body) or grows != rows:
        print(json.dumps({"ok": False, "stage": "readback", "status": gst, "want_bytes": len(body), "got_bytes": len(gb), "want_rows": rows, "got_rows": grows})); return 1
    print(json.dumps({"ok": True, "key": full, "bytes": len(body), "rows": rows}))
    return 0


# The site refuses a request body over MAX_BODY_BYTES (2 MiB by default) with 413, so a
# store-sized snapshot (3.4 MB measured, #287) cannot go in one request. Parts stay under this.
PART_BYTES = int(ENV.get("DBIMPORT_PART_BYTES") or 1536 * 1024)


def parts_of(body, limit=PART_BYTES):
    """Split NDJSON into parts of whole lines, each at most `limit` bytes. Raises ValueError on a
    single line over the limit: it could never be sent, and a partial restore must not start."""
    out, cur, size = [], [], 0
    for line in body.splitlines(keepends=True):
        if not line.strip():
            continue
        if not line.endswith(b"\n"):
            line += b"\n"
        if len(line) > limit:
            raise ValueError("one statement is %d bytes, over the %d byte part limit" % (len(line), limit))
        if cur and size + len(line) > limit:
            out.append(b"".join(cur)); cur, size = [], 0
        cur.append(line); size += len(line)
    if cur:
        out.append(b"".join(cur))
    return out


# A transient answer from the site or the edge (#515): the part is tried again, or the restore is
# started again from part 0. 0 is no answer at all (a connection error). Anything else (a 400 with
# "ok": false, a 413) is the dump or the site saying no, and stops the attempt at once.
TRANSIENT = (0, 429, 502, 503, 504)
INSERT_TABLE_RE = re.compile(r'^INSERT INTO\s+("(?:[^"]|"")+"|`[^`]+`|[A-Za-z0-9_]+)')


def _delays(name, default):
    try:
        return [max(0.0, float(x)) for x in (ENV.get(name) or default).split(",") if x.strip()]
    except ValueError:
        return [float(x) for x in default.split(",")]


def part_inserts(part):
    """{table: rows} for the INSERT lines of one part (dumpTo writes one row per INSERT)."""
    out = {}
    for line in part.splitlines():
        try:
            o = json.loads(line)
        except ValueError:
            continue
        m = INSERT_TABLE_RE.match(str(o.get("sql") or "")) if isinstance(o, dict) else None
        if m:
            t = m.group(1)
            if t[0] in '"`':
                t = t[1:-1].replace('""', '"')
            out[t] = out.get(t, 0) + 1
    return out


def _dbcounts(origin, token):
    """The site's per-table row counts (/_dbcounts, bounded), or None when it cannot say."""
    st, b = http(origin + "/_dbcounts", headers={"x-spike-token": token})
    if st != 200:
        return None
    try:
        rows = json.loads(b).get("rows")
    except (ValueError, AttributeError):
        return None
    return rows if isinstance(rows, dict) else None


def _post_part(origin, token, i, part):
    q = "replace=1" if i == 0 else "append=1"
    st, rb = http(origin + "/_dbimport?" + q, method="POST", data=part, headers={"x-spike-token": token, "content-type": "application/x-ndjson"})
    return st, rb, (st == 200 and b'"ok": false' not in rb and b'"error"' not in rb)


def _restore_once(origin, token, parts, before, after, log):
    """One pass from part 0. Returns None when every part is in, else a dict naming the failure.
    A part that fails with a TRANSIENT status is tried again after each of DBIMPORT_RETRY_DELAYS
    (default 2,5,10 s). Before a part other than 0 is sent again, /_dbcounts says whether the
    failed try was applied: each part is one transaction in the site, so its tables hold either
    the counts expected before it or the counts expected after it. Applied: go on, do not send
    it twice (a table with no primary key would get its rows twice). Not applied: send it again.
    Neither, or no /_dbcounts: the attempt stops, and the caller starts over from part 0."""
    delays = _delays("DBIMPORT_RETRY_DELAYS", "2,5,10")
    for i, part in enumerate(parts):
        tries = 0
        while True:
            st, rb, ok = _post_part(origin, token, i, part)
            tries += 1
            if ok:
                break
            fail = {"part": i, "parts": len(parts), "status": st, "tries": tries, "body": rb[:160].decode("utf-8", "replace")}
            if st not in TRANSIENT or tries > len(delays):
                return fail
            log("part %d of %d answered %s (try %d); trying again in %g s" % (i, len(parts), st, tries, delays[tries - 1]))
            time.sleep(delays[tries - 1])
            if i == 0:
                continue  # replace=1 drops every table first: sending it again is safe
            tabs = part_inserts(part)
            c = _dbcounts(origin, token)
            if c is None or not tabs:
                fail["why"] = "cannot tell whether the failed part was applied (/_dbcounts: %s)" % ("no answer" if c is None else "the part has no rows")
                return fail
            if all(c.get(t) == after[i].get(t) for t in tabs):
                log("part %d was applied before the %s answer (/_dbcounts): not sent again" % (i, st))
                break
            if not all(c.get(t) == before[i].get(t) for t in tabs):
                fail["why"] = "the part's tables hold neither the counts before it nor after it"
                return fail
    return None


def dbrestore(origin, token, bucket, key):
    """GET the snapshot from R2 and POST it to /_dbimport in parts: replace=1 for the first,
    append=1 for the rest (#287), the way deploy/import/sqlimport.py sends a dump.

    #515: a part that fails with a transient status (429, 502, 503, 504, no answer) is tried
    again (_restore_once). If the pass still fails, the WHOLE restore starts again from part 0,
    up to DBRESTORE_ATTEMPTS (3) passes, DBRESTORE_RESTART_S (10) s apart: replace=1 on part 0
    drops every table, so a full restart is safe. Only then does it fail. A failed restore leaves
    the parts before the failed one: the database is PARTIAL until a restore runs through."""
    full = key if key.startswith("_snapshots/") else "_snapshots/" + key
    gst, body = s3("GET", "/%s/%s" % (bucket, full))
    if gst != 200 or not body.strip():
        print(json.dumps({"ok": False, "stage": "get", "status": gst})); return 1
    try:
        parts = parts_of(body)
    except ValueError as e:
        print(json.dumps({"ok": False, "stage": "split", "error": str(e)})); return 1
    # The counts each part's tables hold before it and after it, from an empty database.
    before, after, run = [], [], {}
    for part in parts:
        before.append(dict(run))
        for t, n in part_inserts(part).items():
            run[t] = run.get(t, 0) + n
        after.append(dict(run))
    log = lambda m: print("dbrestore: " + m, file=sys.stderr)
    attempts = max(1, int(ENV.get("DBRESTORE_ATTEMPTS") or 3))
    fail = None
    for a in range(1, attempts + 1):
        fail = _restore_once(origin, token, parts, before, after, log)
        if fail is None:
            print(json.dumps({"ok": True, "stage": "import", "parts": len(parts), "bytes": len(body), "attempts": a}))
            return 0
        if fail["status"] not in TRANSIENT and "why" not in fail:
            attempts = a  # the dump or the site said no: a new pass would get the same answer
            break
        if a < attempts:
            wait = float(ENV.get("DBRESTORE_RESTART_S") or 10)
            log("pass %d of %d failed at part %s (%s): starting again from part 0 in %g s" % (a, attempts, fail["part"], fail["status"], wait))
            time.sleep(wait)
    print(json.dumps(dict({"ok": False, "stage": "import", "attempts": attempts}, **fail)))
    return 1


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
    elif cmd == "dbsnapshot":
        sys.exit(dbsnapshot(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]))
    elif cmd == "dbrestore":
        sys.exit(dbrestore(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]))
    else:
        sys.exit(__doc__)
