#!/usr/bin/env python3
"""The conformance runner of #759: the upstream browser suites against a THROWAWAY site.

    runner.py prepare --suite wp|wc|wc-api|gb --base-url https://<site> --cache on|off --run-dir <dir>
    runner.py config  --suite wp|wc|wc-api|gb --suite-dir <upstream e2e dir> --run-dir <dir>
    runner.py check-state --base-url https://<site> --state <storage state json> [--state ...]
    runner.py summarize --report <playwright json> --out <results.json>
    runner.py compare --baseline <results.json> --ours <results.json>

prepare CHECKS the site and writes <run-dir>/env (mode 600) for Playwright. It never writes to the
site: Rollins' seed owns all setup (lead ruling on #759), and prepare verifies it. It STOPS (exit 3) when:
  - the URL is not https;
  - the site has no throwaway marker (php/pf-conformance-throwaway.php, shipped only by
    prepare-content.sh) or the marker names another host: the suites delete ALL content;
  - the host is on the deny list (PF_CONFORMANCE_DENY adds hosts);
  - the admin cannot log in through the wp-login.php form (deploy with TURNSTILE_LOGIN=off: an API
    POST carries no Turnstile token; the checkout and comment gates stay on with the test keys);
  - the page cache does not match --cache (one guest URL, fetched three times);
  - wc only: HTTP Basic with WP_PASSWORD is not 200, or a WRONG password is not 401 (the control:
    it proves Basic is checked, not ignored; see #761). The seed sets the admin account password to
    an application password, so ONE value passes the form and Basic: the WooCommerce suite uses
    ADMIN_PASSWORD for both, unmodified;
  - wc only: the seed's setup is missing: the customer (role, form login with CUSTOMER_PASSWORD),
    blogname, pretty permalinks (/wp-json/ must answer the REST index, #760) or the 3 test images.
    the active theme must be twentytwentythree (as upstream's external setup leaves it);
    woocommerce_allow_tracking must be "yes" (the WooCommerce settings API; WOO_EXTRAS=off forces it off).
    The customer is CUSTOMER_USERNAME (default "customer"); the images match by stem (image-01 is a JPEG).
The passwords come from WP_PASSWORD and CUSTOMER_PASSWORD and are never printed.

config writes pf-conformance.config.mjs beside the upstream config: one worker, no retries, no
webServer (the site is deployed), the exclusions of exclude/<suite>.txt, and a JSON
report. It unwraps a default export before the spread, so upstream timeout and use survive.
A file row in that list is testIgnore.
A title row is grepInvert.
One test is skipped.
Its siblings still run.
summarize and compare turn reports into the rows of the support matrix: compare marks a
test that fails on the stock baseline as "upstream", never as ours.
"""
import argparse, base64, collections, http.cookiejar, importlib.util, json, os, re, shlex, sys, urllib.error, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DENY = {"ggc.sh", "www.ggc.sh"}
REQUIRE_HTTPS = True  # runner_test.py turns it off for its local http stub; no flag or env reaches it.
CACHED = {"HIT", "EXPIRED", "STALE", "REVALIDATED", "UPDATING"}
# wc-api: the WooCommerce suite's api-tests (the API half), the same checkout and config as wc.
UPSTREAM_CONFIG = {"wp": "playwright.config.js", "wc": "playwright.config.ts", "wc-api": "playwright.config.ts", "wc-cpt": "playwright.config.ts", "gb": "playwright.config.ts"}
# wc-cpt (#759 gap 2, upstream envs/default-hpos-disabled) runs the wc suite with HPOS OFF, so it reads the wc exclusion
# list itself: one list, never a copy that could drift.
EXCLUDE_AS = {"wc-cpt": "wc"}
# The tags the upstream external envs drop (envs/default-pressable/playwright.config.ts).
WC_GREP_INVERT = "@skip-on-external-env|@skip-on-pressable|@could-be-lower-level-test|@non-critical|@to-be-removed"
TIMEOUT = 60


