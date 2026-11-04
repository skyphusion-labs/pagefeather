#!/usr/bin/env python3
# Break test: try to make a deploy fail. Usage: B=https://<worker> ADMIN_PASSWORD=... python3 tests/break.py
# Each check prints PASS or FAIL. Exits 1 on any FAIL. It writes posts and a comment to the site.
import http.cookiejar, urllib.request, urllib.parse, json, os, re, sys, time, concurrent.futures as cf
B = os.environ.get("B", "https://wp-on-d1-paid.skyphusion.workers.dev")
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
def opener(jar=None):
    jar = jar if jar is not None else http.cookiejar.CookieJar()
    o = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect)
    o.jar = jar; return o
def req(o, path, data=None, headers=None, method=None, timeout=120):
    h = {"User-Agent": "wp-on-cf-breaktest"}; h.update(headers or {})
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
    p = req(o, "/wp-admin/post-new.php")
    m = re.search(rb'createNonceMiddleware\( "([a-f0-9]+)', p["body"]); o.nonce = m.group(1).decode()
    return o
def rest(o, route, payload=None, method=None, raw=None, headers=None):
    h = {"X-WP-Nonce": o.nonce}; h.update(headers or {})
    data = raw
    if payload is not None: data = json.dumps(payload).encode(); h["Content-Type"] = "application/json"
    sep = "&" if "?" in route else "?"
    return req(o, "/?rest_route=" + route.replace("?", "&", 1), data, h, method)
def par(fn, items, n):
    with cf.ThreadPoolExecutor(n) as ex: return list(ex.map(fn, items))

results = []
def check(name, ok, detail=""):
    results.append(ok); print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""))

from collections import Counter
a = opener()
r = req(a, "/wp-content/db.php"); check("no PHP error text for a direct script hit", b"Fatal error" not in r["body"] and b"/wordpress/" not in r["body"], short(r))
r = req(a, "/wp-config.php"); check("wp-config.php source is not served", b"define(" not in r["body"], short(r))
r = req(a, "/xmlrpc.php", b"<x/>", {"Content-Type": "text/xml"}); check("xmlrpc.php is off", r["code"] == 403, short(r))
r = req(a, "/?rest_route=/wp/v2/posts", b"x" * (4 * 1024 * 1024), {"Content-Type": "application/json"}); check("a 4 MB body gets 413", r["code"] == 413, short(r))
r = req(a, "/_install", b"", method="POST"); check("/_install needs the spike token", r["code"] == 403, short(r))
for s in ["a" * 200, "\U0001F600" * 50, "') UNION SELECT user_pass FROM wp_users -- "]:
    r = req(a, "/?s=" + urllib.parse.quote(s))
    check(f"search {s[:12]!r}... len {len(s)}", r["code"] == 200 and r.get("fail") == "0" and b"$P$" not in r["body"] and b"$wp$" not in r["body"], short(r))
rs = par(lambda i: req(opener(), "/wp-login.php"), range(30), 30)
check("30 parallel requests, no 5xx", all(r["code"] == 200 for r in rs), str(Counter(r["code"] for r in rs)))
o = login()
rs = par(lambda i: rest(o, "/wp/v2/posts", {"title": f"break conc {i}", "content": f"<p>conc {i}</p>", "status": "publish"}), range(12), 12)
ids = [json.loads(r["body"]).get("id") for r in rs if r["code"] == 201]
check("12 parallel post creates, unique ids", len(ids) == 12 and len(set(ids)) == 12, str(Counter(r["code"] for r in rs)))
for kb in [100, 1900]:
    r = rest(o, "/wp/v2/posts", {"title": f"break {kb}KB", "content": "<p>" + ("x" * 99 + "\n") * (kb * 10) + "</p>", "status": "publish"})
    pid = json.loads(r["body"]).get("id") if r["code"] == 201 else None
    back = req(opener(), f"/?p={pid}") if pid else {"body": b""}
    check(f"a {kb} KB post saves and reads back", bool(pid) and b"x" * 99 in back["body"], short(r))
r = rest(o, "/wp/v2/media", raw=b"\x89PNG\r\n\x1a\n" + b"\x00" * 64, headers={"Content-Type": "image/png", "Content-Disposition": "attachment; filename=break.png"})
url = json.loads(r["body"]).get("source_url") if r["code"] == 201 else None
codes = Counter(req(opener(), url.split("workers.dev", 1)[-1])["code"] for _ in range(5)) if url else {}
check("an uploaded file is served by every isolate (R2)", codes == Counter({200: 5}), f"upload {r['code']}, fetch {dict(codes)}")
if url:
    mid = json.loads(r["body"])["id"]
    d = rest(o, f"/wp/v2/media/{mid}?force=true", method="DELETE")
    gone = req(opener(), url.split("workers.dev", 1)[-1])["code"]
    check("a deleted upload is gone from R2", d["code"] == 200 and gone == 404, f"delete {d['code']}, fetch {gone}")
print(f"{results.count(True)} pass, {results.count(False)} fail")
sys.exit(0 if all(results) else 1)
