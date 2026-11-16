#!/usr/bin/env python3
"""The conformance runner of #759: the upstream browser suites against a THROWAWAY site.

    runner.py prepare --suite wp|wc|gb --base-url https://<site> --cache on|off --run-dir <dir>
    runner.py config  --suite wp|wc|gb --suite-dir <upstream e2e dir> --run-dir <dir>
    runner.py summarize --report <playwright json> --out <results.json>
    runner.py compare --baseline <results.json> --ours <results.json>

prepare checks the site, sets it up and writes <run-dir>/env (mode 600) for Playwright. It STOPS
(exit 3) before any change when:
  - the URL is not https;
  - the site has no throwaway marker (php/pf-conformance-throwaway.php, shipped only by
    prepare-content.sh) or the marker names another host: the suites delete ALL content;
  - the host is on the deny list (PF_CONFORMANCE_DENY adds hosts);
  - the admin cannot log in through the wp-login.php form (Turnstile must be OFF on the site);
  - the page cache does not match --cache (one guest URL, fetched three times);
  - wc only: HTTP Basic with the application password is not 200, or a WRONG password is not
    401 (the control: it proves Basic is checked, not ignored). See #761.
The admin password comes from WP_PASSWORD and is never printed. For wc, the admin's account
password becomes a new application password, so ONE value passes the form and Basic (the
WooCommerce suite uses ADMIN_PASSWORD for both).

config writes pf-conformance.config.mjs beside the upstream config: one worker, no retries, no
webServer (the site is deployed), the exclusions of exclude/<suite>.txt as testIgnore, and a JSON
report. summarize and compare turn reports into the rows of the support matrix: compare marks a
test that fails on the stock baseline as "upstream", never as ours.
"""
import argparse, base64, http.cookiejar, json, os, re, shlex, sys, time, urllib.error, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DENY = {"ggc.sh", "www.ggc.sh"}
REQUIRE_HTTPS = True  # runner_test.py turns it off for its local http stub; no flag or env reaches it.
CACHED = {"HIT", "EXPIRED", "STALE", "REVALIDATED", "UPDATING"}
UPSTREAM_CONFIG = {"wp": "playwright.config.js", "wc": "playwright.config.ts", "gb": "playwright.config.ts"}
# The tags the upstream external envs drop (envs/default-pressable/playwright.config.ts).
WC_GREP_INVERT = "@skip-on-external-env|@skip-on-pressable|@could-be-lower-level-test|@non-critical|@to-be-removed"
TIMEOUT = 60


