#!/usr/bin/env python3
"""The live checks of deploy/wfp (issue #35, slice 2). up.sh runs it.

Environment: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, SUB (the account's
workers.dev subdomain), NAMESPACE, KV_ID, SITES_FILE (one JSON line per site:
site, admin_password, spike_token; a file of the run, 0600). Phase B (#138):
WFP_CUSTOM_DOMAIN=1 and WFP_SUBDOMAIN (default wfp-test.skyphusion.org) make a
site's own URL its Custom Domain instead of workers.dev; the probe and the
cache probe stay on workers.dev, which is where they are deployed.

1. one script: every dispatcher copy (wp-<site> in phase A, or the one
   wp-dispatch in phase B, plus wp-probe) has the same script hash (condition a)
2. own content: each site answers 200 from its user Worker; its title is set
   to "WfP site <name>" through REST (login, nonce), and then each site's
   front page shows its own title and not the other's (two databases)
3. the stale entry: wp-probe answers 404 with x-wfp-error not-deployed (condition b)
4. the Workers Cache in a namespace script (docs/wfp.md open (b)): one
   logged-out b-dosql page read twice, recorded; and (CACHE_PROBE=1) a tiny
   cached Worker in the namespace against the same Worker as a normal Worker
   (the control): two reads with the same "made" were cached. The verdict is
   yes, no, or inconclusive when the control was not cached

Prints one JSON object (no secret in it), writes it to
deploy/wfp/results/day1-<time>.json, and exits 1 if check 1, 2 or 3 fails.
Check 4 is a measurement, not a pass or fail.
"""
import http.cookiejar, json, os, random, re, sys, time, urllib.error, urllib.parse, urllib.request

ACC, SUB = os.environ.get("CLOUDFLARE_ACCOUNT_ID", ""), os.environ.get("SUB", "")
TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")
# Phase B (#138): a site's own URL is its Custom Domain; the probe and the
# cache probe (checks 3 and 4b) stay on workers.dev regardless.
PHASE_B = os.environ.get("WFP_CUSTOM_DOMAIN", "0") == "1"
WFP_SUBDOMAIN = os.environ.get("WFP_SUBDOMAIN", "wfp-test.skyphusion.org")
UA = "wp-on-cf-wfp-check"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def req(url, method="GET", data=None, headers=None, jar=None, redirect=False):
    h = {"User-Agent": UA, **(headers or {})}
    hs = [urllib.request.HTTPCookieProcessor(jar)] if jar is not None else []
    if not redirect:
        hs.append(NoRedirect)
    o = urllib.request.build_opener(*hs)
    try:
        r = o.open(urllib.request.Request(url, data=data, headers=h, method=method), timeout=120)
        return r.status, r.headers, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError) as e:
        # TLS not ready or the edge not reachable yet: a 000-style result that
        # front_get treats as "keep waiting" on a first phase B deploy.
        return 0, {}, str(e)


def api(path):
    st, h, b = req("https://api.cloudflare.com/client/v4/accounts/%s%s" % (ACC, path), headers={"Authorization": "Bearer " + TOKEN})
    return st, json.loads(b) if b.startswith("{") else {}


def origin(s):
    # Phase B: the site answers on its Custom Domain; phase A: its workers.dev
    # dispatcher. The site map key is this same hostname in both phases.
    return "https://%s.%s" % (s, WFP_SUBDOMAIN) if PHASE_B else "https://wp-%s.%s.workers.dev" % (s, SUB)


def site_wait_cap():
    # Mirrors lib.sh site_wait_cap: a phase B first deploy must cover the
    # Custom Domain / Advanced Certificate propagation window; phase A is short.
    v = os.environ.get("SITE_WAIT")
    if v:
        return int(v)
    return 1800 if PHASE_B else 300


def front_get(o):
    # A site's front page, tolerant of the first phase B deploy's Custom Domain
    # propagation window: a just-created mapping can propagate unevenly across
    # edge PoPs, so a read transiently 404s with x-wfp-error not-deployed or
    # no-site, or TLS is briefly not ready (status 0). Retry to the cap; a
    # persistent failure after the cap is returned and judged as a real one.
    # Phase A returns the first read (cap does not apply).
    t0 = time.time()
    while True:
        st, h, b = req(o + "/?nocache=%d" % random.randrange(10 ** 9))
        transient = st == 0 or (st == 404 and h.get("x-wfp-error") in ("not-deployed", "no-site"))
        if not PHASE_B or not transient:
            return st, h, b
        if time.time() - t0 >= site_wait_cap():
            return st, h, b
        time.sleep(int(os.environ.get("SITE_WAIT_STEP", "10")))


def title(body):
    m = re.search(r"<title>([^<]*)</title>", body)
    return m.group(1) if m else None


