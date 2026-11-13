#!/usr/bin/env python3
"""Offline tests for the Gate 2 CMS phase (tests/plugins/cms.py, #422): a fake WordPress with
state, no network.    python3 -I tests/plugins/cms_test.py
Each case has a passing control next to the fault that should produce its class."""
import io, json, os, re, sys, urllib.parse
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("ADMIN_PASSWORD", "pw")
os.environ.setdefault("TURNSTILE_TEST_TOKEN", "XXXX.DUMMY.TOKEN.XXXX")
import gate2 as G  # noqa: E402
import cms  # noqa: E402

failed = run = 0


def ok(name, fn):
    global failed, run
    run += 1
    try:
        fn()
        print("  ok   " + name)
    except Exception as e:
        failed += 1
        print("  FAIL %s: %r" % (name, e))


class FakeCMS:
    """WordPress as the CMS phase sees it: posts, revisions, media and their files, navigation,
    menus and items and locations, widget areas and widgets, settings, global styles, the
    Customizer save, users and roles and logins, comments from the front and by REST."""
    def __init__(self, block=True, **faults):
        self.block = block
        self.f = faults
        self.n = 100
        self.posts = {}
        self.media = {}
        self.nav = {}
        self.menus = {}
        self.items = {}
        self.locations = {"primary": {"menu": 0}}
        self.widgets = {}
        self.settings = {"description": "Just another site"}
        self.gs = {"7": {"styles": {"typography": {"fontSize": "1rem"}}}}
        self.users = {1: {"username": "admin", "pw": "pw", "roles": ["administrator"]}}
        self.comments = {}
        self.who = {}
        self.seen = []

    def nid(self):
        self.n += 1
        return self.n

    def __call__(self, o, path, data=None, headers=None, method=None, timeout=120):
        m = (method or ("POST" if data is not None else "GET")).upper()
        self.seen.append((m, path, data))
        h = {"x-boot": "0", "x-wasm-mib": "92"}
        q = urllib.parse.parse_qs(urllib.parse.urlparse(path).query)
        route = q.get("rest_route", [None])[0]
        arg = lambda k, d=None: q.get(k, [d])[0]
        body = data if isinstance(data, (bytes, type(None))) else urllib.parse.urlencode(data).encode()
        payload = {}
        if route and isinstance(data, bytes) and (headers or {}).get("Content-Type") == "application/json":
            payload = json.loads(data)
        me = self.who.get(id(o))

        def js(obj, code=200, total=None):
            hh = dict(h)
            if total is not None:
                hh["X-WP-Total"] = str(total)
            return {"code": code, "s": 0.01, "body": json.dumps(obj).encode(), "h": hh}
        page = lambda b, code=200: {"code": code, "s": 0.01, "body": b, "h": h}
        nf = js({"code": "rest_no_route"}, 404)

        if path.startswith("/wp-login.php"):
            if m == "POST":
                f = data if isinstance(data, dict) else dict(urllib.parse.parse_qsl(body.decode()))
                uid = next((i for i, u in self.users.items() if u["username"] == f.get("log") and u["pw"] == f.get("pwd")), None)
                if uid:
                    self.who[id(o)] = uid
                    return page(b"", 302)
            return page(b"<form></form>")
        if "action=rest-nonce" in path:
            return page(b"abcdef1234")
        if route is None and path.startswith("/wp-admin/admin-ajax.php") and isinstance(data, dict) and data.get("action") == "customize_save":
            ch = json.loads(data["customize_changeset_data"])
            if data.get("nonce") == "c0ffee1234" and not self.f.get("customize_ignored"):
                self.settings["description"] = ch["blogdescription"]["value"]
            return js({"success": data.get("nonce") == "c0ffee1234"})
        if path.startswith("/wp-comments-post.php"):
            f = data if isinstance(data, dict) else dict(urllib.parse.parse_qsl(body.decode()))
            if self.f.get("turnstile_required") and not f.get("cf-turnstile-response"):
                return page(b"<p>Error: verify you are human</p>", 403)
            c = self.nid()
            self.comments[c] = {"post": int(f["comment_post_ID"]), "content": f["comment"], "status": "hold", "parent": 0}
            return page(b"", 302)
        if path.startswith("/wp-content/uploads/"):
            name = path.split("/")[-1].split("?")[0]
            hit = next((x for x in self.media.values() if x["file"] == name), None)
            if not hit or self.f.get("media_404"):
                return page(b"", 404)
            return page(hit["bytes"])
        if path.startswith("/?p="):
            pid = int(path.split("p=")[1].split("&")[0])
            p = self.posts.get(pid)
            if not p or p["status"] != "publish":
                return page(b"not found", 404)
            cs = "".join("<li>%s</li>" % c["content"] for c in self.comments.values() if c["post"] == pid and c["status"] == "approved")
            return page(("<article>%s</article><ol>%s</ol>" % (p["content"], cs)).encode())
        if path.startswith("/?nocache=") or path == "/":
            return page(b"<html>home</html>")
        if path.startswith("/wp-admin/"):
            extra = b""
            if path.startswith("/wp-admin/post-new.php"):
                a = self.nid()
                self.posts[a] = {"title": "Auto Draft", "content": "", "status": "auto-draft", "author": me, "revisions": 0}
                extra = b'<input type="hidden" name="post_ID" value="%d">' % a
            if path.startswith("/wp-admin/customize.php"):
                extra = b'<script>var _wpCustomizeSettings = {"nonce":{"save":"c0ffee1234","preview":"x"},"changeset":{"uuid":"0f0e0d0c-0b0a-4908-8706-050403020100"}};</script>'
            if path.startswith("/wp-admin/options.php"):
                return page(b"", 302)
            return page(b'<body class="wp-admin"><div id="wpbody-content"><form method="post" action="options.php">'
                        b'<input name="blogname" value="Site"></form>' + extra + b"</div></body>")
        if not route:
            return page(b"", 404)

        r = route.rstrip("/")
        mm = re.fullmatch(r"/wp/v2/(posts|media|navigation|menus|menu-items|widgets|users|comments|global-styles)(?:/([^/]+))?(?:/(revisions))?", r)
        if r == "/wp/v2/themes":
            return js([{"stylesheet": "tt5" if self.block else "classic", "is_block_theme": self.block,
                        "_links": {"wp:user-global-styles": [{"href": "https://x/?rest_route=/wp/v2/global-styles/7"}]} if self.block else {}}])
        if r == "/wp/v2/settings":
            if m == "POST":
                self.settings.update(payload)
            return js(self.settings)
        if r == "/wp/v2/menu-locations":
            return js(self.locations)
        if r == "/wp/v2/sidebars":
            return js([{"id": "sidebar-1", "status": "active"}, {"id": "wp_inactive_widgets", "status": "inactive"}] if not self.f.get("no_sidebars") else [])
        if r == "/wp/v2/users/me":
            return js({"id": me})
        if not mm:
            return nf
        kind, ident, sub = mm.group(1), mm.group(2), mm.group(3)
        if kind == "posts":
            st = (arg("status") or "publish").split(",")
            if sub == "revisions":
                return js([{"id": i} for i in range(self.posts[int(ident)]["revisions"])])
            if ident is None and m == "POST":
                if not (self.users.get(me) or {}).get("roles"):
                    return js({"code": "rest_cannot_create"}, 403)
                pid = self.nid()
                self.posts[pid] = {"title": payload.get("title", ""), "content": payload.get("content", ""), "status": payload.get("status", "draft"), "author": me, "revisions": 0}
                return js({"id": pid}, 201)
            if ident is None:
                s_ = arg("search")
                lst = [dict(id=i, **v) for i, v in self.posts.items() if v["status"] in st and (not s_ or s_ in v["title"])]
                return js(lst[: int(arg("per_page", "10"))], total=len(lst))
            pid = int(ident)
            if pid not in self.posts:
                return nf
            p = self.posts[pid]
            if m == "DELETE":
                if not self.f.get("keep_on_delete"):
                    del self.posts[pid]
                    self.comments = {k: v for k, v in self.comments.items() if v["post"] != pid}
                return js({"deleted": True})
            if m == "POST":
                if "content" in payload and payload["content"] != p["content"] and not self.f.get("no_revisions"):
                    p["revisions"] += 1
                p.update({k: v for k, v in payload.items() if k in ("content", "status", "title")})
            return js({"id": pid, "status": p["status"], "author": p["author"], "content": {"raw": p["content"]}})
        if kind == "media":
            if ident is None and m == "POST":
                fn = re.search(r'filename="([^"]+)"', (headers or {}).get("Content-Disposition", "")).group(1)
                mid = self.nid()
                self.media[mid] = {"file": fn, "bytes": data, "title": fn.rsplit(".", 1)[0]}
                return js({"id": mid, "source_url": "https://x/wp-content/uploads/" + fn}, 201)
            if ident is None:
                s_ = arg("search")
                lst = [{"id": i} for i, v in self.media.items() if not s_ or s_ in v["title"]]
                return js(lst[: int(arg("per_page", "10"))], total=len(lst))
            mid = int(ident)
            if mid not in self.media:
                return nf
            if m == "DELETE":
                if not self.f.get("keep_on_delete"):
                    del self.media[mid]
                return js({"deleted": True})
            return js({"id": mid})
        if kind == "navigation":
            if ident is None and m == "POST":
                i = self.nid(); self.nav[i] = payload.get("content", "")
                return js({"id": i}, 201)
            if ident is None:
                return js([], total=len(self.nav))
            i = int(ident)
            if m == "DELETE":
                self.nav.pop(i, None); return js({"deleted": True})
            return js({"id": i, "content": {"raw": self.nav.get(i, "")}}) if i in self.nav else nf
        if kind == "menus":
            if ident is None and m == "POST":
                i = self.nid(); self.menus[i] = {"locations": payload.get("locations", [])}
                for loc in self.menus[i]["locations"]:
                    self.locations[loc]["menu"] = i
                return js({"id": i}, 201)
            if ident is None:
                return js([], total=len(self.menus))
            i = int(ident)
            if m == "DELETE":
                self.menus.pop(i, None)
                self.items = {k: v for k, v in self.items.items() if v != i}
                for loc in self.locations.values():
                    if loc["menu"] == i:
                        loc["menu"] = 0
                return js({"deleted": True})
            return js({"id": i, "locations": self.menus[i]["locations"]}) if i in self.menus else nf
        if kind == "menu-items":
            if ident is None and m == "POST":
                i = self.nid(); self.items[i] = payload["menus"]
                return js({"id": i}, 201)
            menu = int(arg("menus", "0"))
            return js([{"id": k} for k, v in self.items.items() if v == menu])
        if kind == "widgets":
            if ident is None and m == "POST":
                i = "block-%d" % self.nid()
                self.widgets[i] = payload["instance"]["raw"]["content"]
                return js({"id": i}, 201)
            if ident is None:
                return js([{"id": k} for k in self.widgets])
            if m == "DELETE":
                self.widgets.pop(ident, None); return js({"deleted": True})
            return js({"id": ident, "instance": {"raw": {"content": self.widgets[ident]}}}) if ident in self.widgets else nf
        if kind == "global-styles":
            g = self.gs[ident]
            if m == "POST":
                g["styles"] = payload.get("styles", {})
            return js({"id": int(ident), "styles": g["styles"]})
        if kind == "users":
            if ident is None and m == "POST":
                i = self.nid()
                self.users[i] = {"username": payload["username"], "pw": payload["password"], "roles": payload["roles"]}
                return js({"id": i}, 201)
            if ident is None:
                return js([], total=len(self.users))
            i = int(ident)
            if i not in self.users:
                return nf
            if m == "DELETE":
                to = int(arg("reassign", "0") or 0)
                for p in self.posts.values():
                    if p["author"] == i:
                        p["author"] = to
                del self.users[i]
                return js({"deleted": True})
            if m == "POST" and "roles" in payload and not self.f.get("role_ignored"):
                self.users[i]["roles"] = payload["roles"]
            return js({"id": i, "roles": self.users[i]["roles"]})
        if kind == "comments":
            if ident is None and m == "POST":
                i = self.nid()
                self.comments[i] = {"post": payload["post"], "content": payload["content"], "status": "approved", "parent": payload.get("parent", 0)}
                return js({"id": i}, 201)
            if ident is None:
                want = {"hold": "hold", "approve": "approved"}[arg("status", "approve")]
                post = arg("post")
                lst = [{"id": k, "status": v["status"], "content": {"raw": v["content"]}} for k, v in self.comments.items()
                       if v["status"] == want and (post is None or v["post"] == int(post))]
                return js(lst, total=len(lst))
            i = int(ident)
            c = self.comments[i]
            if m == "POST" and payload.get("status") == "approve" and not self.f.get("approve_ignored"):
                c["status"] = "approved"
            return js({"id": i, "status": c["status"], "content": {"raw": c["content"]}})
        return nf