class Stop(Exception):
    """A refusal: the runner stops before (or instead of) the run."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


class Site:
    def __init__(self, base):
        self.base = base.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), NoRedirect)
        self.nonce = None

    def req(self, method, path, data=None, headers=None, form=False, cookies=True, raw=None, ctype=None):
        url = self.base + path
        h = {"User-Agent": "pf-conformance/759"}
        h.update(headers or {})
        body = None
        if raw is not None:
            body = raw
            h["Content-Type"] = ctype or "application/octet-stream"
        elif data is not None and form:
            body = urllib.parse.urlencode(data).encode()
            h["Content-Type"] = "application/x-www-form-urlencoded"
        elif data is not None:
            body = json.dumps(data).encode()
            h["Content-Type"] = "application/json"
        if self.nonce and cookies:
            h.setdefault("X-WP-Nonce", self.nonce)
        r = urllib.request.Request(url, data=body, headers=h, method=method)
        op = self.op if cookies else urllib.request.build_opener(NoRedirect)
        try:
            resp = op.open(r, timeout=TIMEOUT)
            return resp.status, dict(resp.headers.items()), resp.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers.items()), e.read()

    def json(self, method, path, data=None, **k):
        st, h, b = self.req(method, path, data, **k)
        try:
            return st, json.loads(b.decode() or "null")
        except ValueError:
            return st, None

    def login(self, user, password):
        self.jar.clear()
        self.nonce = None
        self.jar.set_cookie(http.cookiejar.Cookie(0, "wordpress_test_cookie", "WP Cookie check", None, False,
            urllib.parse.urlparse(self.base).hostname, False, False, "/", True, False, None, False, None, None, {}))
        st, h, _ = self.req("POST", "/wp-login.php", {"log": user, "pwd": password, "wp-submit": "Log In",
                                                      "testcookie": "1", "redirect_to": self.base + "/wp-admin/"}, form=True)
        if not any(c.name.startswith("wordpress_logged_in_") for c in self.jar):
            raise Stop("the wp-login.php form did not log the admin in (HTTP %d). Is Turnstile OFF on this site, "
                       "and is WP_PASSWORD the account password?" % st)
        st, h, b = self.req("GET", "/wp-admin/admin-ajax.php?action=rest-nonce")
        n = b.decode().strip()
        if st != 200 or not re.fullmatch(r"[0-9a-f]{6,}", n):
            raise Stop("no REST nonce after the form login (HTTP %d)" % st)
        self.nonce = n

    def basic(self, user, password, path="/wp-json/wp/v2/users/me?context=edit"):
        tok = base64.b64encode(("%s:%s" % (user, password)).encode()).decode()
        st, _, _ = self.req("GET", path, headers={"Authorization": "Basic " + tok}, cookies=False)
        return st


def say(*a):
    print("prepare:", *a, flush=True)


def check_target(site, args):
    u = urllib.parse.urlparse(site.base)
    if REQUIRE_HTTPS and u.scheme != "https":
        raise Stop("the base URL must be https (application passwords need it): %s" % site.base)
    deny = DENY | {h.strip() for h in os.environ.get("PF_CONFORMANCE_DENY", "").split(",") if h.strip()}
    if u.hostname in deny:
        raise Stop("%s is on the deny list: a real site, never a conformance target" % u.hostname)
    st, j = site.json("GET", "/wp-json/pf-conformance/v1/throwaway", cookies=False)
    if st != 200 or not isinstance(j, dict) or j.get("throwaway") is not True:
        raise Stop("no throwaway marker on %s (HTTP %d). The suites delete ALL content; build the site with "
                   "tests/conformance/prepare-content.sh" % (u.hostname, st))
    if j.get("host") != u.hostname:
        raise Stop("the marker names host %r, not %r" % (j.get("host"), u.hostname))
    say("throwaway marker: ok (%s)" % u.hostname)


def check_cache(site, want):
    seen = []
    for _ in range(3):
        st, h, _ = site.req("GET", "/", cookies=False)
        seen.append({k.lower(): v for k, v in h.items()}.get("cf-cache-status", "-").upper())
    cached = any(s in CACHED for s in seen)
    say("page cache: guest GET / x3 -> cf-cache-status %s" % ",".join(seen))
    if want == "on" and not cached:
        raise Stop("--cache on, but no cached answer in 3 guest fetches of / (%s)" % ",".join(seen))
    if want == "off" and cached:
        raise Stop("--cache off, but the page cache answered (%s): deploy with PAGE_CACHE_TTL=0" % ",".join(seen))
    return seen


def wc_setup(site, user, password, suite_dir):
    """The WooCommerce external setup, over REST (upstream: bin/test-env-setup-external.sh, WP-CLI)."""
    st, j = site.json("POST", "/wp-json/wp/v2/users/me/application-passwords", {"name": "pf-conformance-%d" % int(time.time())})
    if st != 201 or not isinstance(j, dict) or not j.get("password"):
        raise Stop("could not create an application password (HTTP %d)" % st)
    app = j["password"]
    # Basic FIRST: an application password works for Basic on its own. If Basic fails (#761), the
    # run stops while the account password is still the operator's own.
    good = site.basic(user, app)
    if good != 200:
        raise Stop("HTTP Basic with the application password returned %d, not 200. The WooCommerce suite "
                   "needs Basic; on b2 see #761 (PHP_AUTH_USER never set)" % good)
    bad = site.basic(user, app[:-1] + ("x" if app[-1] != "x" else "y"))
    if bad != 401:
        raise Stop("HTTP Basic with a WRONG password returned %d, not 401: Basic is not checked" % bad)
    say("basic auth: right password 200, wrong password 401")
    st, _ = site.json("POST", "/wp-json/wp/v2/users/me", {"password": app})
    if st != 200:
        raise Stop("could not set the account password (HTTP %d)" % st)
    site.login(user, app)
    say("admin: the account password is now the application password (form login ok)")
    cust = os.environ.get("CUSTOMER_PASSWORD") or base64.b32encode(os.urandom(15)).decode().lower()
    st, j = site.json("POST", "/wp-json/wp/v2/users", {"username": "customer", "password": cust,
        "email": "customer@woocommercecoree2etestsuite.com", "roles": ["customer"],
        "first_name": "Jane", "last_name": "Smith", "name": "Jane Smith"})
    if st == 400 and isinstance(j, dict) and j.get("code") == "existing_user_login":
        st, users = site.json("GET", "/wp-json/wp/v2/users?search=customer&context=edit")
        uid = next((u["id"] for u in users or [] if u.get("username") == "customer"), None)
        st, _ = site.json("POST", "/wp-json/wp/v2/users/%s" % uid, {"password": cust}) if uid else (404, None)
    if st not in (200, 201):
        raise Stop("could not create or update the customer user (HTTP %d)" % st)
    for name, value in (("blogname", "WooCommerce Core E2E Test Suite"), ("woocommerce_allow_tracking", "yes"),
                        ("permalink_structure", "/%postname%/")):
        st, _ = site.json("POST", "/wp-json/e2e-options/update", {"option_name": name, "option_value": value})
        if st != 200:
            raise Stop("e2e-options/update %s returned %d (is woocommerce-e2e-test-helper active?)" % (name, st))
    # An empty rewrite_rules option makes WordPress rebuild the rules on the next request.
    st, _ = site.json("POST", "/wp-json/e2e-options/delete", {"option_name": "rewrite_rules"})
    if st != 200:
        raise Stop("e2e-options/delete rewrite_rules returned %d" % st)
    images = os.path.join(suite_dir, "test-data", "images")
    for i in (1, 2, 3):
        p = os.path.join(images, "image-0%d.png" % i)
        if not os.path.isfile(p):
            raise Stop("no test image %s" % p)
        with open(p, "rb") as f:
            st, _, _ = site.req("POST", "/wp-json/wp/v2/media", raw=f.read(), ctype="image/png",
                                headers={"Content-Disposition": 'attachment; filename="image-0%d.png"' % i})
        if st != 201:
            raise Stop("media upload image-0%d.png returned %d" % (i, st))
    say("woocommerce setup: customer, options, permalinks, 3 images")
    return app, cust


def write_env(run_dir, pairs):
    os.makedirs(run_dir, exist_ok=True)
    p = os.path.join(run_dir, "env")
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        for k, v in pairs:
            f.write("export %s=%s\n" % (k, shlex.quote(v)))
    os.chmod(p, 0o600)
    return p


def cmd_prepare(a):
    user, password = os.environ.get("WP_USERNAME", "admin"), os.environ.get("WP_PASSWORD")
    if not password:
        raise Stop("WP_PASSWORD is not set (the admin account password)")
    site = Site(a.base_url)
    check_target(site, a)
    site.login(user, password)
    say("admin: form login and REST nonce ok")
    cache = check_cache(site, a.cache)
    pairs = [("WP_BASE_URL", site.base), ("WP_USERNAME", user)]
    if a.suite == "wc":
        if not a.suite_dir:
            raise Stop("--suite-dir is needed for wc (the test images)")
        app, cust = wc_setup(site, user, password, a.suite_dir)
        pairs += [("WP_PASSWORD", app), ("BASE_URL", site.base), ("ADMIN_USER", user), ("ADMIN_PASSWORD", app),
                  ("CUSTOMER_USER", "customer"), ("CUSTOMER_PASSWORD", cust)]
    else:
        pairs += [("WP_PASSWORD", password)]
    pairs += [("PF_CONFORMANCE_SUITE", a.suite), ("PF_CONFORMANCE_CACHE", a.cache),
              ("PF_CONFORMANCE_CACHE_SEEN", ",".join(cache))]
    p = write_env(a.run_dir, pairs)
    say("wrote %s (mode 600; it holds the passwords, never print it)" % p)


def read_excludes(suite):
    out = []
    with open(os.path.join(HERE, "exclude", suite + ".txt")) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                path, _, why = line.partition(" ")
                out.append((path, why.strip()))
    return out


def config_text(suite, run_dir):
    ign = [p for p, _ in read_excludes(suite)]
    rep = os.path.join(os.path.abspath(run_dir), "report.json")
    lines = ["// Written by tests/conformance/runner.py config (#759). Do not edit; re-run it.",
             "import base from './%s';" % UPSTREAM_CONFIG[suite]]
    if suite == "wc":
        lines.append("import { coreSetupProjects, TESTS_ROOT_PATH } from './%s';" % UPSTREAM_CONFIG[suite])
    lines += ["const ignore = %s;" % json.dumps(ign),
              "const config = { ...base, workers: 1, retries: 0, fullyParallel: false, webServer: undefined,",
              "  reporter: [ [ 'list' ], [ 'json', { outputFile: %s } ] ] };" % json.dumps(rep)]
    if suite == "wc":
        # As upstream envs/default-pressable: the setup projects, then one e2e project. No reset of the
        # whole store per run here (DISABLE_SITE_RESET is honoured by fixtures/reset.setup.ts).
        lines += ["config.testIgnore = undefined;",
                  "config.projects = [ ...coreSetupProjects,",
                  "  { name: 'reset', testDir: `${ TESTS_ROOT_PATH }/fixtures`, testMatch: 'reset.setup.ts' },",
                  "  { name: 'e2e-pf', testIgnore: ignore, grepInvert: new RegExp( %s ), dependencies: [ 'reset', 'site setup' ] } ];" % json.dumps(WC_GREP_INVERT)]
    else:
        lines += ["config.testIgnore = ignore;",
                  "if ( config.projects ) config.projects = config.projects.map( ( p ) => ( { ...p, testIgnore: ignore } ) );"]
    lines.append("export default config;")
    return "\n".join(lines) + "\n"


def cmd_config(a):
    up = os.path.join(a.suite_dir, UPSTREAM_CONFIG[a.suite])
    if not os.path.isfile(up):
        raise Stop("no upstream config %s" % up)
    p = os.path.join(a.suite_dir, "pf-conformance.config.mjs")
    with open(p, "w") as f:
        f.write(config_text(a.suite, a.run_dir))
    print(p)


def walk(suite, path=()):
    for s in suite.get("suites") or []:
        yield from walk(s, path + ((s.get("title") or ""),))
    for sp in suite.get("specs") or []:
        for t in sp.get("tests") or []:
            res = t.get("results") or [{}]
            yield {"file": sp.get("file") or suite.get("file"), "title": " > ".join([p for p in path[1:] if p] + [sp.get("title", "")]),
                   "project": t.get("projectName", ""), "status": t.get("status") or res[-1].get("status", "unknown")}


def cmd_summarize(a):
    with open(a.report) as f:
        rep = json.load(f)
    rows = [r for s in rep.get("suites", []) for r in walk(s, (s.get("title") or "",))]
    with open(a.out, "w") as f:
        json.dump(rows, f, indent=1)
    c = {}
    for r in rows:
        c[r["status"]] = c.get(r["status"], 0) + 1
    print("summarize: %d tests: %s" % (len(rows), ", ".join("%s %d" % kv for kv in sorted(c.items()))))


VERDICT = {("expected", "expected"): "pass", ("unexpected", "unexpected"): "upstream", ("expected", "unexpected"): "OURS",
           ("unexpected", "expected"): "ours-passes", ("skipped", "skipped"): "skipped"}


def compare_rows(base, ours):
    key = lambda r: (r["file"], r["title"])
    b = {key(r): r["status"] for r in base}
    out = []
    for r in ours:
        bs = b.get(key(r), "absent")
        out.append(dict(r, baseline=bs, verdict=VERDICT.get((bs, r["status"]), "flaky" if "flaky" in (bs, r["status"]) else "check")))
    return out


def cmd_compare(a):
    with open(a.baseline) as f:
        base = json.load(f)
    with open(a.ours) as f:
        ours = json.load(f)
    rows = compare_rows(base, ours)
    c = {}
    for r in rows:
        c[r["verdict"]] = c.get(r["verdict"], 0) + 1
    for r in rows:
        if r["verdict"] in ("OURS", "check", "flaky"):
            print("%-11s %s :: %s (baseline %s, ours %s)" % (r["verdict"], r["file"], r["title"], r["baseline"], r["status"]))
    print("compare: %d tests: %s" % (len(rows), ", ".join("%s %d" % kv for kv in sorted(c.items()))))
    return 1 if c.get("OURS") else 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("--suite", choices=("wp", "wc", "gb"), required=True)
    p.add_argument("--base-url", required=True)
    p.add_argument("--cache", choices=("on", "off"), required=True)
    p.add_argument("--run-dir", required=True)
    p.add_argument("--suite-dir")
    p = sub.add_parser("config")
    p.add_argument("--suite", choices=("wp", "wc", "gb"), required=True)
    p.add_argument("--suite-dir", required=True)
    p.add_argument("--run-dir", required=True)
    p = sub.add_parser("summarize")
    p.add_argument("--report", required=True)
    p.add_argument("--out", required=True)
    p = sub.add_parser("compare")
    p.add_argument("--baseline", required=True)
    p.add_argument("--ours", required=True)
    a = ap.parse_args(argv)
    try:
        return {"prepare": cmd_prepare, "config": cmd_config, "summarize": cmd_summarize, "compare": cmd_compare}[a.cmd](a) or 0
    except Stop as e:
        print("STOP: %s" % e, file=sys.stderr, flush=True)
        return 3


if __name__ == "__main__":
    sys.exit(main())
