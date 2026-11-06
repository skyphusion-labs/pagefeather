#!/usr/bin/env python3
"""Gate for the REST route cache (php/rest-route-cache.php, issue #53).

Usage: B=<site url> ADMIN_PASSWORD=... python3 tests/load/route_cache_check.py
FILTER_CHECK=1 also checks the fail-safe rule: run it on a build that has a
test mu-plugin on wp_theme_json_data_theme (not a shipped file), and all three
routes must answer bypass:filter:... (each depends on the theme.json filters).

Checks (PASS or FAIL each; exit 1 on any FAIL):
  hit         the second admin GET of each cached route answers X-Route-Cache: hit
  permission  logged out: 401, and a subscriber: 403, on each route, after the
              cache holds them; neither answer carries X-Route-Cache, so the
              cache was not asked (it answers only after permission_callback)
  template    a custom single-post template written through REST shows in
              templates/lookup and in post-new's preload; after it is deleted,
              neither shows it
  styles      a global styles change written through REST shows in post-new's
              preload, and its restore too
It creates a subscriber (deleted at the end) and a template (deleted).
"""
import json, os, sys, urllib.parse, uuid
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "spikes", "b2-wordpress", "tests"))
import break_lib as L

ROUTES = ["/wp/v2/global-styles/themes/twentytwentyfive", "/wp/v2/global-styles/themes/twentytwentyfive/variations", "/wp/v2/templates/lookup?slug=single-post"]
bad = 0


def check(name, ok, detail=""):
    global bad
    print(("PASS " if ok else "FAIL ") + name + (" | " + detail if detail else ""), flush=True)
    bad += 0 if ok else 1


def url(route):
    path, _, q = route.partition("?")
    return "/?rest_route=" + path + ("&" + q if q else "")


def login(user, pw):
    o = L.opener()
    L.req(o, "/wp-login.php")
    r = L.req(o, "/wp-login.php", data={"log": user, "pwd": pw, "wp-submit": "Log In", "redirect_to": "/wp-admin/", "testcookie": "1"})
    return o, r["code"]


def nonce_of(o):
    body = (L.req(o, "/wp-admin/post-new.php")["body"] or b"").decode("utf-8", "replace")
    return (body.split('createNonceMiddleware( "')[1:] or [""])[0].split('"')[0], body


def rest(o, nonce, route, payload=None, method=None):
    h = {"X-WP-Nonce": nonce, "Content-Type": "application/json"} if nonce else {}
    data = json.dumps(payload).encode() if payload is not None else None
    r = L.req(o, url(route), data=data, headers=h, method=method or ("POST" if data else "GET"))
    hdr = (r["h"].get("x-route-cache") if r["h"] else None)
    try:
        js = json.loads(r["body"] or b"null")
    except ValueError:
        js = None
    return r["code"], hdr, js, (r["body"] or b"").decode("utf-8", "replace")


admin = L.login()
nonce, _ = nonce_of(admin)
check("admin nonce", bool(nonce))

# hit
for route in ROUTES:
    rest(admin, nonce, route)
    code, hdr, _, _ = rest(admin, nonce, route)
    # All three routes depend on the theme.json filters, so the test filter must bypass all three.
    if os.environ.get("FILTER_CHECK") == "1":
        check("fail-safe bypass " + route, code == 200 and (hdr or "").startswith("bypass:filter:"), "code %s, X-Route-Cache %s" % (code, hdr))
    else:
        check("hit " + route, code == 200 and hdr == "hit", "code %s, X-Route-Cache %s" % (code, hdr))

# permission: logged out, then a subscriber
anon = L.opener()
for route in ROUTES:
    code, hdr, _, _ = rest(anon, None, route)
    check("logged out refused " + route, code == 401 and hdr is None, "code %s, X-Route-Cache %s" % (code, hdr))
spw = uuid.uuid4().hex + "Aa1!"
sname = "rc" + uuid.uuid4().hex[:8]
code, _, sub, _ = rest(admin, nonce, "/wp/v2/users", {"username": sname, "email": sname + "@example.com", "password": spw, "roles": ["subscriber"]})
check("subscriber created", code == 201, "code %s" % code)
if code == 201:
    so, lc = login(sname, spw)
    snonce = (L.req(so, "/wp-admin/admin-ajax.php?action=rest-nonce")["body"] or b"").decode().strip()
    for route in ROUTES:
        code, hdr, _, _ = rest(so, snonce, route)
        check("subscriber refused " + route, code == 403 and hdr is None, "login %s, code %s, X-Route-Cache %s" % (lc, code, hdr))
    rest(admin, nonce, "/wp/v2/users/%d?force=true&reassign=1" % sub["id"], method="DELETE")

# template: write a custom single-post template, then delete it
marker = "RouteCacheMarker" + uuid.uuid4().hex[:8]
content = "<!-- wp:paragraph --><p>%s</p><!-- /wp:paragraph -->" % marker
code, _, tpl, _ = rest(admin, nonce, "/wp/v2/templates", {"slug": "single-post", "title": "Coherence", "content": content})
tid = (tpl or {}).get("id")
check("template written", code in (200, 201) and bool(tid), "code %s, id %s" % (code, tid))
code, hdr, _, body = rest(admin, nonce, ROUTES[2])
check("template shows in lookup", marker in body, "code %s, X-Route-Cache %s" % (code, hdr))
_, page = nonce_of(admin)
check("template shows in post-new preload", marker in page)
if tid:
    code, _, _, _ = rest(admin, nonce, "/wp/v2/templates/%s?force=true" % urllib.parse.quote(tid, safe="/"), method="DELETE")
    code2, hdr, _, body = rest(admin, nonce, ROUTES[2])
    check("template delete shows in lookup", marker not in body, "delete %s, lookup %s, X-Route-Cache %s" % (code, code2, hdr))
    _, page = nonce_of(admin)
    check("template delete shows in post-new preload", marker not in page)

# global styles: a change, then the restore, in post-new's preload
code, _, themes, _ = rest(admin, nonce, "/wp/v2/themes?status=active")
gid = None
try:
    gid = themes[0]["_links"]["wp:user-global-styles"][0]["href"].rstrip("/").split("/")[-1].split("=")[-1]
except (TypeError, KeyError, IndexError):
    pass
check("global styles id", bool(gid))
if gid:
    _, _, cur, _ = rest(admin, nonce, "/wp/v2/global-styles/%s?context=edit" % gid)
    old = (cur or {}).get("styles") or {}
    colour = "#%06x" % (uuid.uuid4().int % 0xFFFFFF)
    new = json.loads(json.dumps(old)); new.setdefault("color", {})["text"] = colour
    code, _, _, _ = rest(admin, nonce, "/wp/v2/global-styles/%s" % gid, {"styles": new})
    _, page = nonce_of(admin)
    check("styles change shows in post-new preload", colour in page, "write %s, colour %s" % (code, colour))
    code, _, _, _ = rest(admin, nonce, "/wp/v2/global-styles/%s" % gid, {"styles": old})
    _, page = nonce_of(admin)
    check("styles restore shows in post-new preload", colour not in page, "write %s" % code)

print("FAILS %d" % bad)
sys.exit(1 if bad else 0)