def rest_path(path):
    """/wp-json/<route>?<q> -> /?rest_route=/<route>&<q>. It works with PLAIN permalinks too: a fresh
    b2 install keeps them (#760), and there /wp-json/ answers the home page with 200."""
    if not path.startswith("/wp-json/"):
        return path
    route, _, q = path[len("/wp-json"):].partition("?")
    return "/?" + urllib.parse.urlencode({"rest_route": route}, safe="/") + ("&" + q if q else "")


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

    def req(self, method, path, data=None, headers=None, form=False, cookies=True, raw=None, ctype=None, keep_path=False):
        url = self.base + (path if keep_path else rest_path(path))
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
            raise Stop("the wp-login.php form did not log the admin in (HTTP %d). Deploy with TURNSTILE_LOGIN=off: this POST and the WooCommerce auth.setup.ts carry no Turnstile token, "
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


WC_BLOGNAME = "WooCommerce Core E2E Test Suite"
WC_TIMEZONE = "America/Detroit"
WC_THEME = "twentytwentythree"

def editor_welcome_verify(site):
    """#759 / #605: the seed must dismiss the welcome guide so Playwright can reach the canvas."""
    st, me = site.json("GET", "/wp-json/wp/v2/users/me?context=edit")
    prefs = me.get("meta", {}).get("persisted_preferences") if isinstance(me, dict) else None
    seed = os.path.join(HERE, "seed.py")
    spec = importlib.util.spec_from_file_location("pf_seed", seed)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if not mod.welcome_guide_dismissed(prefs):
        raise Stop("the block editor welcome guide is not dismissed (HTTP %d): rerun the seed" % st)
    say("block editor: welcome guide dismissed (persisted_preferences)")



def wc_verify(site, user, password):
    """CHECK the WooCommerce setup that Rollins' seed owns (lead ruling, #759). Read only: it never
    writes, so the setup has one owner. Upstream does it with WP-CLI (bin/test-env-setup-external.sh)."""
    good = site.basic(user, password)
    if good != 200:
        raise Stop("HTTP Basic with WP_PASSWORD returned %d, not 200. The seed must set the admin account "
                   "password to an application password (one value for the form and Basic); on b2 see #761" % good)
    bad = site.basic(user, password[:-1] + ("x" if password[-1] != "x" else "y"))
    if bad != 401:
        raise Stop("HTTP Basic with a WRONG password returned %d, not 401: Basic is not checked" % bad)
    say("basic auth: WP_PASSWORD 200, a wrong password 401 (it is also an application password)")
    cust = os.environ.get("CUSTOMER_PASSWORD")
    if not cust:
        raise Stop("CUSTOMER_PASSWORD is not set (the seed's customer password)")
    # The seed's creds.env names the customer (CUSTOMER_USERNAME); upstream's default is "customer".
    cuser = os.environ.get("CUSTOMER_USERNAME") or "customer"
    if not re.fullmatch(r"[A-Za-z0-9_.@-]{1,60}", cuser):
        raise Stop("CUSTOMER_USERNAME %r is not a plain user name" % cuser)
    st, users = site.json("GET", "/wp-json/wp/v2/users?search=%s&context=edit" % urllib.parse.quote(cuser))
    u = next((x for x in users or [] if isinstance(x, dict) and x.get("username") == cuser), None) if st == 200 else None
    if not u or "customer" not in (u.get("roles") or []):
        raise Stop("no user %r with the role customer (HTTP %d): the seed did not run" % (cuser, st))
    try:
        Site(site.base).login(cuser, cust)
    except Stop:
        raise Stop("the customer %r cannot log in through the form with CUSTOMER_PASSWORD" % cuser)
    st, j = site.json("GET", "/wp-json/wp/v2/settings")
    if st != 200 or not isinstance(j, dict) or j.get("title") != WC_BLOGNAME:
        raise Stop("blogname is %r, not %r" % ((j or {}).get("title") if isinstance(j, dict) else None, WC_BLOGNAME))
    # WP settings REST exposes timezone (measured on cf759a 2026-11-18). Older
    # WordPress used timezone_string. Accept either (#923 seed; prepare must match).
    got_tz = j.get("timezone") or j.get("timezone_string") or ""
    if got_tz != WC_TIMEZONE:
        raise Stop("timezone is %r, not %r" % (got_tz, WC_TIMEZONE))
    # Pretty permalinks, measured: the suites call /wp-json/ directly, so it must answer the REST index.
    st, h, b = site.req("GET", "/wp-json/", cookies=False, keep_path=True)
    try:
        ns = json.loads(b.decode()).get("namespaces")
    except (ValueError, AttributeError):
        ns = None
    if st != 200 or not ns:
        raise Stop("/wp-json/ does not answer the REST index (HTTP %d): pretty permalinks are not active (#760)" % st)
    # Matched by STEM: upstream image-01.png is a JPEG, and WordPress names a file by its content,
    # so it is stored as image-01.jpg, on stock WordPress too (Rollins, measured on the seed).
    for i in (1, 2, 3):
        name = "image-0%d" % i
        st, items = site.json("GET", "/wp-json/wp/v2/media?search=%s&per_page=100" % name)
        if st != 200 or not any(name in (m.get("source_url") or "") for m in items or [] if isinstance(m, dict)):
            raise Stop("no media %s.* (HTTP %d): the seed did not upload the test images" % (name, st))
    # Tracking: readable through the WooCommerce settings API at the pin (Rollins, measured).
    # WOO_EXTRAS=off forces it off, so a throwaway deployed with that setting stops here.
    st, j = site.json("GET", "/wp-json/wc/v3/settings/advanced/woocommerce_allow_tracking")
    val = j.get("value") if isinstance(j, dict) else None
    if st != 200 or val != "yes":
        raise Stop("woocommerce_allow_tracking is %r (HTTP %d), not 'yes'. The seed sets it; WOO_EXTRAS=off forces it off" % (val, st))
    # The theme: WooCommerce's external setup activates twentytwentythree (bin/test-env-setup-external.sh),
    # and its site.setup.ts never sets one. The wp and gb global setups switch to twentytwentyone, so the
    # reseed before a wc or wc-api pass must put twentytwentythree back.
    st, themes = site.json("GET", "/wp-json/wp/v2/themes?status=active")
    active = [t.get("stylesheet") for t in themes or [] if isinstance(t, dict)] if st == 200 else []
    if active != [WC_THEME]:
        raise Stop("the active theme is %r (HTTP %d), not %r: the seed sets it before a wc or wc-api pass" % (active, st, WC_THEME))
    say("woocommerce setup verified: customer (role and login), blogname, pretty permalinks, 3 images, tracking, theme")
    return cuser, cust


def conformance_artifact_paths(run_dir):
    """Absolute paths under <run-dir>/artifacts, not upstream cwd (conf759: leftover /root)."""
    run_abs = os.path.abspath(run_dir)
    artifacts = os.path.join(run_abs, "artifacts")
    storage = os.path.join(artifacts, "storage-states", "admin.json")
    return artifacts, storage


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
    if a.suite in ("wp", "gb"):
        editor_welcome_verify(site)
    cache = check_cache(site, a.cache)
    pairs = [("WP_BASE_URL", site.base), ("WP_USERNAME", user)]
    if a.suite in ("wc", "wc-api", "wc-cpt"):
        cuser, cust = wc_verify(site, user, password)
        pairs += [("WP_PASSWORD", password), ("BASE_URL", site.base), ("ADMIN_USER", user), ("ADMIN_PASSWORD", password),
                  ("CUSTOMER_USER", cuser), ("CUSTOMER_PASSWORD", cust)]
    else:
        pairs += [("WP_PASSWORD", password)]
    pairs += [("PF_CONFORMANCE_SUITE", a.suite), ("PF_CONFORMANCE_CACHE", a.cache),
              ("PF_CONFORMANCE_CACHE_SEEN", ",".join(cache))]
    if a.suite in ("wp", "gb"):
        artifacts, storage = conformance_artifact_paths(a.run_dir)
        os.makedirs(os.path.dirname(storage), exist_ok=True)
        pairs += [("WP_ARTIFACTS_PATH", artifacts), ("STORAGE_STATE_PATH", storage)]
    p = write_env(a.run_dir, pairs)
    say("wrote %s (mode 600; it holds the passwords, never print it)" % p)


def cmd_check_state(a):
    """STOP unless each saved Playwright storage state is a REAL login (lead ruling, #759). It sends only
    the cookies for this host to /wp-admin/ and never follows a redirect. A redirect to wp-login.php, or
    the login form, means the auth setup did not log in. A customer is sent to My Account, which counts
    as logged in. No cookie value is printed."""
    host = urllib.parse.urlparse(a.base_url).hostname
    for path in a.state:
        try:
            with open(path) as f:
                cookies = json.load(f).get("cookies") or []
        except (OSError, ValueError, AttributeError) as e:
            raise Stop("cannot read the storage state %s (%s): the auth setup did not save it" % (path, type(e).__name__))
        def for_host(c):
            d = (c.get("domain") or "").lstrip(".")
            return d == host or host.endswith("." + d)
        mine = [c for c in cookies if isinstance(c, dict) and c.get("name") and for_host(c)]
        if not any(str(c["name"]).startswith("wordpress_logged_in_") for c in mine):
            raise Stop("the storage state %s has no login cookie for %s: the auth setup did not log in"
                       % (os.path.basename(path), host))
        hdr = "; ".join("%s=%s" % (c["name"], c.get("value", "")) for c in mine)
        st, h, b = Site(a.base_url).req("GET", "/wp-admin/", headers={"Cookie": hdr}, cookies=False)
        loc = {k.lower(): v for k, v in h.items()}.get("location", "")
        if (st in (301, 302, 303, 307, 308) and "wp-login.php" in loc) or b'id="loginform"' in b:
            raise Stop("the storage state %s is not logged in: /wp-admin/ answers with the login page (HTTP %d). "
                       "Stopping before the tests, so an empty login never reads as test failures" % (os.path.basename(path), st))
        if st >= 400:
            raise Stop("the storage state %s: /wp-admin/ answered HTTP %d" % (os.path.basename(path), st))
        print("check-state: %s is logged in (/wp-admin/ HTTP %d)" % (os.path.basename(path), st), flush=True)


Exclude = collections.namedtuple("Exclude", "kind path title reason")
# A title row: <file> :: <title>, then two or more spaces, then the reason.
# The title may contain single spaces. Two spaces end it.
_TITLE_ROW = re.compile(r"^(\S+) :: (.+?)(?:  +|\t+)(\S.*?)\s*$")


def parse_exclude_line(line):
    if " :: " in line:
        m = _TITLE_ROW.match(line)
        if not m:
            raise Stop("a title row needs the file, :: , the title, then two spaces, then the reason")
        return Exclude("title", m.group(1), m.group(2).strip(), m.group(3).strip())
    path, _, why = line.partition(" ")
    return Exclude("file", path, "", why.strip())


def read_excludes(suite):
    out = []
    with open(os.path.join(HERE, "exclude", EXCLUDE_AS.get(suite, suite) + ".txt")) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                out.append(parse_exclude_line(line))
    return out


def title_grep_source(path, title):
    # Playwright joins the file path, each describe, and the test title with spaces.
    # A tag on a block sits between those parts.
    # The row uses " > ", as results.json does.
    # The match ends at the test title, or at a tag after it.
    parts = [p.strip() for p in title.split(" > ") if p.strip()]
    if not parts:
        raise Stop("a title row needs a title")
    gap = r"(?: @[^\s]+)* "
    return re.escape(path) + "".join(gap + re.escape(p) for p in parts) + r"(?: @|$)"


def grep_invert_source(titles):
    extra = [title_grep_source(path, title) for path, title in titles]
    if not extra:
        return WC_GREP_INVERT
    return WC_GREP_INVERT + "|" + "|".join(extra)


def config_text(suite, run_dir, suite_dir):
    rows = read_excludes(suite)
    ign = [r.path for r in rows if r.kind == "file"]
    titles = [(r.path, r.title) for r in rows if r.kind == "title"]
    grep_src = grep_invert_source(titles)
    rep = os.path.join(os.path.abspath(run_dir), "report.json")
    artifacts, storage = conformance_artifact_paths(run_dir)
    lines = ["// Written by tests/conformance/runner.py config (#759). Do not edit; re-run it."]
    if suite in ("wp", "gb"):
        lines += [
            "process.env.WP_ARTIFACTS_PATH = %s;" % json.dumps(artifacts),
            "process.env.STORAGE_STATE_PATH = %s;" % json.dumps(storage),
        ]
    lines.append("import base from './%s';" % UPSTREAM_CONFIG[suite])
    if suite in ("wc", "wc-api", "wc-cpt"):
        lines.append("import { coreSetupProjects } from './%s';" % UPSTREAM_CONFIG[suite])
    lines += ["const ignore = %s;" % json.dumps(ign),
              "// Playwright loads this file as { default: config }. Spread of base drops timeout and use.",
              "const upstream = base.default || base;",
              "const config = { ...upstream, workers: 1, retries: 0, fullyParallel: false, webServer: undefined,",
              "  reporter: [ [ 'list' ], [ 'json', { outputFile: %s } ] ] };" % json.dumps(rep)]
    if suite in ("wc", "wc-api", "wc-cpt"):
        # External throwaway (conf759 STOP 2026-11-17): upstream coreSetupProjects starts with
        # 'install wc' (WC Beta Tester). Its restApi fixture requires Playwright baseURL before
        # setup.skip(!INSTALL_WC) can run, so the project fails in milliseconds on a seeded site.
        # Drop 'install wc', clear that dependency, and force use.baseURL from the prepare env.
        lines += [
            "const url = (process.env.BASE_URL || process.env.WP_BASE_URL || '').replace(/\\/+$/, '') + '/';",
            "config.use = { ...(upstream.use || {}), baseURL: url };",
            "const setup = coreSetupProjects.filter((p) => p.name !== 'install wc')"
            ".map((p) => p.name === 'global authentication' ? { ...p, dependencies: [] } : p);",
            "config.testIgnore = undefined;",
        ]
    if suite == "wc":
        # As upstream envs/default-pressable, but WITHOUT its 'reset' project: woocommerce-cleanup
        # TRUNCATEs the store, which would wipe the seed (Rollins' seed owns setup AND the reset between
        # runs). vps-run.sh runs 'site setup' first, then check-state, then e2e-pf with --no-deps.
        lines += ["config.projects = [ ...setup,",
                  "  { name: 'e2e-pf', testIgnore: ignore, grepInvert: new RegExp( %s ), dependencies: [ 'site setup' ] } ];" % json.dumps(grep_src)]
    elif suite == "wc-cpt":
        # As upstream envs/default-hpos-disabled: DISABLE_HPOS=1, read by fixtures/site.setup.ts, turns HPOS OFF in the
        # 'site setup' project; then only the @hpos-tagged tests (upstream's e2e-hpos-disabled project), with the same
        # tag filter and exclusions as wc. No reset project (the seed owns setup and reset). Its API half is the wc-api
        # side's to add.
        lines += ["process.env.DISABLE_HPOS = '1';",
                  "config.projects = [ ...setup,",
                  "  { name: 'e2e-cpt', grep: new RegExp( %s ), testIgnore: ignore, grepInvert: new RegExp( %s ), dependencies: [ 'site setup' ] } ];" % (json.dumps("@hpos"), json.dumps(grep_src))]
    elif suite == "wc-api":
        # The API half: the same setup projects and the same tag filter, and only the api-tests (which the wc
        # config ignores). No reset project either: the seed owns setup and the reseed between the halves.
        lines += ["config.projects = [ ...setup,",
                  "  { name: 'api-pf', testMatch: [ '**/api-tests/**' ], testIgnore: ignore, grepInvert: new RegExp( %s ), dependencies: [ 'site setup' ] } ];" % json.dumps(grep_src)]
    else:
        pf_setup = os.path.join(HERE, "pf-global-setup.mjs")
        assert_login = os.path.join(HERE, "assert-login.mjs")
        upstream_name = "global-setup.js" if suite == "wp" else "global-setup.ts"
        upstream_abs = os.path.join(os.path.abspath(suite_dir), "config", upstream_name)
        # Upstream global-setup.js reads projects[0].use, not config.use (#759). Force baseURL on every project.
        # A title row on wp or gb is grepInvert. With no title row, the project line stays the file ignore only.
        if titles:
            title_src = "|".join(title_grep_source(p, t) for p, t in titles)
            lines.append("config.grepInvert = new RegExp( %s );" % json.dumps(title_src))
            map_line = "if ( config.projects ) config.projects = config.projects.map( ( p ) => ( { ...p, testIgnore: ignore, grepInvert: new RegExp( %s ), use: { ...p.use, baseURL: url, storageState: state } } ) );" % json.dumps(title_src)
        else:
            map_line = "if ( config.projects ) config.projects = config.projects.map( ( p ) => ( { ...p, testIgnore: ignore, use: { ...p.use, baseURL: url, storageState: state } } ) );"
        lines += [
            "const url = (process.env.BASE_URL || process.env.WP_BASE_URL || '').replace(/\\/+$/, '') + '/';",
            "const state = process.env.STORAGE_STATE_PATH;",
            "config.use = { ...(config.use || {}), baseURL: url, storageState: state };",
            "process.env.PF_CONFORMANCE_UPSTREAM_GLOBAL_SETUP = %s;" % json.dumps(upstream_abs),
            "config.globalSetup = [ %s, %s ];" % (json.dumps(pf_setup), json.dumps(assert_login)),
            "config.testIgnore = ignore;",
            map_line,
        ]
    lines.append("export default config;")
    return "\n".join(lines) + "\n"


def cmd_config(a):
    up = os.path.join(a.suite_dir, UPSTREAM_CONFIG[a.suite])
    if not os.path.isfile(up):
        raise Stop("no upstream config %s" % up)
    p = os.path.join(a.suite_dir, "pf-conformance.config.mjs")
    with open(p, "w") as f:
        f.write(config_text(a.suite, a.run_dir, a.suite_dir))
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
    """A STOP is never a result: a report whose global setup failed (top-level errors, such as the login
    assert in assert-login.mjs) or that ran no test at all is refused with exit 3, so the run stops."""
    with open(a.report) as f:
        rep = json.load(f)
    errors = rep.get("errors") or []
    if errors:
        first = errors[0].get("message", "") if isinstance(errors[0], dict) else str(errors[0])
        raise Stop("the report has %d top-level error(s), so the run did not reach its tests: %s" % (len(errors), first.splitlines()[0][:200] if first else "?"))
    rows = [r for s in rep.get("suites", []) for r in walk(s, (s.get("title") or "",))]
    if not rows:
        raise Stop("the report holds no test: the run did not reach its tests")
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
    p.add_argument("--suite", choices=("wp", "wc", "wc-api", "wc-cpt", "gb"), required=True)
    p.add_argument("--base-url", required=True)
    p.add_argument("--cache", choices=("on", "off"), required=True)
    p.add_argument("--run-dir", required=True)
    p = sub.add_parser("config")
    p.add_argument("--suite", choices=("wp", "wc", "wc-api", "wc-cpt", "gb"), required=True)
    p.add_argument("--suite-dir", required=True)
    p.add_argument("--run-dir", required=True)
    p = sub.add_parser("check-state")
    p.add_argument("--base-url", required=True)
    p.add_argument("--state", action="append", required=True)
    p = sub.add_parser("summarize")
    p.add_argument("--report", required=True)
    p.add_argument("--out", required=True)
    p = sub.add_parser("compare")
    p.add_argument("--baseline", required=True)
    p.add_argument("--ours", required=True)
    a = ap.parse_args(argv)
    try:
        return {"prepare": cmd_prepare, "config": cmd_config, "check-state": cmd_check_state, "summarize": cmd_summarize, "compare": cmd_compare}[a.cmd](a) or 0
    except Stop as e:
        print("STOP: %s" % e, file=sys.stderr, flush=True)
        return 3


if __name__ == "__main__":
    sys.exit(main())
