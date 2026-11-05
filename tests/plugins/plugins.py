#!/usr/bin/env python3
"""The plugin suite test. Target-neutral: it uses only what a WordPress site
gives any client (the login form, the admin, the REST API).

For each plugin: activate it (REST), check the public site, the dashboard, the
plugin's own admin page and one thing the plugin does, then deactivate it.

Usage: B=<site url> ADMIN_PASSWORD=... plugins.py [slug ...]   (no slug: all)
Prints one JSON line per plugin. Exit 0 always: a failed check is a result.
"""
import json, os, re, sys, time, uuid
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../spikes/b2-wordpress/tests"))
import break_lib as L

HERE = os.path.dirname(__file__)
SUITE = [l.split()[0] for l in open(os.path.join(HERE, "suite.txt")) if l.strip() and not l.startswith("#")]

# The plugin's own main admin page.
ADMIN = {
    "elementor": "/wp-admin/admin.php?page=elementor",
    "wordpress-seo": "/wp-admin/admin.php?page=wpseo_dashboard",
    "contact-form-7": "/wp-admin/admin.php?page=wpcf7",
    "classic-editor": "/wp-admin/options-writing.php",
    "litespeed-cache": "/wp-admin/admin.php?page=litespeed",
    "google-site-kit": "/wp-admin/admin.php?page=googlesitekit-splash",
    "akismet": "/wp-admin/options-general.php?page=akismet-key-config",
    "wpforms-lite": "/wp-admin/admin.php?page=wpforms-overview",
    "all-in-one-wp-migration": "/wp-admin/admin.php?page=ai1wm_export",
    "wordfence": "/wp-admin/admin.php?page=Wordfence",
    "wp-mail-smtp": "/wp-admin/admin.php?page=wp-mail-smtp",
    # Before its setup is done or skipped Rank Math has only the registration
    # page; after, only the dashboard. The first one that exists is used.
    "seo-by-rank-math": ["/wp-admin/admin.php?page=rank-math", "/wp-admin/admin.php?page=rank-math-registration"],
    "updraftplus": "/wp-admin/options-general.php?page=updraftplus",
    "duplicate-post": "/wp-admin/options-general.php?page=duplicatepost",
    "duplicate-page": "/wp-admin/options-general.php?page=duplicate_page_settings",
    # page=jetpack is a small page whose script forwards to My Jetpack.
    "jetpack": "/wp-admin/admin.php?page=my-jetpack",
    "really-simple-ssl": "/wp-admin/options-general.php?page=really-simple-security",
    "insert-headers-and-footers": "/wp-admin/admin.php?page=wpcode",
}
BAD = (b"There has been a critical error", b"Fatal error", b"Parse error", b"Sorry, you are not allowed to access this page")


def nc(path):
    """A URL no cache has seen: B skips its page cache on ?nocache, and a fresh
    value misses any cache (the C1 Worker caches /?nocache like other URLs)."""
    return path + ("&" if "?" in path else "?") + "nocache=" + uuid.uuid4().hex[:8]


def page_ok(r, admin=False):
    if r["code"] != 200: return False
    b = r["body"]
    if any(x in b for x in BAD): return False
    if admin and r.get("redirected"): return True  # a plugin's own full-screen app
    # An admin page: the normal frame, or a full-screen plugin app (Jetpack,
    # Elementor and Rank Math onboarding) whose <body> still has class wp-admin.
    return (b'id="wpbody-content"' in b or bool(re.search(rb'<body[^>]*class="[^"]*\bwp-admin\b', b))) if admin else True


def admin_get(o, path):
    """GET an admin page. Up to 3 redirects to other admin pages are followed:
    plugins send the first admin visit after activation to their welcome page."""
    r = L.req(o, path)
    for _ in range(3):
        loc = (r["h"].get("Location") or "") if r["h"] else ""
        if r["code"] not in (301, 302) or "/wp-admin/" not in loc: break
        via = loc[loc.index("/wp-admin/"):]
        r = L.req(o, via); r["redirected"] = via[:120]
    return r


def step(name, fn, tries=3):
    """Run one check, up to 3 times (the Workers Free CPU limit stops some
    requests and not others). The result says how many tries it took and what
    the first failure was."""
    out = {}
    for t in range(1, tries + 1):
        t0 = time.time()
        try:
            ok, info = fn()
        except Exception as e:
            ok, info = False, {"err": repr(e)[:200]}
        prev = out
        out = {"ok": ok, "s": round(time.time() - t0, 2), "tries": t, **info}
        if t > 1: out["first"] = {k: v for k, v in prev.items() if k not in ("tries", "first")}
        if ok is not False or not info.get("retry", True): break
    out.pop("retry", None)
    return name, out


def code_info(r):
    i = {"code": r["code"]}
    if r.get("redirected"): i["via"] = r["redirected"]
    if r["code"] != 200 and r.get("body"):
        m = re.search(rb"<title>([^<]{0,120})", r["body"])
        if m: i["title"] = m.group(1).decode(errors="replace")
    if r.get("fail") not in (None, "0"): i["d1_failures"] = r["fail"]
    if r.get("body", b"").startswith(b"Worker exceeded CPU time limit"): i["reason"] = "cpu limit"
    if r.get("body", b"").startswith(b"Worker exceeded resource limits"): i["reason"] = "resource limit"
    return i