def go(fake, rounds=1):
    buf = io.StringIO()
    G.OUT = buf
    G.ROWS.clear()
    G.instrument(fake)
    o = G.login()
    cms.run(o, rounds)
    return [json.loads(l) for l in buf.getvalue().splitlines()]


def steps(lines):
    """Each function's result (its "function" step), and the cleanup step."""
    return {l["item"]: l["ok"] for l in lines if l["ev"] == "step" and l["step"] in ("function", "cleanup")}


def writes(lines, item=None):
    return [l for l in lines if l["ev"] == "write" and (item is None or l.get("item") == item)]


def t_control_block():
    f = FakeCMS(block=True)
    lines = go(f)
    st = steps(lines)
    assert st == {"editor": True, "media": True, "menus": True, "widgets": None, "site-editor": True, "settings": True,
                  "users": True, "comments": True, "cleanup": True}, st
    bad = [w for w in writes(lines) if w["cls"] != "ok/ok"]
    assert not bad, bad
    assert all(l.get("ok") for l in lines if l["ev"] == "step" and l["step"] == "screen"), "a screen failed"
    assert not f.posts and not f.media and not f.nav and len(f.users) == 1, (f.posts, f.media, f.nav, f.users)
    assert f.settings["description"] == "Just another site" and f.gs["7"]["styles"] == {"typography": {"fontSize": "1rem"}}, "a value was not put back"


