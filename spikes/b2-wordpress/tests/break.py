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
r = req(a, "/?rest_route=/wp/v2/posts", b"x" * (4 * 1024 * 1024), {"Content-Type": "application/json"}); check("a 4 MB body: refused, no server error", r["code"] in (400, 401, 413), short(r))
r = req(a, "/_install", b"", method="POST"); check("an anonymous /_install installs nothing", b'"installed"' not in r["body"], short(r))
for s in ["a" * 200, "\U0001F600" * 50, "') UNION SELECT user_pass FROM wp_users -- "]:
    r = req(a, "/?s=" + urllib.parse.quote(s))
    check(f"search {s[:12]!r}... len {len(s)}", r["code"] == 200 and r.get("fail") in (None, "0") and b"$P$" not in r["body"] and b"$wp$" not in r["body"], short(r))
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
import zlib, struct
def png(w, h):
    def ch(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    c = zlib.compressobj(9); row = b"\x00" + b"\x00" * (w * 3)
    data = b"".join(c.compress(row) for _ in range(h)) + c.flush()
    return b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + ch(b"IDAT", data) + ch(b"IEND", b"")
def upload(data, name):
    return rest(o, "/wp/v2/media", raw=data, headers={"Content-Type": "image/png", "Content-Disposition": f"attachment; filename={name}"})
T = int(time.time())
r = upload(png(6000, 6000), f"break-bomb-{T}.png")
sizes = json.loads(r["body"]).get("media_details", {}).get("sizes", {}) if r["code"] == 201 else {}
check("a 6000x6000 image uploads and gets its sizes (Images binding)", r["code"] == 201 and "thumbnail" in sizes, short(r))
check("the site still serves after it", req(opener(), "/?p=1")["code"] == 200)
rs = par(lambda i: upload(png(20 + i, 20), f"break-same-{T}.png"), range(8), 8)
srcs = [json.loads(x["body"]).get("source_url") for x in rs if x["code"] == 201]
check("8 parallel uploads of one name get 8 files", len(srcs) == 8 and len(set(srcs)) == 8, f"{len(set(srcs))} distinct of {len(srcs)}")
if srcs:
    u = srcs[0].split("workers.dev", 1)[-1]
    rr = req(opener(), u, headers={"Range": "bytes=0-9"})
    check("a Range request gets 206 and 10 bytes", rr["code"] == 206 and len(rr["body"]) == 10, short(rr))
r = req(opener(), "/wp-content/uploads/" + "a" * 2000)
check("a 2,000-character upload path gets 404, not an exception", r["code"] == 404, short(r))
# Page cache (Workers Cache)
def cstat(r): return (r["h"].get("cf-cache-status") if r["h"] else None)
home = f"/?cachetest={T}"
req(opener(), home)
for _ in range(3):
    time.sleep(2); h2 = req(opener(), home)
    if cstat(h2) == "HIT": break
check("a logged-out page is served from the edge cache", cstat(h2) == "HIT", str(cstat(h2)))
mine = req(o, home)
check("a logged-in visitor never gets the cached page", cstat(mine) != "HIT" and b"wpadminbar" in mine["body"], f"{cstat(mine)}, admin bar {b'wpadminbar' in mine['body']}")
title = f"Cache purge check {T}"
rest(o, "/wp/v2/posts", {"title": title, "content": "<p>x</p>", "status": "publish"})
seen = False
for _ in range(10):
    time.sleep(3)
    if title.encode() in req(opener(), home)["body"]:
        seen = True; break
check("publishing a post purges the cached page", seen)
r = upload(png(16, 16), f"break-cachedel-{T}.png")
if r["code"] == 201:
    m = json.loads(r["body"]); u = m["source_url"].split("workers.dev", 1)[-1]
    req(opener(), u); req(opener(), u)
    rest(o, f"/wp/v2/media/{m['id']}?force=true", method="DELETE")
    gone = False
    for _ in range(10):
        time.sleep(3)
        if req(opener(), u)["code"] == 404:
            gone = True; break
    check("a deleted upload is purged from the edge cache", gone)
# Large uploads: staged in R2 by the Worker, never whole in PHP
def noise_png(w, h):
    def ch(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    raw = b"".join(b"\x00" + os.urandom(w * 3) for _ in range(h))
    return b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw, 0)) + ch(b"IEND", b"")
big = noise_png(1600, 1400)
r = upload(big, f"break-large-{T}.png")
md = json.loads(r["body"]).get("media_details", {}) if r["code"] == 201 else {}
check(f"a {len(big) // 1048576} MB upload (over the 2 MB body cap) is stored and gets its sizes", r["code"] == 201 and "thumbnail" in md.get("sizes", {}), short(r))
if r["code"] == 201:
    src = json.loads(r["body"])["source_url"].split("workers.dev", 1)[-1]
    orig = src.rsplit("/", 1)[0] + "/" + (md.get("original_image") or md["file"].split("/")[-1])
    check("the stored original is byte-identical", req(opener(), orig)["body"] == big)
fake = b"<html><script>alert(1)</script>" + b"A" * (1500 * 1024)
r = rest(o, "/wp/v2/media", raw=fake, headers={"Content-Type": "image/jpeg", "Content-Disposition": f"attachment; filename=break-fake-{T}.jpg"})
check("a large HTML file named .jpg is refused", r["code"] >= 400, short(r))
r = rest(o, "/wp/v2/media", raw=b"\xff\xd8\xff" + b"\x00" * (21 * 1024 * 1024), headers={"Content-Type": "image/jpeg", "Content-Disposition": f"attachment; filename=break-huge-{T}.jpg"})
check("an upload over 20 MB gets 413", r["code"] == 413, short(r))
print(f"{results.count(True)} pass, {results.count(False)} fail")
sys.exit(0 if all(results) else 1)
