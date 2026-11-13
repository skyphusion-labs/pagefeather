#!/usr/bin/env python3
"""The tier-1 loader's REST read-back (#422): log in as the admin, then print the counts of posts and
pages in every status but trash and auto-draft, and of media, as JSON.

    theme-unit-counts.py <origin> <login> <password file> [<turnstile token>]

The password is read from a file, never from the command line. Counts come from X-WP-Total."""
import http.cookiejar, json, re, sys, urllib.parse, urllib.request

STATUSES = "publish,future,draft,pending,private"
ROUTES = {
    "posts": "/wp/v2/posts?per_page=1&context=edit&status=" + STATUSES,
    "pages": "/wp/v2/pages?per_page=1&context=edit&status=" + STATUSES,
    "media": "/wp/v2/media?per_page=1&context=edit",
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def opener():
    o = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()), NoRedirect)
    o.addheaders = [("User-Agent", "pagefeather-theme-unit-loader")]
    return o


def fetch(o, url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    try:
        r = o.open(req, timeout=120)
        return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def counts(origin, login, password, token="", op=None):
    o = op or opener()
    fetch(o, origin + "/wp-login.php", headers={"Cookie": "wordpress_test_cookie=WP+Cookie+check"})
    form = {"log": login, "pwd": password, "testcookie": "1", "redirect_to": "/wp-admin/"}
    if token:
        form["cf-turnstile-response"] = token
    code, _, _ = fetch(o, origin + "/wp-login.php", urllib.parse.urlencode(form).encode())
    if code != 302:
        raise SystemExit("theme-unit-counts: login answered %s" % code)
    _, _, body = fetch(o, origin + "/wp-admin/admin-ajax.php?action=rest-nonce")
    nonce = body.decode(errors="replace").strip()
    if not re.fullmatch(r"[a-f0-9]{10}", nonce):
        raise SystemExit("theme-unit-counts: no REST nonce")
    out = {}
    for name, route in ROUTES.items():
        code, h, _ = fetch(o, origin + "/?rest_route=" + route.replace("?", "&", 1), headers={"X-WP-Nonce": nonce})
        total = h.get("X-WP-Total") if h else None
        out[name] = int(total) if code == 200 and total and total.isdigit() else "none (HTTP %s)" % code
    return out


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    pw = open(sys.argv[3]).read().rstrip("\n")
    print(json.dumps(counts(sys.argv[1], sys.argv[2], pw, sys.argv[4] if len(sys.argv) > 4 else "")))
