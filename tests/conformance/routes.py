#!/usr/bin/env python3
"""The REST route runner (#759, the API inventory step 2). No upstream suite tests the WordPress REST API over
HTTP: wordpress-develop's REST tests run in-process (PHPUnit), so this walks a LIVE site's own index instead.

  B=<site> [WP_PASSWORD=<an app password> | ADMIN_PASSWORD=<the form password>] \
    python3 -I tests/conformance/routes.py <out.json> [--namespaces wp/v2,wc/v3,...] [--core <wp-api-generated.js>]

1. The index: GET /wp-json/ (raw; ?rest_route=/ if that is not JSON, recorded) lists every route and method.
2. Every route WITHOUT a path parameter and with GET: one GET as a guest and one as the admin. A route answers
   when its status is below 500 and its body is what its Content-Type says (a 400, 401 or 403 is a valid REST
   answer: a missing argument or no permission). It FAILS, by kind:
     json_contaminated  Content-Type JSON, but the body does not parse (PHP output before the JSON);
     rest_error_5xx     a 5xx whose body is a REST error object (it names a code: compare with a stock site);
     fatal              any other 5xx;
     no_answer          no answer in TIMEOUT seconds, or a network error.
   A declared non-JSON body (a zip from /wp-block-editor/v1/export) is a valid answer, recorded with its type.
3. Every route without a path parameter: OPTIONS as the admin returns its schema (JSON with "endpoints"), or FAILS.
4. --core <file>: core's own generated REST index at the pin (wordpress-develop tests/qunit/fixtures/
   wp-api-generated.js, mockedApiResponse.Schema). Every core route must be in the site's index; a missing
   one FAILS (a route our platform loses).
Routes with a path parameter ((?P<id>...)) are counted and listed, not called: they need a real object, which the
CRUD flows give (the next step).

The admin: Basic with WP_PASSWORD (the seed's application password, #775), else a form login with ADMIN_PASSWORD
and the REST nonce. Prints one @event line per failure and a summary; writes every result to <out.json>.
Exit 0: nothing failed. 1: a failure. 2: the index could not be read or the admin could not authenticate.
A GET is safe by the REST contract, but some routes do work (reports, remote fetches): run it on a throwaway.
The conformance test plugins' own namespaces (TEST_PLUGIN_NAMESPACES) are never called: they are not the product,
and two of their GETs are destructive by design. GET /wc-cleanup/v1/reset deletes the whole store and the test
images' sub-size files, and GET /e2e-feature-flags/reset resets WooCommerce's feature flags. A run that called
them reset the site before the suites (sb1120: cf759a, cf759p, cf759hl). They are listed in "skipped".
"""
import base64, http.cookiejar, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request

B = os.environ.get("B", "").rstrip("/")
TIMEOUT = float(os.environ.get("TIMEOUT", "60"))
UA = {"User-Agent": "pagefeather-conformance-routes"}
# woocommerce-cleanup, woocommerce-e2e-test-helper, wc-email-template-sync-test-helper, the throwaway marker.
TEST_PLUGIN_NAMESPACES = ("wc-cleanup/v1", "e2e-environment", "e2e-feature-flags", "e2e-options", "e2e-theme",
                          "wc-email-test-helper/v1", "pf-conformance/v1")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def opener():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()), NoRedirect)


def req(o, path, data=None, headers=None, method=None, ctype=False):
    h = dict(UA, **(headers or {}))
    t = time.time()
    try:
        r = o.open(urllib.request.Request(B + path, data=data, headers=h, method=method), timeout=TIMEOUT)
        out = (r.status, r.read(), round(time.time() - t, 3), r.headers.get("Content-Type") or "")
    except urllib.error.HTTPError as e:
        out = (e.code, e.read(), round(time.time() - t, 3), e.headers.get("Content-Type") or "")
    except Exception as e:
        out = (("TIMEOUT" if "timed out" in repr(e) else "EXC"), repr(e).encode()[:200], round(time.time() - t, 3), "")
    return out if ctype else out[:3]


def classify(status, body, ctype):
    """(ok, kind, rest error code): the rules of step 2."""
    if not isinstance(status, int):
        return False, "no_answer", None
    isjson_type = "json" in ctype.lower()
    d, parsed = js(body)
    code = d.get("code") if parsed and isinstance(d, dict) else None
    if status >= 500:
        return False, ("rest_error_5xx" if code else "fatal"), code
    if isjson_type and not parsed:
        return False, "json_contaminated", None
    if not isjson_type and not parsed:
        return True, "non_json:" + ctype.split(";")[0].strip(), None
    return True, "json", code


def js(b):
    try:
        return json.loads(b or b"null"), True
    except ValueError:
        return None, False


def event(_ev, **kw):
    print("@event %s %s" % (_ev, json.dumps(kw, sort_keys=True)), flush=True)


