#!/usr/bin/env python3
"""The block editor's memory peak, the WooCommerce route deferral on against off, on ONE build (#768, #791).

  B=https://<site> ADMIN_PASSWORD=... SPIKE_TOKEN=... [REPS=5] [TURNSTILE_TEST_TOKEN=...] \\
    python3 -I tests/load/editor-peak-ab.py

For each editor screen (post-new.php, and post.php on a draft it makes), REPS times each, alternating on and off:
force a fresh PHP runtime (x-runtime-recycle: force, spike-gated), then load the screen with the ledger
(x-mem-ledger: 1) and read the request's wasm high-water, x-perf wasm1MiB. Off is x-pf-wc-defer: off (operator only,
spike-gated). Also reads, from the editor's preloaded answers, that the deferral really ran on the on arm
(X-PF-WC-Routes: deferred N/13). Prints one line per sample and the medians. Exit 1 if a sample is missing, or the on
arm did not defer. Needs the spike token: it never runs on a visitor's terms.
"""
import json, os, statistics, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "spikes", "b2-wordpress", "tests"))
for k in ("B", "ADMIN_PASSWORD", "SPIKE_TOKEN"):
    if not os.environ.get(k):
        sys.exit("editor-peak-ab: set %s" % k)
import break_lib as BL
REPS = int(os.environ.get("REPS", "5"))
o = BL.login()
r = BL.rest(o, "/wp/v2/posts", {"title": "editor peak a/b %d" % time.time(), "status": "draft", "content": "a draft for the post.php screen"})
if r["code"] != 201:
    sys.exit("editor-peak-ab: making a draft answered %s" % r["code"])
pid = json.loads(r["body"])["id"]
SCREENS = [("post-new.php", "/wp-admin/post-new.php"), ("post.php", "/wp-admin/post.php?post=%d&action=edit" % pid)]
ARMS = [("on", {}), ("off", {"x-pf-wc-defer": "off"})]


def sample(path, h):
    BL.req(o, "/wp-login.php", headers={"x-runtime-recycle": "force"})
    x = BL.req(o, path, headers={"x-mem-ledger": "1", **h}, timeout=300)
    perf = json.loads((x["h"] or {}).get("x-perf") or "{}")
    body = (x.get("body") or b"").decode("utf-8", "replace")
    deferred = None
    i = body.find("wp.apiFetch.createPreloadingMiddleware(")
    if i >= 0:
        try:
            pre, _ = json.JSONDecoder().raw_decode(body[body.index("(", i) + 1:].lstrip())
            vals = {(v.get("headers") or {}).get("X-PF-WC-Routes") for v in pre.values() if isinstance(v, dict)} - {None}
            deferred = ",".join(sorted(vals)) or "none"
        except ValueError:
            deferred = "unreadable"
    return x["code"], perf.get("wasm1MiB"), deferred


bad = []
for name, path in SCREENS:
    got = {"on": [], "off": []}
    for n in range(REPS):
        for arm, h in ARMS:
            code, mib, deferred = sample(path, h)
            print("%-12s %-3s #%d  status %s  wasm1MiB %s  preload X-PF-WC-Routes %s" % (name, arm, n + 1, code, mib, deferred))
            if code != 200 or not isinstance(mib, (int, float)):
                bad.append("%s %s #%d: status %s, wasm1MiB %s" % (name, arm, n + 1, code, mib))
                continue
            if arm == "on" and not (deferred or "").startswith("deferred "):
                bad.append("%s on #%d: the deferral did not run (%s)" % (name, n + 1, deferred))
            got[arm].append(mib)
    if got["on"] and got["off"]:
        print("%-12s median on %.1f MiB, off %.1f MiB, saved %.1f MiB (on %s, off %s)" % (name, statistics.median(got["on"]), statistics.median(got["off"]),
              statistics.median(got["off"]) - statistics.median(got["on"]), got["on"], got["off"]))
for b in bad:
    print("PROBLEM " + b)
sys.exit(1 if bad else 0)
