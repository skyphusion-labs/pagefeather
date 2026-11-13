#!/usr/bin/env python3
"""Gate 2 tier 1 (#422): the CMS phase. The standard CMS work in wp-admin, measured on the
built-in stack (Conrad's ruling, 2026-11-13: "feels like WordPress" means these functions work;
installs and updates are code deploys). Run it through gate2.py:

    B=https://<throwaway> SPIKE_TOKEN=... ADMIN_USER=... ADMIN_PASSWORD=... \\
      TURNSTILE_TEST_TOKEN=XXXX.DUMMY.TOKEN.XXXX ROUNDS=1 \\
      python3 tests/plugins/gate2.py cms > cms.jsonl

One function at a time (the item of each row; a "function" step closes it with its result): editor, media, menus, widgets, site-editor (block theme) or customizer
(classic theme), settings, users, comments. Each write is read back and classed (ok/ok, fail/fail,
fail/changed, ok/unchanged); each request is recorded by gate2 (class, memory, reset, write-loss;
headers only). A failure is a result: no retry inside a step, and the next function still runs.

Everything a round creates carries the round's run id and is deleted at the end of the round. The
round then compares the site's counts (posts, pages, media, comments, users, menus, navigation,
widgets) with the counts before it: a round that leaves a row is a fail (step "cleanup").
Values a round changes (the tagline, the global styles) are put back and the restore is a write too.
"""
import json
import os
import re
import secrets
import struct
import urllib.parse
import uuid
import time
import zlib

import gate2 as G

L, P = G.L, G.P
STATUSES = "publish,future,draft,pending,private"
SLEEP = time.sleep  # the tests replace it


def png():
    """A valid 2x2 PNG made here: no image file in the repository, no image library."""
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + b"\xff\x00\x00" * 2 for _ in range(2))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def block(text):
    return "<!-- wp:paragraph -->\n<p>%s</p>\n<!-- /wp:paragraph -->" % text


def js(r):
    return G.jbody(r)


def total(r):
    v = G.hget(r, "X-WP-Total")
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def rel(url):
    """The path and query of a URL on this site (L.req adds the origin)."""
    u = urllib.parse.urlparse(url or "")
    return (u.path or "/") + ("?" + u.query if u.query else "")