def t_control_classic():
    f = FakeCMS(block=False)
    lines = go(f)
    st = steps(lines)
    assert st == {"editor": True, "media": True, "menus": True, "widgets": True, "site-editor": True, "settings": True,
                  "users": True, "comments": True, "cleanup": True}, st
    menu = [w for w in writes(lines) if w["what"] == "menu"]
    assert menu and menu[0]["location"] == "primary" and menu[0]["items"] == 2, menu
    assert f.locations["primary"]["menu"] == 0 and not f.menus and not f.items and not f.widgets, "the menu or widget was left"
    assert any(w["what"] == "customize save" and w["cls"] == "ok/ok" for w in writes(lines)), "no customize save"


def t_location_taken():
    f = FakeCMS(block=False)
    f.locations["primary"]["menu"] = 5
    lines = go(f)
    menu = [w for w in writes(lines) if w["what"] == "menu"]
    assert menu[0]["location"] is None and f.locations["primary"]["menu"] == 5, (menu, f.locations)


def t_no_revisions():
    lines = go(FakeCMS(no_revisions=True))
    rv = [w for w in writes(lines) if w["what"] == "revisions"]
    assert rv and rv[0]["cls"] == "ok/unchanged" and rv[0]["before"] == 0 and rv[0]["after"] == 0, rv
    assert steps(lines)["editor"] is False


