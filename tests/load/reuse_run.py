#!/usr/bin/env python3
"""The #724 live run (#598): PHP_MEMORY_REUSE and BOOT_GATE on against off, one arm per invocation.

  B=https://<site> ADMIN_PASSWORD=... SPIKE_TOKEN=... ARM=npm-on OUT=runs/npm-on.jsonl \\
    python3 -I tests/load/reuse_run.py [check|repro|burst|quiet|all]

The spec, with the bar pinned before the data: #598 issuecomment-6910964924, plus the #605 reading
(#598 issuecomment-6912013983). The bar is scored by tests/load/reuse_score.py from the files this writes.
Run from a Vultr VPS, never a laptop. Steps (all = repro, burst, quiet in order, the default):
  check  BEFORE the fixture load: is the live site the arm it claims? GET /_build (the build id: -wooprimed,
         and -e<8 hex> exactly when the engine is lean) and one ledgered front page (no login, so the repro's
         first admin login stays first): x-perf mem.memReuse.on. EXPECT_ENGINE=npm|lean and EXPECT_REUSE=on|off,
         and EXPECT_BUILD (optional) a part the build id must hold (the sha, the -e tag); exit 1 on a mismatch,
         so the arm never runs on the wrong build.
  repro  the 16:54Z repro: run it AT ONCE after tests/fixtures/load-sample-store.sh loads the site. The first
         admin login, then the first admin screens (dashboard, post-new.php, edit.php).
  burst  the 4-editor burst: EDITORS logged-in editors in parallel (separate sessions of the admin user), each
         repeating post-new.php, a save (a REST draft post) and edit.php, until WINDOW_REQS admin requests are
         sent; one window at each WINDOWS minute after the burst starts (default 0,20,60, as #598's w00 w20 w60).
         Guests during every window: uncached home, shop and product pages at GUEST_RPS. After each window
         every save is read back by its marker: a 2xx save that is absent is a lost write.
  quiet  one admin request that forces a recycle (x-runtime-recycle: force, so a spare exists), QUIET_S seconds of
         nothing (default 300), then one admin request: on the on arms it must take the spare (no TTL).
Every admin request sends the spike token, x-mem-ledger: 1 and its own x-perf-id (<arm>-<run>-<n>).
One JSON line per request: step, window, who, kind, method, path, perf id, status (EXC for no answer),
client seconds, the headers the bar reads, and from x-perf: wasm1MiB, boot, bootWaitMs, phpMs and the ledger
(mem.runtimes memLive retiredMem retiredMemMiB; mem.memReuse). Headers only, never a body.
Settings (environment): EDITORS 4, WINDOW_REQS 70, WINDOWS 0,20,60, GUEST_RPS 1, QUIET_S 300, TIMEOUT 300,
PFID_IN_URL (1: each admin request's x-perf-id also in its query, pfid=<id>, for the #605 dispatcher join)
(above #703's 90 s bound and #605's 155 s hang, so a hang is measured, not cut by the client).
"""
import json, os, random, re, sys, threading, time, urllib.error, urllib.parse, urllib.request, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "spikes", "b2-wordpress", "tests"))
for k in ("B", "ADMIN_PASSWORD", "SPIKE_TOKEN", "ARM", "OUT"):
    if not os.environ.get(k):
        sys.exit("reuse-run: set %s" % k)
import break_lib as BL  # the login woo.py, break.py and editor-lists-check.py use on deployed sites (Turnstile too)

B = os.environ["B"].rstrip("/")
ARM = os.environ["ARM"]
if not re.fullmatch(r"[a-z0-9-]{1,32}", ARM):
    sys.exit("reuse-run: ARM is a short label, for example npm-on")