def admin_auth():
    """(opener, headers) for the admin, or exit 2."""
    if os.environ.get("WP_PASSWORD"):
        tok = base64.b64encode(("%s:%s" % (os.environ.get("ADMIN_USER", "admin"), os.environ["WP_PASSWORD"])).encode()).decode()
        o, h = opener(), {"Authorization": "Basic " + tok}
        c, b, _ = req(o, "/?rest_route=/wp/v2/users/me", headers=h)
        if c != 200:
            event("refused", why="Basic with WP_PASSWORD on /wp/v2/users/me answered %s" % c); sys.exit(2)
        return o, h, "basic"
    if os.environ.get("ADMIN_PASSWORD"):
        o = opener()
        req(o, "/wp-login.php")
        form = {"log": os.environ.get("ADMIN_USER", "admin"), "pwd": os.environ["ADMIN_PASSWORD"], "wp-submit": "Log In", "redirect_to": "/wp-admin/", "testcookie": "1"}
        if os.environ.get("TURNSTILE_TEST_TOKEN"):
            form["cf-turnstile-response"] = os.environ["TURNSTILE_TEST_TOKEN"]
        c, _, _ = req(o, "/wp-login.php", urllib.parse.urlencode(form).encode(), {"Content-Type": "application/x-www-form-urlencoded"})
        c2, n, _ = req(o, "/wp-admin/admin-ajax.php?action=rest-nonce")
        n = (n or b"").decode("utf-8", "replace").strip()
        if c not in (302, 303) or not re.fullmatch(r"[0-9a-f]{10}", n):
            event("refused", why="the admin form login failed (%s, nonce %s)" % (c, c2)); sys.exit(2)
        return o, {"X-WP-Nonce": n}, "cookie"
    event("refused", why="set WP_PASSWORD (Basic) or ADMIN_PASSWORD (a form login)"); sys.exit(2)


def core_routes(path):
    s = open(path, encoding="utf-8").read()
    i = s.index("mockedApiResponse.Schema = ") + len("mockedApiResponse.Schema = ")
    d, _ = json.JSONDecoder().raw_decode(s[i:])
    return d.get("routes") or {}


def rr(route):
    return "/?rest_route=" + urllib.parse.quote(route, safe="/:@!$'()*+,;=-._~")


def main(argv):
    if not B or not argv:
        sys.exit("usage: B=<site> [WP_PASSWORD=... | ADMIN_PASSWORD=...] routes.py <out.json> [--namespaces a,b] [--core <file>]")
    out = argv[0]
    nss = core = None
    for i, a in enumerate(argv):
        if a == "--namespaces": nss = set(argv[i + 1].split(","))
        if a == "--core": core = argv[i + 1]
    guest = opener()
    c, b, _ = req(guest, "/wp-json/")
    idx, ok = js(b)
    via = "/wp-json/"
    if not (c == 200 and ok and isinstance(idx, dict) and "routes" in idx):
        via = "?rest_route=/ (the raw /wp-json/ answered %s, %s)" % (c, "JSON" if ok else "not JSON")
        c, b, _ = req(guest, "/?rest_route=/")
        idx, ok = js(b)
        if not (c == 200 and ok and isinstance(idx, dict)):
            event("refused", why="the REST index could not be read (%s)" % c); sys.exit(2)
    a, ah, mode = admin_auth()
    routes = idx.get("routes") or {}
    res = {"site": B, "index_via": via, "admin_auth": mode, "routes": {}, "param_routes": [], "missing_core": [], "failures": [], "skipped": []}
    for route, d in sorted(routes.items()):
        ns = d.get("namespace") or "(root)"
        if nss and ns not in nss:
            continue
        if ns in TEST_PLUGIN_NAMESPACES:
            res["skipped"].append({"route": route, "namespace": ns, "why": "conformance test plugin, not the product"})
            continue
        methods = sorted(set(m for e in d.get("endpoints", []) for m in e.get("methods", [])))
        if "(?P<" in route:
            res["param_routes"].append({"route": route, "namespace": ns, "methods": methods})
            continue
        row = {"namespace": ns, "methods": methods}
        if "GET" in methods:
            for who, o, h in (("guest", guest, {}), ("admin", a, ah)):
                c, b, s, ct = req(o, rr(route), headers=h, ctype=True)
                good, kind, code = classify(c, b, ct)
                row[who] = {"status": c, "kind": kind, "s": s, "code": code}
                if not good:
                    res["failures"].append({"route": route, "as": who, "status": c, "kind": kind, "code": code})
                    event("fail", route=route, who=who, status=c, kind=kind, code=code)
        c, b, s, ct = req(a, rr(route), headers=ah, method="OPTIONS", ctype=True)
        body, isjson = js(b)
        schema_ok = c == 200 and isinstance(body, dict) and "endpoints" in body
        row["options"] = {"status": c, "schema": schema_ok}
        if not schema_ok:
            kind = classify(c, b, ct)[1] if c != 200 or not isjson else "no_schema"
            res["failures"].append({"route": route, "as": "admin OPTIONS", "status": c, "kind": kind})
            event("fail", route=route, who="admin OPTIONS", status=c, kind=kind)
        res["routes"][route] = row
    if core:
        cr = core_routes(core)
        res["core_routes"] = len(cr)
        for route, d in sorted(cr.items()):
            if (d.get("namespace") or "(root)") in (nss or {d.get("namespace") or "(root)"}) and route not in routes:
                res["missing_core"].append(route)
                res["failures"].append({"route": route, "as": "core index", "status": "missing"})
                event("fail", route=route, who="core index", status="missing")
    by = {}
    for route, row in res["routes"].items():
        n = by.setdefault(row["namespace"], {"called": 0, "params": 0})
        n["called"] += 1
    for p in res["param_routes"]:
        by.setdefault(p["namespace"], {"called": 0, "params": 0})["params"] += 1
    res["by_namespace"] = by
    with open(out, "w") as f:
        json.dump(res, f, indent=1, sort_keys=True)
    kinds = {}
    for f in res["failures"]:
        kinds[f.get("kind", f.get("status"))] = kinds.get(f.get("kind", f.get("status")), 0) + 1
    res["failure_kinds"] = kinds
    event("summary", index_via=via, admin=mode, called=len(res["routes"]), param_routes=len(res["param_routes"]),
          core_routes=res.get("core_routes"), missing_core=len(res["missing_core"]), failures=len(res["failures"]), kinds=kinds)
    return 1 if res["failures"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