def t_media_not_stored():
    lines = go(FakeCMS(media_404=True))
    up = [w for w in writes(lines) if w["what"] == "upload"]
    assert up and up[0]["cls"] == "ok/unchanged" and up[0]["fileCode"] == 404, up
    assert steps(lines)["media"] is False


def t_leftover_fails_cleanup():
    f = FakeCMS(keep_on_delete=True)
    lines = go(f)
    cl = [l for l in lines if l["ev"] == "step" and l["step"] == "cleanup"][0]
    assert cl["ok"] is False and cl["left"].get("posts", 0) > 0, cl
    dl = [w for w in writes(lines) if w["what"] == "delete"]
    assert dl and dl[0]["cls"] == "ok/unchanged", dl


def t_role_ignored():
    lines = go(FakeCMS(role_ignored=True))
    rl = [w for w in writes(lines) if w["what"] == "role"]
    assert rl and rl[0]["cls"] == "ok/unchanged", rl
    assert steps(lines)["users"] is False


def t_customize_ignored():
    lines = go(FakeCMS(block=False, customize_ignored=True))
    cs = [w for w in writes(lines) if w["what"] == "customize save"]
    assert cs and cs[0]["cls"] == "ok/unchanged", cs


def t_comment_and_turnstile():
    lines = go(FakeCMS(turnstile_required=True))
    assert steps(lines)["comments"] is True, "the comment with the Turnstile test token failed"
    old = os.environ.pop("TURNSTILE_TEST_TOKEN")
    try:
        lines2 = go(FakeCMS(turnstile_required=True))
    finally:
        os.environ["TURNSTILE_TEST_TOKEN"] = old
    ac = [w for w in writes(lines2) if w["what"] == "anonymous comment"]
    assert ac and ac[0]["cls"] == "fail/fail", ac