EDITORS = int(os.environ.get("EDITORS", "4"))
WINDOW_REQS = int(os.environ.get("WINDOW_REQS", "70"))
WINDOWS = [float(x) for x in os.environ.get("WINDOWS", "0,20,60").split(",")]
GUEST_RPS = float(os.environ.get("GUEST_RPS", "1"))
QUIET_S = float(os.environ.get("QUIET_S", "300"))
TIMEOUT = float(os.environ.get("TIMEOUT", "300"))
# #605: PFID_IN_URL=1 also puts each admin request's x-perf-id in its query (pfid=<id>), so the dispatcher's Workers
# Logs invocation (which records the URL, not our headers) joins to the request exactly (tests/load/hang_read.py).
PFID_IN_URL = os.environ.get("PFID_IN_URL") == "1"
STEP = sys.argv[1] if len(sys.argv) > 1 else "all"
if STEP not in ("check", "repro", "burst", "quiet", "all"):
    sys.exit("reuse-run: the step is check, repro, burst, quiet or all")
RUN = ARM + "-" + uuid.uuid4().hex[:6]
KEEP = ("x-runtime-recycled", "x-runtime-wait", "x-runtime-wait-decision", "x-runtime-wait-mib", "x-isolate-reset",
        "x-write-loss", "x-object-deadline", "x-wasm-mib", "x-boot", "retry-after", "server-timing")
out_lock, n_lock = threading.Lock(), threading.Lock()
OUT = open(os.environ["OUT"], "a")
N = [0]


def emit(**k):
    with out_lock:
        OUT.write(json.dumps({"t": round(time.time(), 3), "at": time.strftime("%H:%M:%SZ", time.gmtime()), "run": RUN, "arm": ARM, **k}) + "\n")
        OUT.flush()


def pid():
    with n_lock:
        N[0] += 1
        return "%s-%d" % (RUN, N[0])


def perf_fields(h):
    try:
        p = json.loads(h.get("x-perf") or "{}")
    except ValueError:
        return {"perfBad": True}
    m = p.get("mem") or {}
    rt, mr = m.get("runtimes") or {}, m.get("memReuse") or {}
    return {"wasm1MiB": p.get("wasm1MiB"), "boot": p.get("boot"), "bootWaitMs": p.get("bootWaitMs"), "phpMs": p.get("phpMs"),
            "iso": m.get("iso"), "rt": m.get("rt"),
            "memLive": rt.get("memLive"), "retiredMem": rt.get("retiredMem"), "retiredMemMiB": rt.get("retiredMemMiB"),
            "memReuse": mr or None}


def admin(o, step, who, kind, path, data=None, method=None, window=None, rest=False, extra=None):
    p = pid()
    h = {"x-mem-ledger": "1", "x-perf-id": p, **(extra or {})}
    if rest:
        h["X-WP-Nonce"] = o.nonce
        if data is not None:
            data = json.dumps(data).encode(); h["Content-Type"] = "application/json"
        path = "/?rest_route=" + path
    if PFID_IN_URL:
        path = path + ("&" if "?" in path else "?") + "pfid=" + p
    r = BL.req(o, path, data, h, method, timeout=TIMEOUT)
    hd = r.get("h") or {}
    row = {"step": step, "window": window, "who": who, "kind": kind, "method": method or ("POST" if data is not None else "GET"),
           "path": path, "perfId": p, "status": r["code"], "s": r["s"]}
    row.update({k: hd.get(k) for k in KEEP if hd.get(k)})
    if r["code"] == "EXC":
        row["err"] = r.get("err")
    else:
        row.update({k: v for k, v in perf_fields(hd).items() if v is not None})
    emit(**row)
    return r, row


def login(who, step):
    t = time.time()
    try:
        o = BL.login()
        emit(step=step, who=who, kind="login", status=302, s=round(time.time() - t, 2))
        return o
    except AssertionError as e:
        emit(step=step, who=who, kind="login", status="FAIL", s=round(time.time() - t, 2), err=str(e)[:200])
        return None


