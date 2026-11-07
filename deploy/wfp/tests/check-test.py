#!/usr/bin/env python3
# Offline test of deploy/wfp/check.py helpers (issue #138): the phase-aware
# origin, site_wait_cap, and front_get's Custom Domain propagation retry. No
# network: front_get is driven with a stub req.
import importlib.util, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
CHECK = os.path.join(HERE, "..", "check.py")


def load(phase_b, subdomain="wfp-test.skyphusion.org", sub="sub123"):
    os.environ["CLOUDFLARE_ACCOUNT_ID"] = "acc"
    os.environ["CLOUDFLARE_API_TOKEN"] = "tok"
    os.environ["SUB"] = sub
    os.environ["WFP_SUBDOMAIN"] = subdomain
    os.environ["WFP_CUSTOM_DOMAIN"] = "1" if phase_b else "0"
    for k in ("SITE_WAIT", "SITE_WAIT_STEP"):
        os.environ.pop(k, None)
    spec = importlib.util.spec_from_file_location("wfpcheck_%s" % phase_b, CHECK)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)  # main() is guarded, so nothing runs on import
    return m


fails = 0


def eq(name, got, want):
    global fails
    if got == want:
        print("PASS", name)
    else:
        print("FAIL %s: got %r want %r" % (name, got, want)); fails += 1


# origin and the wait cap, per phase.
a = load(False)
eq("origin phase A is workers.dev", a.origin("blog"), "https://wp-blog.sub123.workers.dev")
eq("site_wait_cap phase A", a.site_wait_cap(), 300)
b = load(True)
eq("origin phase B is the Custom Domain", b.origin("blog"), "https://blog.wfp-test.skyphusion.org")
eq("site_wait_cap phase B first deploy", b.site_wait_cap(), 1800)
os.environ["SITE_WAIT"] = "42"
eq("site_wait_cap SITE_WAIT overrides", b.site_wait_cap(), 42)
os.environ.pop("SITE_WAIT", None)

# front_get: phase B waits out a transient not-deployed, then returns 200.
b2 = load(True)
calls = {"n": 0}
def transient(url, *a, **k):
    calls["n"] += 1
    if calls["n"] < 3:
        return 404, {"x-wfp-error": "not-deployed"}, "not deployed"
    return 200, {}, "<title>ok</title>"
b2.req = transient
os.environ["SITE_WAIT"] = "30"; os.environ["SITE_WAIT_STEP"] = "0"
st, _, _ = b2.front_get("https://blog.wfp-test.skyphusion.org")
eq("front_get phase B waits out propagation then 200", st, 200)
eq("front_get phase B actually retried", calls["n"] >= 3, True)

# front_get: phase A does not retry (returns the first read).
a2 = load(False)
callsA = {"n": 0}
def once404(url, *a, **k):
    callsA["n"] += 1
    return 404, {"x-wfp-error": "not-deployed"}, "x"
a2.req = once404
st, _, _ = a2.front_get("https://wp-blog.sub123.workers.dev")
eq("front_get phase A returns the first read", st, 404)
eq("front_get phase A did not retry", callsA["n"], 1)

# front_get: a persistent transient in phase B is returned as the real failure
# after the cap (so a genuinely broken deploy is not masked forever).
b3 = load(True)
callsP = {"n": 0}
def persist(url, *a, **k):
    callsP["n"] += 1
    return 404, {"x-wfp-error": "no-site"}, "x"
b3.req = persist
os.environ["SITE_WAIT"] = "0"; os.environ["SITE_WAIT_STEP"] = "0"
st, _, _ = b3.front_get("https://blog.wfp-test.skyphusion.org")
eq("front_get phase B gives up after the cap", st, 404)
for k in ("SITE_WAIT", "SITE_WAIT_STEP"):
    os.environ.pop(k, None)

print("all passed" if not fails else "%d failed" % fails)
sys.exit(1 if fails else 0)
