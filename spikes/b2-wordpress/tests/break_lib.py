#!/usr/bin/env python3
# Shared HTTP helpers for tests/break.py and tests/woo.py.
import http.cookiejar, urllib.request, urllib.parse, json, os, re, time, concurrent.futures as cf
B = os.environ.get("B", "https://wp-on-d1-paid.skyphusion.workers.dev")
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
PERF_N = [0]
LAST_ID = [None]


def opener(jar=None):
    jar = jar if jar is not None else http.cookiejar.CookieJar()
    o = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect)
    o.jar = jar; return o
def req(o, path, data=None, headers=None, method=None, timeout=120):
    h = {"User-Agent": "wp-on-cf-breaktest"}
    if os.environ.get("SPIKE_TOKEN"): h["x-spike-token"] = os.environ["SPIKE_TOKEN"]  # the Worker sends its timing headers only with it
    h.update(headers or {})
    # A per-request id (#394): the Worker logs it on its memory and reset lines (x-perf-id), so a
    # request that died can be joined to the Workers Logs. Operator requests only (spike token).
    if os.environ.get("SPIKE_TOKEN") and "x-perf-id" not in {k.lower() for k in h}:
        PERF_N[0] += 1
        h["x-perf-id"] = "%s-%d" % (os.environ.get("PERF_RUN", "m394"), PERF_N[0])
    # The isolate memory ledger (#394, PR 476): asked for on every operator request when MEM_LEDGER_HDR=1.
    if os.environ.get("SPIKE_TOKEN") and os.environ.get("MEM_LEDGER_HDR") == "1":
        h.setdefault("x-mem-ledger", "1")
    LAST_ID[0] = h.get("x-perf-id")
    if isinstance(data, dict): data = urllib.parse.urlencode(data).encode()
    r = urllib.request.Request(B + path, data=data, headers=h, method=method)
    t = time.time()
    try:
        resp = o.open(r, timeout=timeout); code = resp.status; body = resp.read(); hd = resp.headers
    except urllib.error.HTTPError as e:
        code = e.code; body = e.read(); hd = e.headers
    except Exception as e:
        return {"code": "EXC", "err": repr(e)[:160], "s": round(time.time()-t, 2), "body": b"", "h": {}}
    return {"code": code, "s": round(time.time()-t, 2), "body": body, "h": hd,
            "calls": hd.get("x-d1-calls"), "fail": hd.get("x-d1-failures"), "mib": hd.get("x-wasm-mib"), "recycled": hd.get("x-runtime-recycled")}
def short(r):
    return {k: r.get(k) for k in ("code", "s", "calls", "fail", "mib", "recycled", "err") if r.get(k) is not None}
def login():
    o = opener(); pw = os.environ["ADMIN_PASSWORD"]
    req(o, "/wp-login.php")
    r = req(o, "/wp-login.php", {"log": "admin", "pwd": pw, "wp-submit": "Log In", "redirect_to": "/wp-admin/", "testcookie": "1"})
    assert r["code"] == 302, short(r)
    # A REST nonce for the logged-in user. admin-ajax "rest-nonce" works with any plugin set.
    n = req(o, "/wp-admin/admin-ajax.php?action=rest-nonce")
    o.nonce = n["body"].decode().strip()
    assert re.fullmatch(r"[a-f0-9]{10}", o.nonce), n["body"][:200]
    return o
def rest(o, route, payload=None, method=None, raw=None, headers=None):
    h = {"X-WP-Nonce": o.nonce}; h.update(headers or {})
    data = raw
    if payload is not None: data = json.dumps(payload).encode(); h["Content-Type"] = "application/json"
    sep = "&" if "?" in route else "?"
    return req(o, "/?rest_route=" + route.replace("?", "&", 1), data, h, method)
def par(fn, items, n):
    with cf.ThreadPoolExecutor(n) as ex: return list(ex.map(fn, items))
