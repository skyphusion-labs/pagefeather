#!/usr/bin/env python3
"""The conformance runner of #759: the upstream browser suites against a THROWAWAY site.

    runner.py prepare --suite wp|wc|wc-api|gb --base-url https://<site> --cache on|off|on-unverified [--arm a] --run-dir <dir>
    runner.py config  --suite wp|wc|wc-api|gb --suite-dir <upstream e2e dir> --run-dir <dir> [--stock]
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
  - --cache on-unverified without --arm a. on-unverified (#1277 round 2, the lead's ruling) is declared for arm (a)
    only: it runs the same check as on and logs it LOUDLY as UNVERIFIED, but does not stop when no stored body was
    served. "Could not measure" (no stamp at all) is still a stop. The run's env records the mode and the arm;
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
    # #1336: cf-cache-status cannot say whether a stored body was served. On approach A an EXPIRED answer was a fresh
    # render each time, while on b-dosql it was the stored body (Rollins, #1334). x-pf-rendered can: Pages stamps the
    # render time, and a cached copy keeps the stamp (page-stamp.mjs). So "served from cache" means a later guest GET
    # carries an earlier GET's stamp. The status is logged as data only.
    seen, stamps = [], []
    for _ in range(3):
        st, h, _ = site.req("GET", "/", cookies=False)
        hl = {k.lower(): v for k, v in h.items()}
        seen.append(hl.get("cf-cache-status", "-").upper())
        stamps.append(hl.get("x-pf-rendered", "-"))
    served = any(stamps[i] != "-" and stamps[i] in stamps[:i] for i in range(1, len(stamps)))
    say("page cache: guest GET / x3 -> cf-cache-status %s; x-pf-rendered %s; a stored body served: %s"
        % (",".join(seen), ",".join(stamps), "yes" if served else "no"))
    if want in ("on", "on-unverified"):
        if all(x == "-" for x in stamps):
            raise Stop("--cache %s: could not measure, no x-pf-rendered on any of 3 guest fetches of / (%s); the "
                       "stamp is how a served body is told from a render (#1336)" % (want, ",".join(seen)))
        if not served and want == "on-unverified":
            say("UNVERIFIED: --cache on-unverified (#1277 round 2, arm (a) only): no stored body was served in 3 guest "
                "fetches of / (x-pf-rendered %s; cf-cache-status %s). The run goes on; it is NOT a verified cache-on run."
                % (",".join(stamps), ",".join(seen)))
            print("UNVERIFIED cache-on: no stored body served (x-pf-rendered %s)" % ",".join(stamps), file=sys.stderr)
        elif not served:
            raise Stop("--cache on, but no stored body was served in 3 guest fetches of /: every x-pf-rendered differs "
                       "(%s; cf-cache-status %s) (#1336)" % (",".join(stamps), ",".join(seen)))
    if want == "off" and (served or "HIT" in seen):
        raise Stop("--cache off, but the page cache answered (%s; x-pf-rendered %s): deploy with PAGE_CACHE_TTL=0"
                   % (",".join(seen), ",".join(stamps)))
    return seen, served


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
    # The site's admin email (the admin_email option; WP settings REST names it "email"). WooCommerce's admin
    # emails (New order, Cancelled order) go there, and its test data reads ADMIN_USER_EMAIL, falling back to
    # admin@woocommercecoree2etestsuite.com. Our seed sets another address, so without this the "admin receives"
    # specs wait for a mail to the wrong recipient (wcb3, 2026-11-21: New order #1394 went to the site's address).
    admin_email = j.get("email") if isinstance(j.get("email"), str) else ""
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", admin_email):
        raise Stop("the site admin email (wp/v2/settings email) is %r: the admin-email specs need it" % (admin_email or None))
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
    say("woocommerce setup verified: customer (role and login), blogname, admin email, pretty permalinks, 3 images, tracking, theme")
    return cuser, cust, admin_email


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
    if a.cache == "on-unverified" and getattr(a, "arm", None) != "a":
        raise Stop("--cache on-unverified is declared for #1277 round 2 arm (a) only (the lead's ruling); this run says "
                   "--arm %s. Use --cache on, which stops when no stored body is served" % (getattr(a, "arm", None) or "(none)"))
    site = Site(a.base_url)
    check_target(site, a)
    site.login(user, password)
    say("admin: form login and REST nonce ok")
    if a.suite in ("wp", "gb"):
        editor_welcome_verify(site)
    cache, served = check_cache(site, a.cache)
    pairs = [("WP_BASE_URL", site.base), ("WP_USERNAME", user)]
    if a.suite in ("wc", "wc-api", "wc-cpt"):
        cuser, cust, admin_email = wc_verify(site, user, password)
        pairs += [("WP_PASSWORD", password), ("BASE_URL", site.base), ("ADMIN_USER", user), ("ADMIN_PASSWORD", password),
                  ("ADMIN_USER_EMAIL", admin_email), ("CUSTOMER_USER", cuser), ("CUSTOMER_PASSWORD", cust)]
    else:
        pairs += [("WP_PASSWORD", password)]
    if getattr(a, "arm", None):
        pairs += [("PF_CONFORMANCE_ARM", a.arm)]
    pairs += [("PF_CONFORMANCE_SUITE", a.suite), ("PF_CONFORMANCE_CACHE", a.cache),
              ("PF_CONFORMANCE_CACHE_SEEN", ",".join(cache)),
              ("PF_CONFORMANCE_CACHE_SERVED", "yes" if served else "no")]
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


Exclude = collections.namedtuple("Exclude", "kind path title reason tier", defaults=(None,))
# The tiers a row can be scoped to (matrix.py TIERS). "[Hyperdrive] <path>  <reason>" skips the spec on that tier only:
# a limit of one tier must not hide the test on the others (#1119: the wc-api product-list batch).
TIERS = ("Free DO", "Paid DO", "WfP", "Hyperdrive")
_TIER_ROW = re.compile(r"^\[([^\]]+)\]\s+(.*)$")
# A title row: <file> :: <title>, then two or more spaces, then the reason.
# The title may contain single spaces. Two spaces end it.
_TITLE_ROW = re.compile(r"^(\S+) :: (.+?)(?:  +|\t+)(\S.*?)\s*$")


def parse_exclude_line(line):
    tier = None
    m = _TIER_ROW.match(line)
    if m:
        tier, line = m.group(1), m.group(2)
        if tier not in TIERS:
            raise Stop("an exclude row's tier %r is not one of %s" % (tier, ", ".join(TIERS)))
    row = _parse_exclude_body(line)
    return row._replace(tier=tier)


def _parse_exclude_body(line):
    if " :: " in line:
        m = _TITLE_ROW.match(line)
        if not m:
            raise Stop("a title row needs the file, :: , the title, then two spaces, then the reason")
        return Exclude("title", m.group(1), m.group(2).strip(), m.group(3).strip())
    path, _, why = line.partition(" ")
    return Exclude("file", path, "", why.strip())


def read_excludes(suite, tier=None):
    """The exclude rows that apply to a run on `tier`: every untiered row, and the rows scoped to that tier. With no
    tier, only the untiered rows (a tier-scoped skip never applies to a run that does not name its tier)."""
    out = []
    with open(os.path.join(HERE, "exclude", EXCLUDE_AS.get(suite, suite) + ".txt")) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                row = parse_exclude_line(line)
                if row.tier is None or row.tier == tier:
                    out.append(row)
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
    split = "".join(gap + re.escape(p) for p in parts)
    # A test title can itself hold " > " (page-loads.spec.ts: "can load Marketing > Overview page"), so the row also
    # matches the whole title as one part.
    whole = gap + re.escape(title.strip())
    body = split if whole == split else "(?:%s|%s)" % (split, whole)
    # Playwright greps the file path relative to the project testDir. gb rows name the file from test/e2e
    # ("specs/..."), and gb's testDir is specs/, so the prefix is optional: without this, no gb title row ever matched
    # (measured 2026-11-22 with playwright --list; the #992, #1171 and #1198 rows ran as if not there).
    head = "(?:specs/)?" + re.escape(path[len("specs/"):]) if path.startswith("specs/") else re.escape(path)
    return head + body + r"(?: @|$)"


def grep_invert_source(titles):
    extra = [title_grep_source(path, title) for path, title in titles]
    if not extra:
        return WC_GREP_INVERT
    return WC_GREP_INVERT + "|" + "|".join(extra)


def pf_workers():
    """1 locally. On Cloudflare Browser Run (PF_BROWSER=browser-run): PF_WORKERS, default 1. The wp and gb specs share one
    site's state (requestUtils.deleteAllPosts in beforeEach, fixed post titles), so more workers on ONE site interfere
    (measured on cf759p, 2026-11-20: 4 workers gave 15 of 18 against 18 of 18 with 1). Parallel runs mean different
    suites on different sites, not more workers on one."""
    if os.environ.get("PF_BROWSER") != "browser-run":
        return 1
    n = os.environ.get("PF_WORKERS", "1")
    if not re.fullmatch(r"[1-9][0-9]?", n):
        raise Stop("PF_WORKERS must be 1 to 99, got %r" % n)
    return int(n)


def config_text(suite, run_dir, suite_dir, stock=False, tier=None):
    rows = read_excludes(suite, tier)
    ign = [r.path for r in rows if r.kind == "file"]
    titles = [(r.path, r.title) for r in rows if r.kind == "title"]
    grep_src = grep_invert_source(titles)
    rep = os.path.join(os.path.abspath(run_dir), "report.json")
    artifacts, storage = conformance_artifact_paths(run_dir)
    is_wc = suite in ("wc", "wc-api", "wc-cpt")
    if stock and suite == "wc-cpt":
        raise Stop("--stock is not built for wc-cpt: its stock arm needs upstream's HPOS-off env (#1160)")
    lines = ["// Written by tests/conformance/runner.py config (#759). Do not edit; re-run it."]
    if suite in ("wp", "gb"):
        # The artifacts (traces, results) go under the run dir either way. A stock baseline (--stock) leaves the login
        # state to upstream: no STORAGE_STATE_PATH here (#1112).
        lines.append("process.env.WP_ARTIFACTS_PATH = %s;" % json.dumps(artifacts))
        if not stock:
            lines.append("process.env.STORAGE_STATE_PATH = %s;" % json.dumps(storage))
    lines.append("import base from './%s';" % UPSTREAM_CONFIG[suite])
    if is_wc and not stock:
        lines.append("import { coreSetupProjects } from './%s';" % UPSTREAM_CONFIG[suite])
    lines += ["const ignore = %s;" % json.dumps(ign),
              "// Playwright loads this file as { default: config }. Spread of base drops timeout and use.",
              "const upstream = base.default || base;",
              "const config = { ...upstream, workers: %d, retries: 0, fullyParallel: false, webServer: undefined," % pf_workers(),
              "  reporter: [ [ 'list' ], [ 'json', { outputFile: %s } ] ] };" % json.dumps(rep),
              # Our rows are ADDED to upstream's testIgnore and grepInvert, never put in their place (#1160): upstream
              # projects partition the specs with their own (wc core-parallel keeps serial, api, paypal and blocks out;
              # gb chromium skips -chromium titles).
              "const asList = ( x ) => ( x === undefined || x === null ? [] : [].concat( x ) );",
              "const withIgnore = ( x ) => [ ...asList( x ), ...ignore ];",
              "const withInvert = ( g, ours ) => new RegExp( [ ...asList( g ).map( ( r ) => r.source ), ours ].map( ( x ) => '(?:' + x + ')' ).join( '|' ) );"]
    if is_wc and not stock:
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
    if suite == "wc" and not stock:
        # As upstream envs/default-pressable, but WITHOUT its 'reset' project: woocommerce-cleanup
        # TRUNCATEs the store, which would wipe the seed (Rollins' seed owns setup AND the reset between
        # runs). vps-run.sh runs 'site setup' first, then check-state, then e2e-pf with --no-deps.
        lines += ["config.projects = [ ...setup,",
                  "  { name: 'e2e-pf', testIgnore: ignore, grepInvert: new RegExp( %s ), dependencies: [ 'site setup' ] } ];" % json.dumps(grep_src)]
    elif suite == "wc-cpt" and not stock:
        # As upstream envs/default-hpos-disabled: DISABLE_HPOS=1, read by fixtures/site.setup.ts, turns HPOS OFF in the
        # 'site setup' project; then only the @hpos-tagged tests (upstream's e2e-hpos-disabled project), with the same
        # tag filter and exclusions as wc. No reset project (the seed owns setup and reset). Its API half is the wc-api
        # side's to add.
        lines += ["process.env.DISABLE_HPOS = '1';",
                  "config.projects = [ ...setup,",
                  "  { name: 'e2e-cpt', grep: new RegExp( %s ), testIgnore: ignore, grepInvert: new RegExp( %s ), dependencies: [ 'site setup' ] } ];" % (json.dumps("@hpos"), json.dumps(grep_src))]
    elif suite == "wc-api" and not stock:
        # The API half: the same setup projects and the same tag filter, and only the api-tests (which the wc
        # config ignores). No reset project either: the seed owns setup and the reseed between the halves.
        lines += ["config.projects = [ ...setup,",
                  "  { name: 'api-pf', testMatch: [ '**/api-tests/**' ], testIgnore: ignore, grepInvert: new RegExp( %s ), dependencies: [ 'site setup' ] } ];" % json.dumps(grep_src)]
    elif stock:
        # #1112: the stock baseline is upstream's own config plus only our exclusions, one worker, no retries and the
        # JSON report: upstream's baseURL (its default, wp-env at localhost:8889), storageState and globalSetup are left
        # alone. Forcing them gave baseURL "/" and Invalid URL in global setup, because the baseline unsets the names.
        # wc (#1160): upstream's own projects too (install wc skips itself without INSTALL_WC; site setup; core-serial,
        # core-parallel and the rest), with USE_WP_ENV as upstream envs/default sets it. envs/default has no reset
        # project: a fresh wp-env has nothing to reset. The wc tag filter is kept, so the same tests run as in ours.
        if is_wc:
            lines.append("process.env.USE_WP_ENV = 'true';")
            ours_inv = grep_src
        else:
            ours_inv = "|".join(title_grep_source(p, t) for p, t in titles) if titles else ""
        lines.append("config.testIgnore = withIgnore( upstream.testIgnore );")
        if ours_inv:
            lines.append("const oursInvert = %s;" % json.dumps(ours_inv))
            lines.append("config.grepInvert = withInvert( upstream.grepInvert, oursInvert );")
            lines.append("if ( config.projects ) config.projects = config.projects.map( ( p ) => ( { ...p, testIgnore: withIgnore( p.testIgnore ), grepInvert: withInvert( p.grepInvert, oursInvert ) } ) );")
        else:
            lines.append("if ( config.projects ) config.projects = config.projects.map( ( p ) => ( { ...p, testIgnore: withIgnore( p.testIgnore ) } ) );")
    else:
        pf_setup = os.path.join(HERE, "pf-global-setup.mjs")
        assert_login = os.path.join(HERE, "assert-login.mjs")
        upstream_name = "global-setup.js" if suite == "wp" else "global-setup.ts"
        upstream_abs = os.path.join(os.path.abspath(suite_dir), "config", upstream_name)
        # Upstream global-setup.js reads projects[0].use, not config.use (#759). Force baseURL on every project.
        # A title row on wp or gb is grepInvert. With no title row, the project line stays the file ignore only.
        if titles:
            title_src = "|".join(title_grep_source(p, t) for p, t in titles)
            lines.append("const oursInvert = %s;" % json.dumps(title_src))
            lines.append("config.grepInvert = withInvert( upstream.grepInvert, oursInvert );")
            map_line = "if ( config.projects ) config.projects = config.projects.map( ( p ) => ( { ...p, testIgnore: withIgnore( p.testIgnore ), grepInvert: withInvert( p.grepInvert, oursInvert ), use: { ...p.use, baseURL: url, storageState: state } } ) );"
        else:
            map_line = "if ( config.projects ) config.projects = config.projects.map( ( p ) => ( { ...p, testIgnore: withIgnore( p.testIgnore ), use: { ...p.use, baseURL: url, storageState: state } } ) );"
        lines += [
            "const url = (process.env.BASE_URL || process.env.WP_BASE_URL || '').replace(/\\/+$/, '') + '/';",
            "const state = process.env.STORAGE_STATE_PATH;",
            "config.use = { ...(config.use || {}), baseURL: url, storageState: state };",
            "process.env.PF_CONFORMANCE_UPSTREAM_GLOBAL_SETUP = %s;" % json.dumps(upstream_abs),
            "config.globalSetup = [ %s, %s ];" % (json.dumps(pf_setup), json.dumps(assert_login)),
            "config.testIgnore = withIgnore( upstream.testIgnore );",
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
        f.write(config_text(a.suite, a.run_dir, a.suite_dir, stock=getattr(a, "stock", False), tier=getattr(a, "tier", None)))
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


CORE_ONLY_WP_ENV = ".wp-env.test-without-gutenberg-plugin.json"


def wp_env_without_gutenberg_plugin(cfg):
    """Gutenberg's .wp-env.test.json with the Gutenberg PLUGIN not mounted, so the stock arm is core alone, as our sites
    are (none ships the plugin). Upstream mounts it twice: "plugins": ["."] and the mapping wp-content/plugins/gutenberg
    -> ".". Both go; every other key and mapping (mu-plugins, test plugins, test themes, core, port) stays. Refused when
    either is missing, or when "." is still mounted anywhere after: then upstream's shape changed, and a quiet copy could
    keep the plugin."""
    if not isinstance(cfg, dict):
        raise Stop("the wp-env config is not an object")
    plugins = cfg.get("plugins")
    maps = cfg.get("mappings")
    if not isinstance(plugins, list) or "." not in plugins:
        raise Stop('the wp-env config has no "plugins": ["."]; upstream changed how it mounts Gutenberg')
    if not isinstance(maps, dict) or maps.get("wp-content/plugins/gutenberg") != ".":
        raise Stop('the wp-env config has no mapping wp-content/plugins/gutenberg -> "."; upstream changed')
    out = dict(cfg)
    out["plugins"] = [x for x in plugins if x != "."]
    out["mappings"] = {k: v for k, v in maps.items() if k != "wp-content/plugins/gutenberg"}
    left = [k for k, v in out["mappings"].items() if v == "."] + (["plugins"] if "." in out["plugins"] else [])
    if left or any(str(k).endswith("/plugins/gutenberg") for k in out["mappings"]):
        raise Stop("the Gutenberg checkout is still mounted after the edit: %s" % left)
    return out


def cmd_wp_env_without_gutenberg_plugin(a):
    src = os.path.join(a.suite_dir, ".wp-env.test.json")
    if not os.path.isfile(src):
        raise Stop("no %s" % src)
    cfg = wp_env_without_gutenberg_plugin(json.load(open(src)))
    p = os.path.join(a.suite_dir, CORE_ONLY_WP_ENV)
    with open(p, "w") as f:
        json.dump(cfg, f, indent="\t")
        f.write("\n")
    print(p)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("--suite", choices=("wp", "wc", "wc-api", "wc-cpt", "gb"), required=True)
    p.add_argument("--base-url", required=True)
    p.add_argument("--cache", choices=("on", "off", "on-unverified"), required=True)
    p.add_argument("--arm", help="the experiment arm this run belongs to (#1277 round 2); --cache on-unverified needs --arm a")
    p.add_argument("--run-dir", required=True)
    p = sub.add_parser("config")
    p.add_argument("--suite", choices=("wp", "wc", "wc-api", "wc-cpt", "gb"), required=True)
    p.add_argument("--suite-dir", required=True)
    p.add_argument("--run-dir", required=True)
    p.add_argument("--stock", action="store_true", help="a stock baseline: upstream's own config (baseURL, storageState, globalSetup; for wc its projects too) plus our exclusions (wp, gb, wc, wc-api)")
    p.add_argument("--tier", choices=TIERS, help="the tier this run is on: applies its tier-scoped exclude rows")
    p = sub.add_parser("wp-env-without-gutenberg-plugin", help="write the gb wp-env config with the Gutenberg plugin not mounted (the core-only stock arm)")
    p.add_argument("--suite-dir", required=True, help="the Gutenberg checkout (it holds .wp-env.test.json)")
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
        return {"prepare": cmd_prepare, "config": cmd_config, "check-state": cmd_check_state, "summarize": cmd_summarize, "compare": cmd_compare,
                "wp-env-without-gutenberg-plugin": cmd_wp_env_without_gutenberg_plugin}[a.cmd](a) or 0
    except Stop as e:
        print("STOP: %s" % e, file=sys.stderr, flush=True)
        return 3


if __name__ == "__main__":
    sys.exit(main())