def main():
    sites = [json.loads(l) for l in open(os.environ["SITES_FILE"]) if l.strip()]
    out = {"utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "namespace": os.environ["NAMESPACE"], "sites": [s["site"] for s in sites]}
    bad = []

    # 1. One script for every dispatcher copy. Phase A deploys a per-site
    # dispatcher wp-<site>; phase B deploys one wp-dispatch for every site.
    st, d = api("/workers/scripts")
    probe_on = os.environ.get("CACHE_PROBE", "1") == "1"
    disp = ["wp-dispatch"] if PHASE_B else ["wp-" + s["site"] for s in sites]
    names = disp + ["wp-probe"] + (["wp-cacheprobe"] if probe_on else [])
    etags = {x["id"]: x.get("etag") for x in d.get("result", []) if x["id"] in names}
    out["dispatcher_etags"] = etags
    if len(etags) != len(set(names)) or len(set(etags.values())) != 1 or None in etags.values():
        bad.append("1 the dispatcher copies do not share one script hash: %s" % etags)

    # 2. Each site: its user Worker answers; its own title, then each shows its own.
    for s in sites:
        o, jar = origin(s["site"]), http.cookiejar.CookieJar()
        st, h, b = front_get(o)
        rec = {"front_status": st, "x_wfp_error": h.get("x-wfp-error")}
        req(o + "/wp-login.php", jar=jar)
        form = urllib.parse.urlencode({"log": "admin", "pwd": s["admin_password"], "testcookie": "1", "wp-submit": "Log In", "redirect_to": o + "/wp-admin/"}).encode()
        st, h, b = req(o + "/wp-login.php", "POST", form, {"content-type": "application/x-www-form-urlencoded"}, jar)
        rec["login_status"] = st
        st, h, b = req(o + "/wp-admin/", jar=jar, redirect=True)
        m = re.search(r'"nonce":"([0-9a-f]{10})"', b)
        want = "WfP site " + s["site"]
        if m:
            st, h, b = req(o + "/?rest_route=/wp/v2/settings", "POST", json.dumps({"title": want}).encode(),
                           {"content-type": "application/json", "X-WP-Nonce": m.group(1)}, jar)
            rec["set_title_status"] = st
        else:
            rec["set_title_status"] = "no nonce (dashboard %s)" % st
        out.setdefault("site_checks", {})[s["site"]] = rec
    for s in sites:
        st, h, b = front_get(origin(s["site"]))
        t = title(b) or ""
        rec = out["site_checks"][s["site"]]
        rec["title_after"] = t
        others = [x["site"] for x in sites if x is not s]
        ok = st == 200 and ("WfP site " + s["site"]) in t and not any(("WfP site " + x) in t for x in others)
        rec["own_content"] = ok
        if not ok:
            bad.append("2 site %s: front %s, title %r" % (s["site"], st, t))

    # 3. The stale entry (always on workers.dev).
    st, h, b = req("https://wp-probe.%s.workers.dev/" % SUB)
    out["probe"] = {"status": st, "x_wfp_error": h.get("x-wfp-error")}
    if st != 404 or h.get("x-wfp-error") != "not-deployed":
        bad.append("3 the probe answered %s %s, not 404 not-deployed" % (st, h.get("x-wfp-error")))

    # 4. The Workers Cache: one logged-out page twice (a fresh key, so the first is a miss).
    u = origin(sites[0]["site"]) + "/?wfpcache=%d" % random.randrange(10 ** 9)
    reads = []
    for i in range(2):
        st, h, b = req(u)
        reads.append({"status": st, "cf-cache-status": h.get("cf-cache-status"), "cache-control": h.get("cache-control"), "age": h.get("age")})
        time.sleep(2)
    out["workers_cache"] = {"url_path": urllib.parse.urlsplit(u).path + "?wfpcache=<n>", "reads": reads}

    # 4b. The probe: the same cached Worker in the namespace and as a normal Worker
    # (always on workers.dev). Two reads of one fresh URL with the same "made"
    # came from the cache.
    def probe_reads(base):
        u = base + "/?p=%d" % random.randrange(10 ** 9)
        rs = []
        for i in range(2):
            st, h, b = req(u)
            try:
                made = json.loads(b).get("made")
            except ValueError:
                made = None
            rs.append({"status": st, "made": made, "cf-cache-status": h.get("cf-cache-status"), "age": h.get("age")})
            time.sleep(3)
        return {"reads": rs, "cached": rs[0]["status"] == 200 and rs[0]["made"] is not None and rs[0]["made"] == rs[1]["made"]}
    if probe_on:
        ctl = probe_reads("https://wp-cacheprobe-direct.%s.workers.dev" % SUB)
        nsr = probe_reads("https://wp-cacheprobe.%s.workers.dev" % SUB)
        verdict = ("inconclusive: the control was not cached" if not ctl["cached"]
                   else "yes: the namespace script was served from the cache" if nsr["cached"]
                   else "no: the control was cached and the namespace script was not")
        out["workers_cache_probe"] = {"control": ctl, "namespace": nsr, "verdict": verdict}

    out["failed"] = bad
    os.makedirs(os.path.join(os.path.dirname(os.path.abspath(__file__)), "results"), exist_ok=True)
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results", "day1-%s.json" % time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
    json.dump(out, open(p, "w"), indent=1)
    print(json.dumps(out, indent=1))
    print("results: " + p)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
