#!/usr/bin/env python3
"""Gate for outbound HTTP from PHP (php/http-bridge.php, issue #26).

Usage: B=<site> ADMIN_PASSWORD=... ECHO=<echo base> python3 tests/http/http_bridge_check.py
The site's build must hold tests/http/test-http-route.php as an mu-plugin (a
test-only route; the gate script copies it into the built tree). ECHO is an
httpbin-like server: tests/http/echo.py locally (default http://127.0.0.1:8811),
or https://httpbin.org on a deploy. EXTERNAL=1 adds the checks of issue #26
against the real internet; AKISMET=1 the Akismet one (Akismet must be in the build).

Checks (PASS or FAIL each; exit 1 on any FAIL):
  get, post-form, post-json, headers, status, redirects, too-many-redirects,
  no-redirect, timeout, limit, stream, cookies
  loopback   a request to the site itself is refused at once (no deadlock in the
             one PHP object), and the site still answers right after
  external   (EXTERNAL=1) api.wordpress.org answers 200; plugins.php shows no
             update-check warning
  akismet    (AKISMET=1) Akismet::verify_key() answers invalid (its API answered),
             not failed (no network); Akismet must be active
"""
import json, os, sys, time, uuid
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "spikes", "b2-wordpress", "tests"))
import break_lib as L

ECHO = os.environ.get("ECHO", "http://127.0.0.1:8811").rstrip("/")
bad = 0


def check(name, ok, detail=""):
    global bad
    print(("PASS " if ok else "FAIL ") + name + (" | " + str(detail)[:300] if detail else ""), flush=True)
    bad += 0 if ok else 1


admin = L.login()
body = (L.req(admin, "/wp-admin/post-new.php")["body"] or b"").decode("utf-8", "replace")
nonce = (body.split('createNonceMiddleware( "')[1:] or [""])[0].split('"')[0]


def call(url, **args):
    t = time.time()
    r = L.req(admin, "/?rest_route=/skyphusion-test/v1/http", data=json.dumps({"url": url, "args": args}).encode(),
              headers={"X-WP-Nonce": nonce, "Content-Type": "application/json"}, method="POST", timeout=60)
    try:
        js = json.loads(r["body"] or b"null")
    except ValueError:
        js = None
    return r["code"], js or {}, time.time() - t


def echoed(js):
    try:
        return json.loads(js.get("body") or "{}")
    except ValueError:
        return {}


code, js, _ = call(ECHO + "/anything?x=1")
e = echoed(js)
check("get", code == 200 and js.get("status") == 200 and e.get("args", {}).get("x") == "1" and "WordPress/" in json.dumps(e.get("headers", {})), {"route": code, "status": js.get("status"), "args": e.get("args")})
code, js, _ = call(ECHO + "/anything", method="POST", body={"a": "1", "b": "two"})
e = echoed(js)
check("post-form", js.get("status") == 200 and e.get("method") == "POST" and e.get("form", {}).get("b") == "two", e.get("form"))
code, js, _ = call(ECHO + "/anything", method="POST", body=json.dumps({"k": [1, 2]}), headers={"Content-Type": "application/json"})
e = echoed(js)
check("post-json", (e.get("json") or {}).get("k") == [1, 2], e.get("json"))
code, js, _ = call(ECHO + "/anything", headers={"X-Test": "value-1"})
e = echoed(js)
sent = {k.lower(): v for k, v in (e.get("headers") or {}).items()}
code, js2, _ = call(ECHO + "/response-headers?X-Echo=yes")
check("headers", sent.get("x-test") == "value-1" and (js2.get("headers") or {}).get("x-echo") == "yes", {"sent": sent.get("x-test"), "got": (js2.get("headers") or {}).get("x-echo")})
code, js, _ = call(ECHO + "/status/418")
check("status", js.get("error") is False and js.get("status") == 418, js)
code, js, _ = call(ECHO + "/redirect/3", redirection=5)
# The end of the chain: /anything on the local echo, /get on httpbin.
end = echoed(js)
check("redirects", js.get("status") == 200 and (end.get("path") == "/anything" or str(end.get("url", "")).endswith("/get")), {"status": js.get("status"), "path": end.get("path"), "url": end.get("url")})
code, js, _ = call(ECHO + "/redirect/3", redirection=1)
check("too-many-redirects", js.get("error") is True and "redirect" in (js.get("message") or "").lower(), js)
code, js, _ = call(ECHO + "/redirect/1", redirection=0)
check("no-redirect", js.get("status") == 302 and "location" in (js.get("headers") or {}), {"status": js.get("status")})
code, js, took = call(ECHO + "/delay/4", timeout=1)
check("timeout", js.get("error") is True and "timed out" in (js.get("message") or "") and took < 3.5, {"message": js.get("message"), "seconds": round(took, 2)})
code, js, _ = call(ECHO + "/bytes/20000", limit_response_size=1000)
check("limit", js.get("status") == 200 and js.get("body_len") == 1000, {"body_len": js.get("body_len")})
code, js, _ = call(ECHO + "/bytes/12345", stream=True)
check("stream", js.get("status") == 200 and js.get("file_size") == 12345 and js.get("body_len") == 0, {"file_size": js.get("file_size"), "body_len": js.get("body_len")})
# redirection=0: httpbin sets the cookie on a 302; the local echo on a 200.
code, js, _ = call(ECHO + "/cookies/set?flavour=oat", redirection=0)
check("cookies", "flavour" in (js.get("cookies") or []), js.get("cookies"))

# A request to the site itself: refused at once, and the site answers right after.
code, js, took = call("home", timeout=10)
check("loopback refused at once", js.get("error") is True and "itself" in (js.get("message") or "") and took < 3, {"message": js.get("message"), "seconds": round(took, 2)})
t = time.time()
after = L.req(L.opener(), "/?nocache=" + uuid.uuid4().hex[:8])
check("site answers after the loopback", after["code"] == 200 and time.time() - t < 10, {"code": after["code"], "seconds": round(time.time() - t, 2)})

if os.environ.get("EXTERNAL") == "1":
    code, js, _ = call("https://api.wordpress.org/core/version-check/1.7/", timeout=15)
    check("external: api.wordpress.org", js.get("status") == 200 and "offers" in (js.get("body") or ""), {"status": js.get("status"), "error": js.get("message")})
    page = (L.req(admin, "/wp-admin/plugins.php")["body"] or b"").decode("utf-8", "replace")
    check("external: no update-check warning on plugins.php", "could not establish a secure connection" not in page, "")
if os.environ.get("AKISMET") == "1":
    # Akismet::verify_key(): "invalid" = its API answered (the key is not real); "failed" = no network.
    code, js, _ = call("akismet_verify_key")
    check("akismet: key check reaches the API (a key error is fine)", js.get("akismet") == "invalid", js)

print("FAILS %d" % bad)
sys.exit(1 if bad else 0)
