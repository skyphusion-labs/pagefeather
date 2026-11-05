#!/usr/bin/env python3
"""Does a persistent object cache show changes on the next page? (docs/perf-dosql.md)

Usage: B=<site url> ADMIN_PASSWORD=... [SPIKE_TOKEN=...] [ACTIVATE=1] python3 tests/load/cache_coherence.py

Each check changes something through WordPress, then reads a fresh logged-out
page (?nocache= and Cache-Control: no-cache, so the page cache does not
answer), then puts the old value back and reads again:
  global-styles  a background colour through REST (wp_global_styles; core
                 keeps theme_json out of a persistent cache for this reason)
  site-title     the site title through REST settings (an option)
  post-title     the title of the first post through REST
  activate       ACTIVATE=1: WooCommerce on through /_activate, its Store API
                 answers; off through REST, it does not (needs WooCommerce in
                 the build and the spike token on a deploy)
  cron           /wp-cron.php is served by the PHP object (x-php-object)
Prints PASS or FAIL per check. Exits 1 on any FAIL.
"""
import json, os, sys, uuid
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "spikes", "b2-wordpress", "tests"))
import break_lib as L

TOKEN = os.environ.get("SPIKE_TOKEN", "")
bad = 0


def check(name, ok, detail=""):
    global bad
    print(("PASS " if ok else "FAIL ") + name + (" | " + detail if detail else ""), flush=True)
    bad += 0 if ok else 1


def fresh(o, path="/"):
    p = path + ("&" if "?" in path else "?") + "nocache=" + uuid.uuid4().hex[:8]
    return L.req(o, p, headers={"Cache-Control": "no-cache"})


def rest(admin, nonce, route, payload=None, method=None):
    h = {"X-WP-Nonce": nonce, "Content-Type": "application/json"}
    data = json.dumps(payload).encode() if payload is not None else None
    r = L.req(admin, "/?rest_route=" + route, data=data, headers=h, method=method or ("POST" if data else "GET"))
    try:
        return r["code"], json.loads(r["body"] or b"null")
    except ValueError:
        return r["code"], None


admin = L.login()
anon = L.opener()
page = L.req(admin, "/wp-admin/post-new.php")
nonce = ((page["body"] or b"").decode("utf-8", "replace").split('createNonceMiddleware( "')[1:] or [""])[0].split('"')[0]
check("admin nonce", bool(nonce))

# global styles
code, themes = rest(admin, nonce, "/wp/v2/themes&status=active")
gid = None
try:
    href = themes[0]["_links"]["wp:user-global-styles"][0]["href"]
    gid = href.rstrip("/").split("/")[-1].split("=")[-1]
except (TypeError, KeyError, IndexError):
    pass
check("global styles id", bool(gid), "themes %s" % code)
if gid:
    code, cur = rest(admin, nonce, "/wp/v2/global-styles/%s" % gid)
    old = (cur or {}).get("styles") or {}
    colour = "#%06x" % (uuid.uuid4().int % 0xFFFFFF)
    new = json.loads(json.dumps(old)); new.setdefault("color", {})["background"] = colour
    code, _ = rest(admin, nonce, "/wp/v2/global-styles/%s" % gid, {"styles": new})
    body = (fresh(anon)["body"] or b"").decode("utf-8", "replace")
    check("global-styles change shows", colour in body, "write %s, colour %s" % (code, colour))
    code, _ = rest(admin, nonce, "/wp/v2/global-styles/%s" % gid, {"styles": old})
    body = (fresh(anon)["body"] or b"").decode("utf-8", "replace")
    check("global-styles restore shows", colour not in body, "write %s" % code)

# site title
code, settings = rest(admin, nonce, "/wp/v2/settings")
old_title = (settings or {}).get("title")
title = "Coherence " + uuid.uuid4().hex[:8]
code, _ = rest(admin, nonce, "/wp/v2/settings", {"title": title})
body = (fresh(anon)["body"] or b"").decode("utf-8", "replace")
check("site-title change shows", title in body, "write %s" % code)
code, _ = rest(admin, nonce, "/wp/v2/settings", {"title": old_title})
body = (fresh(anon)["body"] or b"").decode("utf-8", "replace")
check("site-title restore shows", title not in body and (old_title or "") in body, "write %s" % code)

# post title
code, posts = rest(admin, nonce, "/wp/v2/posts&per_page=1&orderby=id&order=asc")
pid = posts[0]["id"] if posts else None
check("post id", bool(pid), "posts %s" % code)
if pid:
    code, cur = rest(admin, nonce, "/wp/v2/posts/%d&context=edit" % pid)
    old_post = (cur or {}).get("title", {}).get("raw")
    ptitle = "Coherence post " + uuid.uuid4().hex[:8]
    code, _ = rest(admin, nonce, "/wp/v2/posts/%d" % pid, {"title": ptitle})
    body = (fresh(anon, "/?p=%d" % pid)["body"] or b"").decode("utf-8", "replace")
    check("post-title change shows", ptitle in body, "write %s" % code)
    code, _ = rest(admin, nonce, "/wp/v2/posts/%d" % pid, {"title": old_post})
    body = (fresh(anon, "/?p=%d" % pid)["body"] or b"").decode("utf-8", "replace")
    check("post-title restore shows", ptitle not in body, "write %s" % code)

# /_activate (WooCommerce), then off through REST
if os.environ.get("ACTIVATE") == "1":
    st = lambda: fresh(anon, "/?rest_route=/wc/store/v1/products")["code"]
    before = st()
    h = {"x-spike-token": TOKEN} if TOKEN else {}
    a = L.req(anon, "/_activate?plugin=woocommerce/woocommerce.php", data=b"", headers=h, method="POST")
    on = st()
    check("activate shows", on == 200, "before %s, /_activate %s, after %s" % (before, a["code"], on))
    code, _ = rest(admin, nonce, "/wp/v2/plugins/woocommerce/woocommerce", {"status": "inactive"})
    off = st()
    check("deactivate shows", off != 200, "REST %s, after %s" % (code, off))

# cron
r = L.req(anon, "/wp-cron.php")
check("cron through the object", r["code"] == 200 and (r["h"].get("x-php-object") if r["h"] else None) == "php-0",
      "code %s, x-php-object %s" % (r["code"], r["h"].get("x-php-object") if r["h"] else None))

print("FAILS %d" % bad)
sys.exit(1 if bad else 0)