def plugin_admin(o, slug):
    paths = ADMIN[slug] if isinstance(ADMIN[slug], list) else [ADMIN[slug]]
    for p in paths:
        r = admin_get(o, p)
        if r["code"] != 403: break
    return r


def plugin_file(o, slug, tries=3):
    for _ in range(tries):
        r = L.rest(o, "/wp/v2/plugins")
        try:
            for p in json.loads(r["body"]):
                if p["plugin"].split("/")[0] == slug: return p["plugin"], p["status"]
            return None, None
        except ValueError:
            continue
    raise RuntimeError(f"plugin list failed: {code_info(r)}")


# One thing each plugin does, where a client can see it. Returns (ok, info).
def fn_check(o, slug):
    anon = L.opener()
    if slug == "wordpress-seo":
        h = L.req(anon, nc("/"))
        s = L.req(anon, nc("/?sitemap=1"))
        return (b"Yoast SEO" in h["body"] and b"<sitemapindex" in s["body"],
                {"what": "SEO tags in <head>; XML sitemap", "head": b"Yoast SEO" in h["body"], "sitemap": s["code"]})
    if slug == "seo-by-rank-math":
        skip_rank_math(o)
        h = L.req(anon, nc("/"))
        s = L.req(anon, nc("/?sitemap=1"))
        if b"<sitemapindex" not in s["body"]: s = L.req(anon, "/sitemap_index.xml")
        return (b"Rank Math" in h["body"] and b"<sitemapindex" in s["body"],
                {"what": "SEO tags in <head>; XML sitemap", "head": b"Rank Math" in h["body"], "sitemap": s["code"]})
    if slug == "contact-form-7":
        forms = json.loads(L.rest(o, "/contact-form-7/v1/contact-forms")["body"])
        if not forms:  # made on first activation; a reused site may have none
            return False, {"what": "form submit", "err": "no contact form"}
        fid = forms[0]["id"]
        pg = json.loads(L.rest(o, "/wp/v2/pages", {"title": "Contact", "status": "publish",
                        "content": f'[contact-form-7 id="{fid}"]'})["body"])
        view = L.req(anon, nc(f"/?page_id={pg['id']}"))
        fields = {"your-name": "Test", "your-email": "test@example.com", "your-subject": "Hi",
                  "your-message": "Plugin suite test.", "_wpcf7": str(fid),
                  "_wpcf7_unit_tag": f"wpcf7-f{fid}-p{pg['id']}-o1", "_wpcf7_container_post": str(pg["id"]),
                  "_wpcf7_locale": "en_US", "_wpcf7_version": "6.2.4.1"}
        bnd = "----suite"
        body = b"".join(f'--{bnd}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode() for k, v in fields.items()) + f"--{bnd}--\r\n".encode()
        r = L.req(anon, f"/?rest_route=/contact-form-7/v1/contact-forms/{fid}/feedback", body,
                  {"Content-Type": f"multipart/form-data; boundary={bnd}"})
        st = json.loads(r["body"]).get("status") if r["code"] == 200 else None
        L.rest(o, f"/wp/v2/pages/{pg['id']}?force=true", method="DELETE")
        # mail_failed: the form works and PHP has no mail transport (true on every setup here).
        return (b"wpcf7-form" in view["body"] and st in ("mail_sent", "mail_failed"),
                {"what": "form shows; submit accepted", "submit": st or r["code"]})
    if slug == "classic-editor":
        r = L.req(o, "/wp-admin/post-new.php")
        return (b"wp-editor-area" in r["body"], {"what": "post editor is the classic editor", **code_info(r)})
    if slug in ("duplicate-post", "duplicate-page"):
        lst = L.req(o, "/wp-admin/edit.php")
        pat = rb'href="([^"]*action=(?:duplicate_post_new_draft|dt_duplicate_post_as_draft)[^"]*)"'
        m = re.search(pat, lst["body"])
        if not m: return False, {"what": "duplicate a post", "err": "no duplicate link", **code_info(lst)}
        before = {p["id"] for p in json.loads(L.rest(o, "/wp/v2/posts?status=draft&per_page=100")["body"])}
        url = m.group(1).decode().replace("&amp;", "&")
        url = url[url.index("/wp-admin/"):] if "/wp-admin/" in url else "/wp-admin/" + url
        r = L.req(o, url)
        new = {p["id"] for p in json.loads(L.rest(o, "/wp/v2/posts?status=draft&per_page=100")["body"])} - before
        for i in new: L.rest(o, f"/wp/v2/posts/{i}?force=true", method="DELETE")
        return (r["code"] in (200, 302) and len(new) == 1, {"what": "duplicate a post", "code": r["code"], "new_drafts": len(new)})
    if slug == "elementor":
        pg = json.loads(L.rest(o, "/wp/v2/pages", {"title": "Elementor test", "status": "draft"})["body"])
        r = L.req(o, f"/wp-admin/post.php?post={pg['id']}&action=elementor")
        ok = r["code"] == 200 and b"elementor-editor" in r["body"] and not any(x in r["body"] for x in BAD)
        L.rest(o, f"/wp/v2/pages/{pg['id']}?force=true", method="DELETE")
        return ok, {"what": "Elementor editor opens", **code_info(r)}
    if slug == "insert-headers-and-footers":
        r = L.req(anon, nc("/"))
        return (r["code"] == 200, {"what": "public page renders", **code_info(r)})
    return None, {"what": "admin page only"}


POST = "/?p=1"


def find_post(o):
    """The first published post. Not always id 1: plugins that make content
    during the install can take the low ids (seen on a HostlessWP source site)."""
    global POST
    try:
        r = L.rest(o, "/wp/v2/posts&per_page=1&orderby=id&order=asc&status=publish")
        POST = "/?p=%d" % json.loads(r["body"])[0]["id"]
    except (ValueError, IndexError, KeyError):
        pass


def skip_rank_math(o):
    """The "skip" button of Rank Math's setup. Before it, Rank Math adds nothing
    to pages and its admin page is a full-screen wizard without the wp-admin
    frame, so this runs right after activation (seen 2026-11-05: the admin page
    check failed on a first activation, then passed)."""
    reg = L.req(o, "/wp-admin/admin.php?page=rank-math-registration")
    m = re.search(rb'"registerNonce":"([0-9a-f]+)"', reg["body"])
    if m: L.req(o, "/wp-admin/admin-post.php", {"action": "rank_math_skip_wizard", "security": m.group(1).decode()})


def baseline(o):
    """The same checks with no suite plugin active: what the setup does alone."""
    anon = L.opener(); steps = []
    steps.append(step("home", lambda: (lambda r: (page_ok(r), code_info(r)))(L.req(anon, nc("/")))))
    steps.append(step("post", lambda: (lambda r: (page_ok(r), code_info(r)))(L.req(anon, nc(POST)))))
    steps.append(step("dashboard", lambda: (lambda r: (page_ok(r, True), code_info(r)))(admin_get(o, "/wp-admin/"))))
    steps.append(step("admin_page", lambda: (lambda r: (page_ok(r, True), code_info(r)))(admin_get(o, "/wp-admin/plugins.php"))))
    return {"plugin": "(none)", "steps": dict(steps), "pass": all(v["ok"] for _, v in steps)}


def run(o, slug):
    if slug == "(none)": return baseline(o)
    res = {"plugin": slug}
    pf, status = plugin_file(o, slug)
    if not pf:
        res["error"] = "not installed"; return res
    if status == "active":
        L.rest(o, f"/wp/v2/plugins/{pf}", {"status": "inactive"})
    steps = []

    def activate():
        r = L.rest(o, f"/wp/v2/plugins/{pf}", {"status": "active"})
        ok = r["code"] == 200 and json.loads(r["body"]).get("status") == "active"
        if not ok:  # the request may have stopped after the plugin was activated
            _, st = plugin_file(o, slug)
            ok = st == "active"
        return ok, code_info(r)
    steps.append(step("activate", activate))
    if not steps[-1][1]["ok"]:
        res["steps"] = dict(steps); return res
    if slug == "seo-by-rank-math": skip_rank_math(o)
    anon = L.opener()
    steps.append(step("home", lambda: (lambda r: (page_ok(r), code_info(r)))(L.req(anon, nc("/")))))
    steps.append(step("post", lambda: (lambda r: (page_ok(r), code_info(r)))(L.req(anon, nc(POST)))))
    steps.append(step("dashboard", lambda: (lambda r: (page_ok(r, True), code_info(r)))(admin_get(o, "/wp-admin/"))))
    steps.append(step("admin_page", lambda: (lambda r: (page_ok(r, True), code_info(r)))(plugin_admin(o, slug))))
    steps.append(step("function", lambda: fn_check(o, slug)))
    steps.append(step("deactivate", lambda: (lambda r: (r["code"] == 200, code_info(r)))(
        L.rest(o, f"/wp/v2/plugins/{pf}", {"status": "inactive"}))))
    res["steps"] = dict(steps)
    res["pass"] = all(v["ok"] is not False for _, v in steps)
    return res


def main():
    slugs = ["(none)"] + (sys.argv[1:] or SUITE)
    o = None
    for t in range(3):  # Workers Free: the login can stop at the CPU limit
        try:
            o = L.login(); find_post(o); break
        except Exception as e:
            err = repr(e)[:200]
    for s in slugs:
        if o is None:
            r = {"plugin": s, "error": "login failed", "detail": err}
        else:
            try:
                r = run(o, s)
            except Exception as e:
                r = {"plugin": s, "error": "harness", "detail": repr(e)[:300]}
        r["target"] = L.B; r["date"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        print(json.dumps(r), flush=True)


if __name__ == "__main__":
    main()