class Round:
    def __init__(self, o, n):
        self.o = o
        self.run = "g2cms%d-%s" % (n, uuid.uuid4().hex[:6])
        self.created = {"posts": [], "media": [], "navigation": [], "menus": [], "widgets": [], "users": []}
        self.theme = {}

    def mark(self):
        return "%s-%s" % (self.run, uuid.uuid4().hex[:6])

    def rest(self, route, payload=None, method=None, **kw):
        return L.rest(self.o, route, payload, method, **kw)

    def screen(self, path):
        r = P.admin_get(self.o, path)
        ok = P.page_ok(r, admin=True)
        if path.startswith("/wp-admin/customize.php") and not ok:
            # The Customizer is a full-screen app: no #wpbody-content, and its <body> class is
            # wp-customizer, not wp-admin, so page_ok refused a good 200 (pft1a, 2026-11-13).
            b = r.get("body") or b""
            ok = r["code"] == 200 and not any(x in b for x in P.BAD) and bool(re.search(rb'<body[^>]*class="[^"]*\bwp-customizer\b', b))
        G.event("step", step="screen", ok=ok, page=path.split("?")[0], **P.code_info(r))
        return r, ok

    def post_raw(self, pid, kind="posts"):
        r = self.rest("/wp/v2/%s/%d?context=edit" % (kind, pid))
        b = js(r) or {}
        return r, b

    # ---- counts ------------------------------------------------------------------------
    def counts(self):
        c = {}
        for name, route in (("posts", "/wp/v2/posts?per_page=1&context=edit&status=" + STATUSES),
                            ("pages", "/wp/v2/pages?per_page=1&context=edit&status=" + STATUSES),
                            ("media", "/wp/v2/media?per_page=1&context=edit"),
                            ("commentsApproved", "/wp/v2/comments?per_page=1&context=edit&status=approve"),
                            ("commentsHeld", "/wp/v2/comments?per_page=1&context=edit&status=hold"),
                            ("users", "/wp/v2/users?per_page=1&context=edit"),
                            ("menus", "/wp/v2/menus?per_page=1&context=edit"),
                            ("navigation", "/wp/v2/navigation?per_page=1&context=edit&status=publish,draft")):
            c[name] = total(self.rest(route))
        w = js(self.rest("/wp/v2/widgets?context=edit"))
        c["widgets"] = len(w) if isinstance(w, list) else None
        return c

    # ---- the functions -----------------------------------------------------------------
    def editor(self):
        r, ok_new = self.screen("/wp-admin/post-new.php")
        m = re.search(rb"name=['\"]post_ID['\"] value=['\"](\d+)", r.get("body") or b"")
        if m:
            self.created["posts"].append(int(m.group(1)))  # the auto-draft post-new.php made
        m1 = self.mark()
        c = self.rest("/wp/v2/posts", {"title": self.run + " editor", "content": block(m1), "status": "draft"}, "POST")
        pid = (js(c) or {}).get("id")
        if not pid:
            G.write("create", False, False, code=c["code"])
            return False
        self.created["posts"].append(pid)
        G.write("create", G.ok2xx(c), m1 in ((self.post_raw(pid)[1].get("content") or {}).get("raw") or ""), code=c["code"])
        revs = lambda: js(self.rest("/wp/v2/posts/%d/revisions?context=edit&per_page=100" % pid))
        before = revs()
        last = m1
        saves = []
        for _ in range(2):
            last = self.mark()
            u = self.rest("/wp/v2/posts/%d" % pid, {"content": block(last)}, "POST")
            back = last in ((self.post_raw(pid)[1].get("content") or {}).get("raw") or "")
            G.write("save", G.ok2xx(u), back, code=u["code"])
            saves.append(G.ok2xx(u) and back)
        after = revs()
        nb = len(before) if isinstance(before, list) else None
        na = len(after) if isinstance(after, list) else None
        G.write("revisions", isinstance(after, list), nb is not None and na is not None and na - nb >= 2, before=nb, after=na)
        pub = self.rest("/wp/v2/posts/%d" % pid, {"status": "publish"}, "POST")
        published = self.post_raw(pid)[1].get("status") == "publish"
        G.write("publish", G.ok2xx(pub), published, code=pub["code"])
        fr = L.req(L.opener(), P.nc("/?p=%d" % pid))
        shown = fr["code"] == 200 and last.encode() in (fr.get("body") or b"")
        G.write("front", fr["code"] == 200, shown, code=fr["code"])
        _, ok_edit = self.screen("/wp-admin/post.php?post=%d&action=edit" % pid)
        return ok_new and all(saves) and published and shown and ok_edit and na is not None and nb is not None and na - nb >= 2

    def media(self):
        data = png()
        name = self.run + ".png"
        r = self.rest("/wp/v2/media", None, "POST", raw=data,
                      headers={"Content-Type": "image/png", "Content-Disposition": 'attachment; filename="%s"' % name})
        b = js(r) or {}
        mid = b.get("id")
        if not mid:
            G.write("upload", False, False, code=r["code"])
            return False
        self.created["media"].append(mid)
        got = L.req(L.opener(), rel(b.get("source_url")))
        stored = got["code"] == 200 and (got.get("body") or b"") == data
        G.write("upload", G.ok2xx(r), stored, code=r["code"], fileCode=got["code"])
        lib = self.rest("/wp/v2/media?context=edit&per_page=100&search=" + self.run)
        listed = isinstance(js(lib), list) and any(x.get("id") == mid for x in js(lib))
        G.write("library", G.ok2xx(lib), listed, code=lib["code"])
        _, ok_lib = self.screen("/wp-admin/upload.php")
        d = self.rest("/wp/v2/media/%d?force=true" % mid, None, "DELETE")
        gone = self.rest("/wp/v2/media/%d?context=edit" % mid)["code"] == 404
        G.write("delete", G.ok2xx(d), gone, code=d["code"])
        if gone:
            self.created["media"].remove(mid)
        return stored and listed and ok_lib and gone and G.ok2xx(d)

    def menus(self):
        if self.theme.get("is_block_theme"):
            labels = [self.mark(), self.mark()]
            content = "".join('<!-- wp:navigation-link {"label":"%s","url":"/"} /-->' % x for x in labels)
            r = self.rest("/wp/v2/navigation", {"title": self.run + " nav", "status": "publish", "content": content}, "POST")
            nid = (js(r) or {}).get("id")
            if nid:
                self.created["navigation"].append(nid)
            raw = ((js(self.rest("/wp/v2/navigation/%d?context=edit" % nid)) or {}).get("content") or {}).get("raw", "") if nid else ""
            back = all(x in raw for x in labels)
            G.write("navigation", G.ok2xx(r), back, code=r["code"])
            return G.ok2xx(r) and back
        locs = js(self.rest("/wp/v2/menu-locations?context=edit")) or {}
        free = [k for k, v in locs.items() if isinstance(v, dict) and not v.get("menu")] if isinstance(locs, dict) else []
        payload = {"name": self.run + " menu"}
        if free:
            payload["locations"] = [free[0]]  # only an EMPTY location: deleting the menu leaves it as it was
        r = self.rest("/wp/v2/menus", payload, "POST")
        mid = (js(r) or {}).get("id")
        if not mid:
            G.write("menu", False, False, code=r["code"])
            return False
        self.created["menus"].append(mid)
        oks = []
        for _ in range(2):
            it = self.rest("/wp/v2/menu-items", {"title": self.mark(), "url": L.B + "/", "menus": mid, "status": "publish"}, "POST")
            oks.append(G.ok2xx(it))
        items_ = js(self.rest("/wp/v2/menu-items?context=edit&per_page=100&menus=%d" % mid))
        n = len(items_) if isinstance(items_, list) else None
        loc_ok = True
        if free:
            loc_ok = free[0] in ((js(self.rest("/wp/v2/menus/%d?context=edit" % mid)) or {}).get("locations") or [])
        G.write("menu", G.ok2xx(r) and all(oks), n == 2 and loc_ok, items=n, location=free[0] if free else None, code=r["code"])
        _, ok_scr = self.screen("/wp-admin/nav-menus.php")
        return G.ok2xx(r) and all(oks) and n == 2 and loc_ok and ok_scr

    def widgets(self):
        if self.theme.get("is_block_theme"):
            G.event("step", step="widgets", ok=None, note="not applicable: a block theme has no widget areas")
            return None
        sb = js(self.rest("/wp/v2/sidebars?context=edit"))
        areas = [s for s in sb if isinstance(s, dict) and s.get("id") != "wp_inactive_widgets" and s.get("status") == "active"] if isinstance(sb, list) else []
        if not areas:
            G.event("step", step="widgets", ok=None, note="not applicable: the theme registers no widget area")
            return None
        m = self.mark()
        r = self.rest("/wp/v2/widgets", {"id_base": "block", "sidebar": areas[0]["id"], "instance": {"raw": {"content": block(m)}}}, "POST")
        wid = (js(r) or {}).get("id")
        if wid:
            self.created["widgets"].append(wid)
        back = False
        if wid:
            w = js(self.rest("/wp/v2/widgets/%s?context=edit" % urllib.parse.quote(wid))) or {}
            back = m in json.dumps(w.get("instance") or {}) or m in (w.get("rendered") or "")
        fr = L.req(L.opener(), P.nc("/"))
        G.write("widget", G.ok2xx(r), back, sidebar=areas[0]["id"], code=r["code"], shownOnFront=m.encode() in (fr.get("body") or b""))
        _, ok_scr = self.screen("/wp-admin/widgets.php")
        return G.ok2xx(r) and back and ok_scr

    def site_editor(self):
        if self.theme.get("is_block_theme"):
            _, ok_scr = self.screen("/wp-admin/site-editor.php")
            href = ((self.theme.get("_links") or {}).get("wp:user-global-styles") or [{}])[0].get("href", "")
            gid = (re.search(r"global-styles/(\d+)", urllib.parse.unquote(href)) or [None, None])[1]
            if not gid:
                G.write("global styles", False, False, why="no user global styles link on the active theme")
                return False
            old = js(self.rest("/wp/v2/global-styles/%s?context=edit" % gid)) or {}
            styles = json.loads(json.dumps(old.get("styles") or {}))
            if isinstance(styles, list):
                styles = {}  # WordPress returns [] for empty styles
            mark = "#%06x" % secrets.randbelow(0xFFFFFF)
            styles.setdefault("color", {})["background"] = mark
            r = self.rest("/wp/v2/global-styles/%s" % gid, {"styles": styles}, "POST")
            got = ((js(self.rest("/wp/v2/global-styles/%s?context=edit" % gid)) or {}).get("styles") or {})
            back = isinstance(got, dict) and (got.get("color") or {}).get("background") == mark
            G.write("global styles", G.ok2xx(r), back, code=r["code"])
            res = self.rest("/wp/v2/global-styles/%s" % gid, {"styles": old.get("styles") or {}}, "POST")
            now = (js(self.rest("/wp/v2/global-styles/%s?context=edit" % gid)) or {}).get("styles")
            same = json.dumps(now or {}, sort_keys=True) == json.dumps(old.get("styles") or {}, sort_keys=True)
            G.write("restore", G.ok2xx(res), same, code=res["code"])
            return ok_scr and G.ok2xx(r) and back and same
        r, ok_scr = self.screen("/wp-admin/customize.php")
        body = (r.get("body") or b"").replace(b"\\/", b"/")
        nonce = re.search(rb'"nonce":\{"save":"([a-f0-9]{10})"', body)
        uid = re.search(rb'"changeset":\{"uuid":"([0-9a-f-]{36})"', body)
        if not (nonce and uid):
            G.write("customize save", False, False, why="no save nonce or changeset uuid on customize.php")
            return False
        old = (js(self.rest("/wp/v2/settings")) or {}).get("description")
        m = self.mark()
        s = L.req(self.o, "/wp-admin/admin-ajax.php", {
            "action": "customize_save", "wp_customize": "on", "customize_theme": self.theme.get("stylesheet", ""),
            "nonce": nonce.group(1).decode(), "customize_changeset_uuid": uid.group(1).decode(),
            "customize_changeset_data": json.dumps({"blogdescription": {"value": m}}), "customize_changeset_status": "publish"})
        sb = js(s) or {}
        back = (js(self.rest("/wp/v2/settings")) or {}).get("description") == m
        G.write("customize save", G.ok2xx(s) and isinstance(sb, dict) and sb.get("success") is True, back, code=s["code"])
        res = self.rest("/wp/v2/settings", {"description": old or ""}, "POST")
        same = (js(self.rest("/wp/v2/settings")) or {}).get("description") == (old or "")
        G.write("restore", G.ok2xx(res), same, code=res["code"])
        return ok_scr and back and same

    def settings(self):
        old = (js(self.rest("/wp/v2/settings")) or {}).get("description")
        m = self.mark()
        r = self.rest("/wp/v2/settings", {"description": m}, "POST")
        back = (js(self.rest("/wp/v2/settings")) or {}).get("description") == m
        G.write("tagline", G.ok2xx(r), back, code=r["code"])
        res = self.rest("/wp/v2/settings", {"description": old or ""}, "POST")
        same = (js(self.rest("/wp/v2/settings")) or {}).get("description") == (old or "")
        G.write("restore", G.ok2xx(res), same, code=res["code"])
        form = G.settings_save(self.o, {"slug": "general"}, page="/wp-admin/options-general.php")
        return G.ok2xx(r) and back and same and bool(form and form.get("ok"))

    def users(self):
        me = (js(self.rest("/wp/v2/users/me?context=edit")) or {}).get("id")
        name = self.run + "-author"
        pw = secrets.token_urlsafe(18)  # this round only; the user is deleted below
        r = self.rest("/wp/v2/users", {"username": name, "email": self.run + "@example.com", "password": pw, "roles": ["author"], "name": name}, "POST")
        uid = (js(r) or {}).get("id")
        if not uid:
            G.write("create user", False, False, code=r["code"])
            return False
        self.created["users"].append(uid)
        roles = lambda: (js(self.rest("/wp/v2/users/%d?context=edit" % uid)) or {}).get("roles")
        G.write("create user", G.ok2xx(r), roles() == ["author"], code=r["code"])
        u = self.rest("/wp/v2/users/%d" % uid, {"roles": ["editor"]}, "POST")
        promoted = roles() == ["editor"]
        G.write("role", G.ok2xx(u), promoted, code=u["code"])
        drafted = False
        try:
            o2 = G.login(user=name, pw=pw)
            d = L.rest(o2, "/wp/v2/posts", {"title": self.run + " by the editor", "status": "draft"}, "POST")
            did = (js(d) or {}).get("id")
            if did:
                self.created["posts"].append(did)
            drafted = bool(did) and self.post_raw(did)[1].get("author") == uid
            G.write("draft as the new user", G.ok2xx(d), drafted, code=d["code"])
        except RuntimeError as e:
            G.write("draft as the new user", False, False, why="login as the new user: %s" % str(e)[:80])
        q = "?force=true&reassign=%s" % me if me else "?force=true"
        dl = self.rest("/wp/v2/users/%d%s" % (uid, q), None, "DELETE")
        gone = self.rest("/wp/v2/users/%d?context=edit" % uid)["code"] == 404
        G.write("delete user", G.ok2xx(dl), gone, code=dl["code"])
        if gone:
            self.created["users"].remove(uid)
        return G.ok2xx(r) and promoted and drafted and gone

    def comments(self):
        p = self.rest("/wp/v2/posts", {"title": self.run + " comments", "status": "publish", "comment_status": "open", "content": block(self.mark())}, "POST")
        pid = (js(p) or {}).get("id")
        if not pid:
            G.write("comment post", False, False, code=p["code"])
            return False
        self.created["posts"].append(pid)
        anon = L.opener()
        L.req(anon, P.nc("/?p=%d" % pid))
        m1 = self.mark()
        form = {"comment_post_ID": str(pid), "author": "Gate Two", "email": self.run + "@example.com", "url": "",
                "comment": m1, "comment_parent": "0", "submit": "Post Comment"}
        if os.environ.get("TURNSTILE_TEST_TOKEN"):
            form["cf-turnstile-response"] = os.environ["TURNSTILE_TEST_TOKEN"]
        c = L.req(anon, "/wp-comments-post.php", form)
        found = None
        for st in ("hold", "approve"):
            lst = js(self.rest("/wp/v2/comments?context=edit&per_page=100&post=%d&status=%s" % (pid, st)))
            for x in lst if isinstance(lst, list) else []:
                if m1 in ((x.get("content") or {}).get("raw") or ""):
                    found = x
        G.write("anonymous comment", c["code"] in (200, 302), found is not None, code=c["code"], status=(found or {}).get("status"))
        if not found:
            return False
        a = self.rest("/wp/v2/comments/%d" % found["id"], {"status": "approve"}, "POST")
        approved = (js(self.rest("/wp/v2/comments/%d?context=edit" % found["id"])) or {}).get("status") == "approved"
        G.write("approve", G.ok2xx(a), approved, code=a["code"])
        m2 = self.mark()
        rp = self.rest("/wp/v2/comments", {"post": pid, "parent": found["id"], "content": m2}, "POST")
        rid = (js(rp) or {}).get("id")
        replied = bool(rid) and m2 in (((js(self.rest("/wp/v2/comments/%d?context=edit" % rid)) or {}).get("content") or {}).get("raw") or "")
        G.write("reply", G.ok2xx(rp), replied, code=rp["code"])
        fr = L.req(L.opener(), P.nc("/?p=%d" % pid))
        fb = fr.get("body") or b""
        both = fr["code"] == 200 and m1.encode() in fb and m2.encode() in fb
        G.write("front shows both", fr["code"] == 200, both, code=fr["code"])
        _, ok_scr = self.screen("/wp-admin/edit-comments.php")
        return approved and replied and both and ok_scr

    # ---- cleanup -----------------------------------------------------------------------
    def gone(self, route):
        """Housekeeping, not a measurement: a delete that answers 5xx (a memory reset) is tried
        again, up to 3 times, 10 s apart. The first live round (pft1a, 2026-11-13) left two rows
        when every write after a reset answered 500."""
        r = None
        for i in range(3):
            r = self.rest(route, None, "DELETE")
            if not (isinstance(r.get("code"), int) and r["code"] >= 500) and r.get("code") != "EXC":
                return r
            if i < 2:
                SLEEP(10)
        return r

    def cleanup(self):
        routes = {"posts": "/wp/v2/posts/%s?force=true", "media": "/wp/v2/media/%s?force=true",
                  "navigation": "/wp/v2/navigation/%s?force=true", "menus": "/wp/v2/menus/%s?force=true",
                  "widgets": "/wp/v2/widgets/%s?force=true"}
        me = (js(self.rest("/wp/v2/users/me?context=edit")) or {}).get("id")
        for uid in list(self.created["users"]):
            self.gone("/wp/v2/users/%s?force=true&reassign=%s" % (uid, me))
        # Posts the round made that are not in the list (a reassigned draft, a lost id): by the run id.
        found = js(self.rest("/wp/v2/posts?context=edit&per_page=100&status=" + STATUSES + "&search=" + self.run))
        for x in found if isinstance(found, list) else []:
            if x.get("id") not in self.created["posts"]:
                self.created["posts"].append(x["id"])
        for kind, route in routes.items():
            for i in self.created[kind]:
                self.gone(route % urllib.parse.quote(str(i)))


