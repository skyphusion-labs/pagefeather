#!/usr/bin/env python3
"""Admin page memory by component (#434). THROWAWAY site only: it evicts the site's object before
every request (so each request boots a fresh runtime) and, for the install page, installs a plugin.

    B=https://<throwaway> THROWAWAY=<its exact host> SPIKE_TOKEN=... ADMIN_USER=... ADMIN_PASSWORD=... \\
      TURNSTILE_TEST_TOKEN=XXXX.DUMMY.TOKEN.XXXX python3 tests/wfp/admin-mem.py run <label> [N] > <label>.jsonl
    python3 tests/wfp/admin-mem.py summary <label>.jsonl ...

For each page and each switch (none, then one component off at a time; x-mem-off, see
spikes/b2-wordpress/php/mem-trace.php) it sends N requests. Each request carries x-mem-trace, so
the site returns the operator-only x-mem-trace header: checkpoints along the boot with the live
WASM heap (and Zend's numbers under USE_ZEND_ALLOC=1), the included files by component, the
alloptions size and the locale. One JSON line per request: headers and that trace only, never a
body or a cookie. The memory of record is the WASM heap: x-wasm-mib (the end of the request) and
the trace's checkpoints. A component's cost is the page's heap with it ON minus with it OFF."""
import json, os, re, statistics, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../spikes/b2-wordpress/tests"))

PAGES = [
    ("dashboard", "GET", "/wp-admin/", ["woo", "wcadmin", "wcfeatures", "updates", "dashboard", "notices", "l10n"]),
    ("post-new", "GET", "/wp-admin/post-new.php", ["woo", "wcadmin", "wcfeatures", "preload", "updates", "notices", "l10n"]),
    ("profile", "GET", "/wp-admin/profile.php", ["woo", "wcadmin", "wcfeatures", "updates", "notices", "l10n"]),
    ("wc-settings", "GET", "/wp-admin/admin.php?page=wc-settings", ["wcadmin", "wcfeatures", "updates", "notices", "l10n"]),
    ("products", "GET", "/wp-admin/edit.php?post_type=product", ["wcadmin", "wcfeatures", "updates", "notices", "l10n"]),
    ("orders", "GET", "/wp-admin/admin.php?page=wc-orders", ["wcadmin", "wcfeatures", "updates", "notices", "l10n"]),
    ("install", "POST-REST", "/wp/v2/plugins", ["woo", "wcadmin", "wcfeatures", "l10n"]),
]
MIB = 1048576


def trace_of(r):
    h = r.get("h") or {}
    raw = h.get("x-mem-trace") if h else None
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        return None


def row_of(label, page, off, i, r, perf_id=None):
    h = r.get("h") or {}
    g = lambda k: h.get(k) if h else None
    perf = None
    try:
        perf = json.loads(g("x-perf")) if g("x-perf") else None
    except ValueError:
        perf = None
    t = trace_of(r)
    return {"run": label, "page": page, "off": off, "i": i, "t": round(time.time(), 3), "code": r.get("code"), "s": r.get("s"), "id": perf_id,
            "wasm": g("x-wasm-mib"), "recycled": g("x-runtime-recycled"), "reset": g("x-isolate-reset"),
            "writeLoss": g("x-write-loss"), "rt": perf.get("rt") if perf else None, "rtServed": perf.get("rtServed") if perf else None,
            "trace": t, **({"err": r["err"]} if r.get("err") else {})}


def target_ok(base, allowed):
    """The run refuses any site but the one named in THROWAWAY (an exact host match)."""
    from urllib.parse import urlparse
    host = urlparse(base or "").hostname or ""
    return bool(allowed) and host == allowed


def plugin_path(o, req, nonce, slug):
    r = req(o, "/?rest_route=/wp/v2/plugins", None, {"X-WP-Nonce": nonce})
    try:
        for p in json.loads(r.get("body") or b"[]"):
            if p.get("plugin", "").split("/")[0] == slug:
                return p["plugin"]
    except (ValueError, AttributeError):
        return None
    return None