def t_approve_ignored():
    lines = go(FakeCMS(approve_ignored=True))
    ap = [w for w in writes(lines) if w["what"] == "approve"]
    assert ap and ap[0]["cls"] == "ok/unchanged", ap


def t_no_widget_area():
    lines = go(FakeCMS(block=False, no_sidebars=True))
    w = [l for l in lines if l["ev"] == "step" and l["step"] == "widgets"]
    assert w and w[0]["ok"] is None and "no widget area" in w[0]["note"], w


def t_a_raise_is_a_result():
    real = cms.Round.media
    cms.Round.media = lambda self: 1 / 0
    try:
        lines = go(FakeCMS())
    finally:
        cms.Round.media = real
    st = steps(lines)
    assert st["media"] is False and st["menus"] is True and st["cleanup"] is True, st
    err = [l for l in lines if l["ev"] == "step" and l["step"] == "function" and l["item"] == "media"][0]
    assert "ZeroDivisionError" in err["err"], err


def t_rounds_and_headers_only():
    lines = go(FakeCMS(), rounds=2)
    cl = [l for l in lines if l["ev"] == "step" and l["step"] == "cleanup"]
    assert [c["round"] for c in cl] == [1, 2] and all(c["ok"] for c in cl), cl
    text = json.dumps(lines)
    assert '"pwd"' not in text and "cookie" not in text.lower(), "a password or cookie was recorded"
    reqs = [l for l in lines if l["ev"] == "req"]
    assert reqs and all("?" not in r["path"] and "body" not in r for r in reqs), "a query or body was recorded"
    runs = {l.get("round") for l in reqs}
    assert runs == {1, 2}, runs