FUNCTIONS = ("editor", "media", "menus", "widgets", "site_editor", "settings", "users", "comments")


def functions(env=os.environ):
    """CMS_FUNCTIONS="settings,users" runs those, in that order (to isolate one function, or to
    test whether the order matters). Default: all, in FUNCTIONS order. An unknown name is refused."""
    want = [x.strip().replace("-", "_") for x in (env.get("CMS_FUNCTIONS") or "").split(",") if x.strip()]
    bad = [x for x in want if x not in FUNCTIONS]
    if bad:
        raise SystemExit("CMS_FUNCTIONS: unknown %s (known: %s)" % (",".join(bad), ",".join(FUNCTIONS)))
    return tuple(want) or FUNCTIONS


def run(o, rounds=None):
    """Run the CMS phase ROUNDS times (default 1). Returns 0; the results are in the JSONL."""
    rounds = int(rounds if rounds is not None else os.environ.get("ROUNDS", "1"))
    for n in range(1, rounds + 1):
        rd = Round(o, n)
        G.CTX.clear(); G.CTX.update({"phase": "cms", "round": n, "item": "setup"})
        th = js(rd.rest("/wp/v2/themes?status=active&context=edit")) or []
        rd.theme = th[0] if isinstance(th, list) and th and isinstance(th[0], dict) else {}
        before = rd.counts()
        G.event("step", step="setup", ok=None, theme=rd.theme.get("stylesheet"), blockTheme=bool(rd.theme.get("is_block_theme")), counts=before)
        for name in functions():
            G.CTX.update({"item": name.replace("_", "-")})
            try:
                ok = getattr(rd, name)()
            except Exception as e:  # a failed function is a result; the round goes on
                ok = False
                G.event("step", step="function", ok=False, err=repr(e)[:200])
                try:
                    rd.o = G.login()
                except Exception as e2:
                    G.event("step", step="login", ok=False, err=repr(e2)[:200])
                continue
            G.event("step", step="function", ok=ok)
        G.CTX.update({"item": "cleanup"})
        try:
            rd.cleanup()
            after = rd.counts()
            same = after == before
            G.event("step", step="cleanup", ok=same, before=before, after=after,
                    left={k: (after.get(k) or 0) - (before.get(k) or 0) for k in before if after.get(k) != before.get(k)})
        except Exception as e:
            G.event("step", step="cleanup", ok=False, err=repr(e)[:200])
    return 0
