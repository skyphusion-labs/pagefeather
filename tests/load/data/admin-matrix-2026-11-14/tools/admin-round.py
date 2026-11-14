"""The admin 7-screen round (#479, #504; docs/admin-memory-matrix.md). With ALL_ON=1 every round is the plain round; otherwise SWITCH=<x-mem-off value> runs on odd rounds: does switching WooCommerce off (x-mem-off: woo) lower admin deaths?
Per round, ONE arm for all four screens: odd rounds woo off, even rounds woo on (the control).
Every request carries x-mem-trace (both arms, so the trace cost is equal), x-mem-ledger: 1 and a
unique x-perf-id. Screens: dashboard GET; post-new (post); post-new (page); profile save (GET the
form, POST it with every field unchanged except description = a marker, read back by REST).
One JSON line per request. Headers only, never a body. The description is restored at the end."""
import json, os, re, sys, time, uuid
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "..", "tests", "plugins"))
import gate2 as G
L = G.L
G.OUT = open(os.devnull, "w")
ROUNDS = int(os.environ.get("ROUNDS", "50"))
SWITCH = os.environ.get("SWITCH", "woo")
assert re.fullmatch(r"[a-z0-9=,_-]{1,64}", SWITCH)
ONLY = [x for x in os.environ.get("SCREENS", "").split(",") if x]
RUN = "m504-" + SWITCH.replace("=", "-") + "-" + uuid.uuid4().hex[:6]
KEEP = ("x-write-loss", "x-isolate-reset", "x-wasm-mib", "x-runtime-recycled", "x-boot", "x-isolate-retry")

def out(**k):
    print(json.dumps({"t": round(time.time(), 3), "at": time.strftime("%H:%M:%SZ", time.gmtime()), "run": RUN, **k}), flush=True)

def hdrs(arm, pid):
    h = {"x-mem-trace": "1", "x-mem-ledger": "1", "x-perf-id": pid}
    if arm == "off":
        h["x-mem-off"] = SWITCH
    return h

def rec(rnd, arm, screen, method, path, r, pid, **extra):
    row = {k: G.hget(r, k) for k in KEEP if G.hget(r, k)}
    perf = None
    try:
        perf = json.loads(G.hget(r, "x-perf")) if G.hget(r, "x-perf") else None
    except ValueError:
        pass
    trace = bool(G.hget(r, "x-mem-trace"))
    _h = G.hget(r, "x-hostlesswp")
    if _h:
        extra = dict(extra, hwp=_h[:300])
    if isinstance(r.get("code"), int) and r["code"] >= 500:
        _b = (r.get("body") or b"")[:4000].decode(errors="replace")
        _t = re.search(r"<title>(.*?)</title>", _b, re.S)
        _c = re.search(r"[Ee]rror code[^0-9]{0,20}(\d{3,4})", _b)
        extra = dict(extra, errTitle=(_t.group(1).strip()[:80] if _t else None), cfCode=(_c.group(1) if _c else None), errLen=len(r.get("body") or b""), wfpError=G.hget(r, "x-wfp-error"), server=G.hget(r, "server"))
    out(ev="req", round=rnd, arm=arm, screen=screen, method=method, path=path.split("?")[0], code=r.get("code"), s=r.get("s"),
        pid=pid, mem=(perf or {}).get("mem"), wasm1=(perf or {}).get("wasm1MiB"), iso=(perf or {}).get("iso"),
        rt=(perf or {}).get("rt"), boot=(perf or {}).get("boot"), trace=trace, **row, **extra)

o = G.login()
me = json.loads(L.rest(o, "/wp/v2/users/me?context=edit")["body"])
snap = me.get("description", "")
posts = json.loads(L.rest(o, "/wp/v2/posts?per_page=1&status=publish")["body"])
pages = json.loads(L.rest(o, "/wp/v2/pages?per_page=1&status=publish")["body"])
POST_ID = posts[0]["id"] if posts else None
PAGE_ID = pages[0]["id"] if pages else None
out(ev="start", rounds=ROUNDS, switch=SWITCH, snapDescLen=len(snap), postId=POST_ID, pageId=PAGE_ID)
for rnd in range(ROUNDS):
    arm = "on" if os.environ.get("ALL_ON") == "1" else ("off" if rnd % 2 else "on")
    for screen, path in (("dashboard", "/wp-admin/"), ("post-new-post", "/wp-admin/post-new.php"), ("post-new-page", "/wp-admin/post-new.php?post_type=page"),
                         ("edit-post", "/wp-admin/post.php?post=%s&action=edit" % POST_ID), ("edit-page", "/wp-admin/post.php?post=%s&action=edit" % PAGE_ID)):
        if path.endswith("post=None&action=edit"):
            continue
        if ONLY and screen not in ONLY:
            continue
        pid = "%s-%d-%s" % (RUN, rnd, screen)
        rec(rnd, arm, screen, "GET", path, L.req(o, path, headers=hdrs(arm, pid)), pid)
    if ONLY and "profile-save" not in ONLY:
        continue
    pid = "%s-%d-profile-get" % (RUN, rnd)
    p = L.req(o, "/wp-admin/profile.php", headers=hdrs(arm, pid))
    rec(rnd, arm, "profile-get", "GET", "/wp-admin/profile.php", p, pid)
    action, f = G.form_fields(p.get("body") or b"")
    if not f or "_wpnonce" not in f:
        out(ev="req", round=rnd, arm=arm, screen="profile-save", code="SKIP-no-form")
    else:
        mark = "%s-%d" % (RUN, rnd)
        f["description"] = mark
        f.pop("pass1", None); f.pop("pass2", None)
        pid = "%s-%d-profile-save" % (RUN, rnd)
        s = L.req(o, "/wp-admin/profile.php", f, headers=hdrs(arm, pid))
        got = (json.loads(L.rest(o, "/wp/v2/users/me?context=edit")["body"]) or {}).get("description")
        rec(rnd, arm, "profile-save", "POST", "/wp-admin/profile.php", s, pid, stuck=(got == mark))
    if rnd % 5 == 4:
        try:
            o = G.login()  # a fresh session now and then, as an admin would have
        except Exception as e:
            out(ev="login", ok=False, err=repr(e)[:160])
r = L.rest(o, "/wp/v2/users/me", {"description": snap}, "POST")
back = (json.loads(L.rest(o, "/wp/v2/users/me?context=edit")["body"]) or {}).get("description")
out(ev="end", restore=r["code"], restored=(back == snap))
