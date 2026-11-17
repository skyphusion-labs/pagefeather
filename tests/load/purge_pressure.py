#!/usr/bin/env python3
"""The purge-pressure driver of #699's two-site load test (spec: #699 issuecomment-6930021328). ONE site per run; the
lead runs one per site, at once, from a Vultr VPS (never the laptop).

  B=https://<throwaway> ADMIN_PASSWORD=... python3 tests/load/purge_pressure.py

For DURATION seconds it:
- EDITS: changes the title of one dedicated published post every EDIT_EVERY s (each change asks a purge);
- PROBES: GETs that post's own link every PROBE_EVERY s as a guest (no cookie, no operator token, so through the page
  cache) and finds which change it shows;
- READS: BG_RPS guest requests a second to the home page and the post, which keeps the cache warm;
- records the client's load average every LOAD_EVERY s.
Then it deletes its post and prints ONE JSON line: for each change, the seconds until a guest saw it (visible), and
whether a guest ever saw it before the next change replaced it. The summary counts changes made in the count window
[COUNT_FROM, DURATION) only (the spec: minutes 5 to 15). It never prints the password.

Options (environment): EDIT_EVERY (6), PROBE_EVERY (2), BG_RPS (2), DURATION (900), COUNT_FROM (300), LOAD_EVERY (30),
RUNTAG (random). Exit 0 when the run completed; 2 when refused before any write (a denied host, plain http off
localhost); 3 when it stopped (the login failed, the post could not be made).
"""
import json, os, random, re, statistics, sys, threading, time, urllib.parse, urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "spikes", "b2-wordpress", "tests"))
import break_lib as L  # noqa: E402

B = L.B.rstrip("/")
DENY = {"ggc.sh", "www.ggc.sh"}
EDIT_EVERY = float(os.environ.get("EDIT_EVERY", "6"))
PROBE_EVERY = float(os.environ.get("PROBE_EVERY", "2"))
BG_RPS = float(os.environ.get("BG_RPS", "2"))
DURATION = float(os.environ.get("DURATION", "900"))
COUNT_FROM = float(os.environ.get("COUNT_FROM", "300"))
LOAD_EVERY = float(os.environ.get("LOAD_EVERY", "30"))
RUNTAG = os.environ.get("RUNTAG") or "%08x" % random.getrandbits(32)
MARK = re.compile(r"pp-%s-(\d+)" % re.escape(RUNTAG))


def stop(code, why):
    print(json.dumps({"stopped": why, "site": urllib.parse.urlparse(B).hostname}), flush=True)
    sys.exit(code)


def guest(path, timeout=30):
    """A guest request: no cookie, no operator token, so it goes through the page cache."""
    r = urllib.request.Request(B + path, headers={"User-Agent": "pf-purge-pressure"})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, b""
    except Exception:
        return "EXC", b""


def pct(xs, q):
    if not xs:
        return None
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(round(q * (len(xs) - 1))))], 2)


def main():
    host = urllib.parse.urlparse(B).hostname or ""
    if host in DENY:
        stop(2, "%s is a real site, never a load target" % host)
    if urllib.parse.urlparse(B).scheme != "https" and host not in ("127.0.0.1", "localhost"):
        stop(2, "B must be https (plain http only for a local stub)")
    if not os.environ.get("ADMIN_PASSWORD"):
        stop(2, "ADMIN_PASSWORD is not set")
    try:
        admin = L.login()
    except (AssertionError, Exception) as e:
        stop(3, "the admin login failed (%s)" % type(e).__name__)
    r = L.rest(admin, "/wp/v2/posts", {"title": "pp-%s-0" % RUNTAG, "status": "publish", "content": "purge pressure, #699"})
    if r["code"] != 201:
        stop(3, "the post could not be made (HTTP %s)" % r["code"])
    post = json.loads(r["body"])
    pid, link = post.get("id"), urllib.parse.urlsplit(post.get("link") or "")
    path = (link.path or "/") + ("?" + link.query if link.query else "")
    t0 = time.time()
    end = t0 + DURATION
    edits = {0: {"t": 0.0, "code": 201}}
    shown = {}  # version -> first time a guest saw exactly it
    visible = {}  # version -> first time a guest saw it or a later one
    lock = threading.Lock()
    codes = {"probe": {}, "bg": {}, "edit": {}}
    load = []

    def count(kind, code):
        with lock:
            codes[kind][str(code)] = codes[kind].get(str(code), 0) + 1

    def editor():
        n = 0
        while True:
            nxt = t0 + (n + 1) * EDIT_EVERY
            if nxt >= end:
                return
            time.sleep(max(0.0, nxt - time.time()))
            n += 1
            rr = L.rest(admin, "/wp/v2/posts/%s" % pid, {"title": "pp-%s-%d" % (RUNTAG, n)})
            count("edit", rr["code"])
            with lock:
                edits[n] = {"t": round(time.time() - t0, 3), "code": rr["code"]}

    def probe():
        while time.time() < end:
            c, body = guest(path)
            count("probe", c)
            m = [int(x) for x in MARK.findall(body.decode("utf-8", "replace"))] if c == 200 else []
            now = round(time.time() - t0, 3)
            if m:
                v = max(m)
                with lock:
                    shown.setdefault(v, now)
                    for k in list(edits):
                        if k <= v:
                            visible.setdefault(k, now)
            time.sleep(PROBE_EVERY)

    def background():
        i = 0
        while BG_RPS > 0 and time.time() < end:
            c, _ = guest("/" if i % 2 == 0 else path)
            count("bg", c)
            i += 1
            time.sleep(1.0 / BG_RPS)

    def loadavg():
        while time.time() < end:
            try:
                load.append([round(time.time() - t0, 1), round(os.getloadavg()[0], 2)])
            except OSError:
                load.append([round(time.time() - t0, 1), None])
            time.sleep(LOAD_EVERY)

    ts = [threading.Thread(target=f, daemon=True) for f in (editor, probe, background, loadavg)]
    for t in ts:
        t.start()
    while time.time() < end:
        time.sleep(0.05)
    for t in ts:
        t.join(timeout=max(EDIT_EVERY, PROBE_EVERY, 60))
    deleted = L.rest(admin, "/wp/v2/posts/%s?force=true" % pid, method="DELETE")["code"] == 200
    last = max(edits)
    rows = []
    for n in sorted(edits):
        e = edits[n]
        vis = visible.get(n)
        rows.append({"n": n, "t": e["t"], "code": e["code"], "visibleS": None if vis is None else round(vis - e["t"], 3),
                     "seen": n in shown, "replacedUnseen": n not in shown and n < last})
    win = [x for x in rows if x["n"] > 0 and COUNT_FROM <= x["t"] < DURATION]
    delays = [x["visibleS"] for x in win if x["visibleS"] is not None]
    print(json.dumps({
        "site": urllib.parse.urlparse(B).hostname, "runtag": RUNTAG, "duration": DURATION, "countFrom": COUNT_FROM,
        "editEvery": EDIT_EVERY, "probeEvery": PROBE_EVERY, "bgRps": BG_RPS,
        "window": {"edits": len(win), "visibleP50": pct(delays, 0.5), "visibleP95": pct(delays, 0.95),
                   "visibleMax": max(delays) if delays else None, "replacedUnseen": sum(1 for x in win if x["replacedUnseen"]),
                   "notVisibleByEnd": sum(1 for x in win if x["visibleS"] is None)},
        "codes": codes, "load": load, "postDeleted": deleted, "edits": rows}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