def guest_get(path):
    q = path + ("&" if "?" in path else "?") + "nocache=%08x" % random.getrandbits(32)
    r = urllib.request.Request(B + q, headers={"User-Agent": "wp-on-cf-reuse-run-guest"})
    t = time.time()
    try:
        with urllib.request.urlopen(r, timeout=TIMEOUT) as x:
            x.read(); return x.status, dict(x.headers), round(time.time() - t, 3)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), round(time.time() - t, 3)
    except Exception as e:
        return "EXC", {"err": repr(e)[:160]}, round(time.time() - t, 3)


def guest_paths():
    st, _, _ = guest_get("/")
    paths = ["/", "/?post_type=product"]
    try:
        with urllib.request.urlopen(urllib.request.Request(B + "/?rest_route=/wc/store/v1/products&per_page=5", headers={"User-Agent": "wp-on-cf-reuse-run-guest"}), timeout=120) as x:
            for p in json.loads(x.read()):
                u = p.get("permalink", "")
                if u.startswith(B):
                    paths.append(u[len(B):] or "/")
    except Exception:
        pass
    return paths


def guests(stop, window, paths):
    i = 0
    while not stop.is_set():
        t0 = time.time()
        path = paths[i % len(paths)]; i += 1
        st, h, s = guest_get(path)
        emit(step="burst", window=window, who="guest", kind="guest", method="GET", path=path, status=st, s=s,
             **{k: h.get(k) for k in ("x-isolate-reset", "x-runtime-wait", "x-object-deadline") if h.get(k)})
        stop.wait(max(0.0, 1.0 / GUEST_RPS - (time.time() - t0)))


def step_repro():
    o = login("e0", "repro")
    if not o:
        return
    for kind, path in (("dashboard", "/wp-admin/"), ("post-new", "/wp-admin/post-new.php"), ("edit", "/wp-admin/edit.php")):
        admin(o, "repro", "e0", kind, path)


def editor(who, o, window, budget, saves):
    k = 0
    while True:
        with n_lock:
            if budget[0] <= 0:
                return
            budget[0] -= 1
        kind = ("post-new", "save", "edit")[k % 3]; k += 1
        if kind == "post-new":
            admin(o, "burst", who, kind, "/wp-admin/post-new.php", window=window)
        elif kind == "edit":
            admin(o, "burst", who, kind, "/wp-admin/edit.php", window=window)
        else:
            marker = "reuse-run %s %s" % (RUN, uuid.uuid4().hex[:10])
            r, row = admin(o, "burst", who, "save", "/wp/v2/posts", {"title": marker, "status": "draft", "content": "#724 live run"}, window=window, rest=True)
            saves.append((marker, row["status"], row["perfId"]))


def read_back(o, window, saves):
    for marker, st, p in saves:
        r = BL.req(o, "/?rest_route=/wp/v2/posts&" + urllib.parse.urlencode({"search": marker, "status": "draft", "context": "edit", "_fields": "id,title"}),
                   headers={"X-WP-Nonce": o.nonce, "x-perf-id": pid()}, timeout=TIMEOUT)
        found = None
        if r["code"] == 200:
            try:
                found = any((x.get("title") or {}).get("raw") == marker for x in json.loads(r["body"]))
            except ValueError:
                found = None
        ok2xx = isinstance(st, int) and 200 <= st < 300
        emit(step="burst", window=window, who="read-back", kind="read-back", savePerfId=p, saveStatus=st, found=found,
             lostWrite=bool(ok2xx and found is False), readStatus=r["code"])