def run(label, n):
    import break_lib
    from break_lib import opener, req
    if not target_ok(break_lib.B, os.environ.get("THROWAWAY")):
        sys.exit("admin-mem: B is not the THROWAWAY host; refusing (set THROWAWAY to the throwaway site's exact host)")
    o = opener()
    req(o, "/wp-login.php")
    form = {"log": os.environ.get("ADMIN_USER", "admin"), "pwd": os.environ["ADMIN_PASSWORD"], "wp-submit": "Log In", "redirect_to": "/wp-admin/", "testcookie": "1"}
    if os.environ.get("TURNSTILE_TEST_TOKEN"):
        form["cf-turnstile-response"] = os.environ["TURNSTILE_TEST_TOKEN"]
    r = req(o, "/wp-login.php", form)
    assert r["code"] == 302, "login answered %s" % r["code"]
    nonce = (req(o, "/wp-admin/admin-ajax.php?action=rest-nonce").get("body") or b"").decode().strip()
    for page, method, path, offs in PAGES:
        for off in ["none"] + offs:
            for i in range(n):
                req(o, "/_evict", b"", None, "POST")  # a fresh runtime for the next request
                h = {"x-mem-trace": "1", "x-perf-id": "%s.%s.%s.%d.%d" % (label, page, off, i, int(time.time()))}
                if off != "none":
                    h["x-mem-off"] = off
                if method == "POST-REST":
                    h.update({"X-WP-Nonce": nonce, "Content-Type": "application/json"})
                    r = req(o, "/?rest_route=" + path, json.dumps({"slug": "contact-form-7"}).encode(), h, "POST")
                    print(json.dumps(row_of(label, page, off, i, r, h.get("x-perf-id"))), flush=True)
                    # Leave nothing behind: if the install is still there (it is usually gone with
                    # its isolate, #422), delete it. Recorded as its own row, headers only.
                    pp = plugin_path(o, req, nonce, "contact-form-7")
                    if pp:
                        d = req(o, "/?rest_route=/wp/v2/plugins/" + pp.replace(".php", ""), None, {"X-WP-Nonce": nonce}, "DELETE")
                        print(json.dumps(row_of(label, "install-cleanup", off, i, d)), flush=True)
                    continue
                else:
                    r = req(o, path + ("&" if "?" in path else "?") + "nocache=%s-%d" % (label, int(time.time() * 1000)), None, h)
                print(json.dumps(row_of(label, page, off, i, r, h.get("x-perf-id"))), flush=True)


def marks(t):
    """[(name, wasm MiB)] from a trace; None when the trace has no WASM samples."""
    if not t or not t.get("m"):
        return None
    return [(m[0], m[3] / MIB if m[3] else None) for m in t["m"]]


def med(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 1) if xs else None


def summary(rows):
    out = {}
    by = {}
    for r in rows:
        by.setdefault((r["page"], r["off"]), []).append(r)
    for (page, off), rs in sorted(by.items()):
        end = [float(r["wasm"]) if r.get("wasm") not in (None, "") else (marks(r["trace"])[-1][1] if marks(r["trace"]) else None) for r in rs]
        ok = sum(1 for r in rs if r.get("code") in (200, 201, 302))
        e = out.setdefault(page, {})
        e[off] = {"n": len(rs), "ok": ok, "endMiB": med(end), "resets": sum(1 for r in rs if r.get("reset")),
                  "writeLoss": sum(1 for r in rs if r.get("writeLoss")), "fresh": sum(1 for r in rs if r.get("rtServed") == 1)}
        tr = [r["trace"] for r in rs if r.get("trace")]
        if tr:
            e[off]["files"] = {k: med([t["files"].get(k) for t in tr]) for k in sorted({k for t in tr for k in t.get("files", {})})}
            e[off]["alloptions"] = med([t["alloptions"][1] for t in tr if t.get("alloptions")])
            e[off]["locale"] = tr[0].get("locale")
            steps = {}
            for t in tr:
                ms = marks(t) or []
                for (a, wa), (b, wb) in zip(ms, ms[1:]):
                    if wa is not None and wb is not None:
                        steps.setdefault("%s>%s" % (a, b), []).append(wb - wa)
            e[off]["growthMiB"] = {k: med(v) for k, v in steps.items() if med(v)}
    for page, e in out.items():
        base = e.get("none", {}).get("endMiB")
        for off, v in e.items():
            if off != "none" and base is not None and v.get("endMiB") is not None:
                v["savesMiB"] = round(base - v["endMiB"], 1)
    return out


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "run":
        run(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 3)
    elif len(sys.argv) >= 3 and sys.argv[1] == "summary":
        rows = [json.loads(l) for f in sys.argv[2:] for l in open(f) if l.strip()]
        print(json.dumps(summary(rows), indent=1))
    else:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
