#!/usr/bin/env python3
"""Offline test of tests/wfp/plugin-memory.py (#344): a page-cache copy is never a fresh runtime.

A fake b-dosql site on localhost behaves like the real one where it matters:
  - POST /_evict answers 502 and makes the next page request boot (x-boot 1);
  - a cacheable page (no nocache parameter, not the Store API, cart or checkout) is served
    from a page cache after its first read, WITH the stored x-boot 1 and an age header, as
    measured on fdprobe1112g (2026-11-12: cf-cache-status HIT, age 41, x-boot 1, 0.2 s);
  - MODE=alwayshit answers every page from a cache (age), nocache or not.
Cases:
  1. the probe from main (before #344), against a warm page cache: it reports ok while its
     cold reads were cache copies (the defect, reproduced);
  2. the fixed probe, same site: every page read carries nocache, every cold read is a real
     boot, exit 0;
  3. the fixed probe against MODE=alwayshit: exit 2 (could not measure), naming the cache.
    python3 -I tests/wfp/plugin-memory-test.py [<old probe file>]
Without the old probe file, case 1 reads it from git (`git show <OLD_REF>:tests/wfp/plugin-memory.py`,
OLD_REF default 5bb6bf7, the last main before #344), and skips with a reason when git cannot
show it (a shallow CI checkout); cases 2 and 3 always run.
"""
import http.server, json, os, subprocess, sys, tempfile, threading, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
PROBE = os.path.join(HERE, "plugin-memory.py")
fails = 0


def check(name, ok, detail=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else ": " + detail))
    if not ok:
        fails += 1


class Site:
    def __init__(self, mode):
        self.mode, self.fresh, self.cache, self.paths = mode, False, {}, []


def handler(site):
    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def send(self, code, body, headers):
            self.send_response(code)
            for k, v in headers.items():
                self.send_header(k, v)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if self.path == "/_evict":
                site.fresh = True
                return self.send(502, b"evicting", {})
            self.send(404, b"", {})

        def do_GET(self):
            u = urllib.parse.urlsplit(self.path)
            q = urllib.parse.parse_qs(u.query)
            site.paths.append(self.path)
            if "rest_route" in q:
                body = json.dumps([{"id": 7, "name": "Mug", "type": "simple", "is_purchasable": True}]).encode()
                return self.send(200, body, self.boot_headers())
            cacheable = "nocache" not in q and "add-to-cart" not in q and not u.path.startswith(("/cart", "/checkout"))
            key = u.path + "?" + "&".join(sorted(k for k in q if k != "nocache"))
            if site.mode == "alwayshit":
                return self.send(200, b"<html>cached</html>", {"age": "41", "x-boot": "1", "x-wasm-mib": "99"})
            if cacheable and key in site.cache:
                return self.send(200, b"<html>cached</html>", dict(site.cache[key], age="41"))
            h = self.boot_headers()
            if cacheable:
                site.cache[key] = h
            self.send(200, b"<html>page</html>", h)

        def boot_headers(self):
            boot = "1" if site.fresh else "0"
            site.fresh = False
            return {"x-boot": boot, "x-wasm-mib": "99", "x-php-ms": "10"}

    return H


def serve(mode):
    site = Site(mode)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler(site))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return site, srv, "http://127.0.0.1:%d" % srv.server_address[1]


def run(probe, base):
    env = dict(os.environ, B=base, SPIKE_TOKEN="t", SETTLE_S="0")
    p = subprocess.run([sys.executable, "-I", probe], env=env, capture_output=True, text=True, timeout=120)
    summary = next((json.loads(l.split(" ", 2)[2]) for l in p.stdout.splitlines() if l.startswith("@event mem.summary ")), None)
    return p.returncode, summary, p.stdout + p.stderr


def warm_cache(site, base):
    # A visitor read each cacheable page once, so the page cache holds a copy with x-boot 1.
    import urllib.request
    for path in ("/", "/shop/", "/?p=7"):
        site.fresh = True
        urllib.request.urlopen(base + path).read()
    site.paths.clear()  # only the probe's own reads are checked


# 1. The defect, reproduced with the probe from before #344.
old = sys.argv[1] if len(sys.argv) > 1 else None
tmp = None
if not old:
    ref = os.environ.get("OLD_REF", "5bb6bf7")
    g = subprocess.run(["git", "-C", HERE, "show", ref + ":tests/wfp/plugin-memory.py"], capture_output=True, text=True)
    if g.returncode == 0 and "def bust(" not in g.stdout:
        tmp = tempfile.NamedTemporaryFile("w", suffix=".py", delete=False)
        tmp.write(g.stdout)
        tmp.close()
        old = tmp.name
if old:
    site, srv, base = serve("cache")
    warm_cache(site, base)
    rc, summ, out = run(old, base)
    srv.shutdown()
    check("before #344: the old probe passes on cache copies (the defect)", rc == 0 and summ and summ["ok"], "rc %s, %s" % (rc, out[-300:]))
    if tmp:
        os.unlink(tmp.name)
else:
    print("SKIP before #344: no old probe (git show %s failed); the fixed cases still run" % os.environ.get("OLD_REF", "5bb6bf7"))

# 2. The fixed probe on the same site.
site, srv, base = serve("cache")
warm_cache(site, base)
rc, summ, out = run(PROBE, base)
srv.shutdown()
pages = [p for p in site.paths if not p.startswith("/?rest_route") and "add-to-cart" not in p]
check("fixed: exit 0 and ok", rc == 0 and summ and summ["ok"], "rc %s, %s" % (rc, out[-300:]))
check("fixed: every page read carries nocache", pages and all("nocache=" in p for p in pages), str(pages))
check("fixed: every page got a fresh runtime", summ and not summ.get("notFresh") and not summ.get("cached"), json.dumps(summ))

# 3. A cache that answers even with nocache: could not measure.
site, srv, base = serve("alwayshit")
rc, summ, out = run(PROBE, base)
srv.shutdown()
check("a cache answer is could-not-measure (exit 2)", rc == 2, "rc %s, %s" % (rc, out[-300:]))
check("  and the summary names the cache", bool(summ) and "a cache answered" in summ.get("couldNotMeasure", ""), json.dumps(summ))

print("%d failing case(s)" % fails)
sys.exit(1 if fails else 0)
