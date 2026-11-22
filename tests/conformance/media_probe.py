#!/usr/bin/env python3
"""Upload persistence probe (#759): does a site keep the files of an upload? The wp suite's media spec tests a FAILED
upload, so it cannot tell durable media (R2) from none (sb1120, cf759f). This probe can.

  B=<site> WP_USERNAME=<admin> WP_PASSWORD=<application password> \
    python3 -I tests/conformance/media_probe.py <out.json> [--wait 90] [--keep]
  SPIKE_TOKEN, when set, is sent as x-spike-token so the page read can see x-wasm-mib.
  When it is not set, a blank or a 0 is reported as not readable without the token (#1271).

1. Make a 600x400 PNG here (no download), and POST it to /wp/v2/media (Basic auth). It must answer 201.
2. GET the full file and every generated size listed in media_details.sizes, each on a fresh connection, with a cache
   buster. Each must answer 200 with an image content type, and the full file must have the uploaded bytes.
3. Wait (--wait seconds, default 90), GET a PHP page (so a request boots or reuses PHP, its x-wasm-mib recorded), then
   GET every file again. An isolate's identity cannot be seen from outside: the wait and the fresh connections are the
   instrument, and the report says so.
4. Delete the attachment (force) unless --keep, then check that the full file answers 404.
Prints one @event line per step and never a secret. Exit 0: every check passed. 1: a check failed. 2: refused (no site
or no credentials, or not a conformance throwaway).
"""
import base64, json, os, struct, sys, time, urllib.error, urllib.request, zlib

B = os.environ.get("B", "").rstrip("/")
UA = {"User-Agent": "pagefeather-conformance-media-probe"}
KEYS = ("x-pf-call", "x-wasm-mib", "x-write-loss", "x-isolate-reset", "cf-cache-status", "cf-ray")
WASM_UNREADABLE = "x-wasm-mib: not readable without the token"


def wasm_mib_reading(value):
    """The heap header. Without SPIKE_TOKEN, a blank or a 0 is not a measurement (#1271)."""
    if os.environ.get("SPIKE_TOKEN"):
        if value is None or str(value).strip() == "":
            return None
        return str(value)
    if value is None or str(value).strip() in ("", "0"):
        return WASM_UNREADABLE
    return str(value)


def event(kind, **kw):
    print("@event %s %s" % (kind, json.dumps(kw, sort_keys=True)), flush=True)


def png(w=600, h=400):
    rows = b"".join(b"\x00" + bytes(v for x in range(w) for v in ((x * 7 + y) % 256, (y * 3) % 256, (x + 2 * y) % 256)) for y in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def req(url, data=None, headers=None, method=None, timeout=60):
    h = dict(UA, **(headers or {}))
    tok = os.environ.get("SPIKE_TOKEN")
    if tok and not any(k.lower() == "x-spike-token" for k in h):
        h["x-spike-token"] = tok
    try:
        r = urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h, method=method), timeout=timeout)
        return r.status, r.read(), {k.lower(): v for k, v in r.headers.items()}
    except urllib.error.HTTPError as e:
        return e.code, e.read(), {k.lower(): v for k, v in e.headers.items()}
    except Exception as e:
        return 0, repr(e).encode(), {}


def pick(h):
    out = {}
    for k in KEYS:
        if k == "x-wasm-mib":
            v = wasm_mib_reading(h.get(k) if h else None)
            if v:
                out[k] = v
        elif h and k in h:
            out[k] = h[k]
    return out


def main(argv):
    user, pw = os.environ.get("WP_USERNAME", ""), os.environ.get("WP_PASSWORD", "")
    if not B or not argv or not user or not pw:
        event("refused", why="usage: B=<site> WP_USERNAME=... WP_PASSWORD=... media_probe.py <out.json> [--wait N] [--keep]")
        return 2
    out = argv[0]
    wait = int(argv[argv.index("--wait") + 1]) if "--wait" in argv else 90
    keep = "--keep" in argv
    c, b, _ = req(B + "/?rest_route=/pf-conformance/v1/throwaway")
    try:
        marker = json.loads(b or b"{}")
    except ValueError:
        marker = {}
    if not (c == 200 and isinstance(marker, dict) and marker.get("throwaway") is True):
        event("refused", why="not a conformance throwaway (marker %s)" % c)
        return 2
    auth = {"Authorization": "Basic " + base64.b64encode(("%s:%s" % (user, pw)).encode()).decode()}
    rep = {"site": B, "checks": [], "instrument": "REST upload, then fresh-connection GETs before and after a %d s wait; "
           "isolate identity is not observable from outside" % wait}
    failed = []

    def check(name, ok, **kw):
        rep["checks"].append(dict(name=name, ok=bool(ok), **kw))
        event("check", name=name, ok=bool(ok), **kw)
        if not ok:
            failed.append(name)

    data = png()
    name = "pf-media-probe-%d.png" % int(time.time())
    c, b, h = req(B + "/?rest_route=/wp/v2/media", data, dict(auth, **{"Content-Type": "image/png", "Content-Disposition": 'attachment; filename="%s"' % name}), "POST")
    try:
        m = json.loads(b or b"{}")
    except ValueError:
        m = {}
    check("upload answers 201", c == 201 and isinstance(m, dict) and m.get("id"), status=c, **pick(h))
    if failed:
        json.dump(rep, open(out, "w"), indent=1)
        return 1
    files = [("full", m["source_url"])] + sorted((k, v.get("source_url")) for k, v in ((m.get("media_details") or {}).get("sizes") or {}).items() if k != "full" and v.get("source_url"))
    check("WordPress made at least one sub-size", len(files) > 1, sizes=[k for k, _ in files[1:]])

    def read_all(label):
        for size, url in files:
            c, body, h = req("%s?pf-probe=%s-%d" % (url, label.replace(" ", "-"), int(time.time() * 1000)))
            ok = c == 200 and (h.get("content-type") or "").startswith("image/") and (size != "full" or body == data)
            check("%s: %s answers 200 with the image%s" % (label, size, " bytes" if size == "full" else ""), ok, status=c, bytes=len(body or b""), **pick(h))

    read_all("first read")
    time.sleep(wait)
    c, _, h = req(B + "/?pf-probe=page-%d" % int(time.time()))
    rep["page_between"] = dict(status=c, **pick(h))
    read_all("after %d s" % wait)
    if not keep:
        c, _, h = req(B + "/?rest_route=/wp/v2/media/%s&force=true" % m["id"], None, auth, "DELETE")
        check("delete (force) answers 200", c == 200, status=c, **pick(h))
        c, _, _ = req("%s?pf-probe=deleted-%d" % (files[0][1], int(time.time())))
        check("after the delete the full file answers 404", c == 404, status=c)
    rep["failed"] = failed
    json.dump(rep, open(out, "w"), indent=1, sort_keys=True)
    event("done", failed=failed, checks=len(rep["checks"]))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