def step_burst():
    sessions = []
    for i in range(EDITORS):
        o = login("e%d" % i, "burst")
        if o:
            sessions.append(("e%d" % i, o))
    if not sessions:
        emit(step="burst", kind="abort", err="no editor logged in"); return
    paths = guest_paths()
    t0 = time.time()
    for wmin in WINDOWS:
        wait = t0 + wmin * 60 - time.time()
        if wait > 0:
            time.sleep(wait)
        window = ("w%02d" % int(wmin)) if wmin == int(wmin) else ("w%g" % wmin)
        emit(step="burst", window=window, kind="window-start")
        stop = threading.Event()
        g = threading.Thread(target=guests, args=(stop, window, paths), daemon=True); g.start()
        budget, saves = [WINDOW_REQS], []
        ts = [threading.Thread(target=editor, args=(who, o, window, budget, saves)) for who, o in sessions]
        for t in ts: t.start()
        for t in ts: t.join()
        stop.set(); g.join(timeout=TIMEOUT)
        read_back(sessions[0][1], window, saves)
        emit(step="burst", window=window, kind="window-end")


def step_quiet():
    o = login("e0", "quiet")
    if not o:
        return
    # A forced recycle (spike-gated) right before the gap leaves a spare, as tests/spare-persist-e2e.sh does locally.
    admin(o, "quiet", "e0", "before-gap", "/wp-admin/edit.php", extra={"x-runtime-recycle": "force"})
    emit(step="quiet", kind="gap-start", seconds=QUIET_S)
    time.sleep(QUIET_S)
    admin(o, "quiet", "e0", "after-gap", "/wp-admin/post-new.php")


def step_check():
    want_e, want_r = os.environ.get("EXPECT_ENGINE"), os.environ.get("EXPECT_REUSE")
    if want_e not in ("npm", "lean") or want_r not in ("on", "off"):
        sys.exit("reuse-run: check needs EXPECT_ENGINE=npm|lean and EXPECT_REUSE=on|off")
    o = BL.opener()
    r = BL.req(o, "/_build", timeout=TIMEOUT)
    try:
        build = json.loads(r["body"]).get("build", "") if r["code"] == 200 else ""
    except ValueError:
        build = ""
    r2 = BL.req(o, "/", headers={"x-mem-ledger": "1", "x-perf-id": pid()}, timeout=TIMEOUT)
    pf = perf_fields(r2.get("h") or {})
    reuse_on = (pf.get("memReuse") or {}).get("on")
    lean = bool(re.search(r"-e[0-9a-f]{8}", build))
    bad = []
    if not build:
        bad.append("no build id (/_build answered %s)" % r["code"])
    if "-wooprimed" not in build:
        bad.append("the build is not WooCommerce primed")
    if lean != (want_e == "lean"):
        bad.append("engine: build %s is %s, want %s" % (build, "lean" if lean else "npm", want_e))
    if os.environ.get("EXPECT_BUILD") and os.environ["EXPECT_BUILD"] not in build:
        bad.append("build %s does not hold %s" % (build, os.environ["EXPECT_BUILD"]))
    if reuse_on is None:
        bad.append("no ledger on x-perf (front page answered %s)" % r2["code"])
    elif bool(reuse_on) != (want_r == "on"):
        bad.append("PHP_MEMORY_REUSE: live %s, want %s" % ("on" if reuse_on else "off", want_r))
    emit(kind="check", build=build, engine="lean" if lean else "npm", reuseOn=reuse_on, ok=not bad, bad=bad)
    print("reuse-run: check %s: build %s, engine %s, memReuse.on %s" % ("ok" if not bad else "FAIL: " + "; ".join(bad), build, "lean" if lean else "npm", reuse_on))
    if bad:
        sys.exit(1)


emit(kind="run-start", step=STEP, b=B, editors=EDITORS, windowReqs=WINDOW_REQS, windows=WINDOWS, guestRps=GUEST_RPS, quietS=QUIET_S)
for s in (("repro", "burst", "quiet") if STEP == "all" else (STEP,)):
    {"check": step_check, "repro": step_repro, "burst": step_burst, "quiet": step_quiet}[s]()
emit(kind="run-end", step=STEP)
print("reuse-run: %s done, %d requests, %s" % (RUN, N[0], os.environ["OUT"]))