def t_cleanup_retries_a_reset():
    state = {"n": 0}
    class Flaky(FakeCMS):
        pass
    fl = Flaky()
    orig = FakeCMS.__call__
    def call(self, o, path, data=None, headers=None, method=None, timeout=120):
        if method == "DELETE" and "rest_route=/wp/v2/posts/" in path and state["n"] < 2:
            state["n"] += 1
            return {"code": 500, "s": 0.01, "body": b"", "h": {"x-isolate-reset": "memory"}}
        return orig(self, o, path, data, headers, method, timeout)
    Flaky.__call__ = call
    slept = []
    cms.SLEEP = slept.append
    try:
        lines = go(fl)
    finally:
        cms.SLEEP = __import__("time").sleep
    assert steps(lines)["cleanup"] is True and slept == [10, 10], (steps(lines), slept)
    # control: with no retry (gone() tries once), the same fault leaves a row
    state["n"] = 0
    real_gone = cms.Round.gone
    cms.Round.gone = lambda self, route: self.rest(route, None, "DELETE")
    try:
        lines2 = go(Flaky())
    finally:
        cms.Round.gone = real_gone
    assert steps(lines2)["cleanup"] is False, steps(lines2)


def t_functions_switch():
    assert cms.functions({}) == cms.FUNCTIONS
    assert cms.functions({"CMS_FUNCTIONS": "settings, site-editor"}) == ("settings", "site_editor")
    try:
        cms.functions({"CMS_FUNCTIONS": "settings,nope"}); raise AssertionError("an unknown name ran")
    except SystemExit as e:
        assert "nope" in str(e)
    os.environ["CMS_FUNCTIONS"] = "users,editor"
    try:
        lines = go(FakeCMS())
    finally:
        del os.environ["CMS_FUNCTIONS"]
    assert [l["item"] for l in lines if l["ev"] == "step" and l["step"] == "function"] == ["users", "editor"]


def t_png():
    import struct, zlib
    b = cms.png()
    assert b[:8] == b"\x89PNG\r\n\x1a\n" and b[12:16] == b"IHDR" and struct.unpack(">II", b[16:24]) == (2, 2), b[:24]
    i = 8
    while i < len(b):
        n = struct.unpack(">I", b[i:i + 4])[0]; t = b[i + 4:i + 8]; d = b[i + 8:i + 8 + n]
        assert struct.unpack(">I", b[i + 8 + n:i + 12 + n])[0] == zlib.crc32(t + d) & 0xFFFFFFFF, t
        i += 12 + n


for name, fn in [("control, block theme: every function passes, every write ok/ok, nothing left, values put back", t_control_block),
                 ("control, classic theme: menus in an empty location, a widget, the Customizer save; nothing left", t_control_classic),
                 ("a menu location in use is not taken (the site's menu stays where it was)", t_location_taken),
                 ("saves that make no revision: revisions ok/unchanged, the editor fails", t_no_revisions),
                 ("an upload whose file is not served: upload ok/unchanged, media fails", t_media_not_stored),
                 ("a delete that keeps the row: delete ok/unchanged and the cleanup step fails on the counts", t_leftover_fails_cleanup),
                 ("a role change that does not stick: role ok/unchanged, users fails", t_role_ignored),
                 ("a Customizer save that does not stick: ok/unchanged", t_customize_ignored),
                 ("a visitor comment needs the Turnstile test token: with it ok, without it fail/fail", t_comment_and_turnstile),
                 ("an approve that does not stick: ok/unchanged", t_approve_ignored),
                 ("a classic theme with no widget area: widgets not applicable, not a fail", t_no_widget_area),
                 ("a function that raises is a failed result and the round goes on", t_a_raise_is_a_result),
                 ("ROUNDS=2: two rounds, each cleans up; headers only, no password, no query", t_rounds_and_headers_only),
                 ("cleanup tries a delete again after a 500 reset (housekeeping only); without it a row is left", t_cleanup_retries_a_reset),
                 ("CMS_FUNCTIONS picks and orders the functions; an unknown name is refused", t_functions_switch),
                 ("the test image is a valid PNG", t_png)]:
    ok(name, fn)
G.OUT = sys.stdout
print("cases_run=%d failed=%d" % (run, failed))
sys.exit(1 if failed else 0)
