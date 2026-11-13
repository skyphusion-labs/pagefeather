#!/usr/bin/env python3
"""Offline tests for tests/plugins/gate2.py (#426): a fake WordPress, no network.
    python3 -I tests/plugins/gate2_test.py
Each read-back class has a passing control next to the case that should produce it."""
import io, json, os, re, sys, tempfile, urllib.parse
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("ADMIN_PASSWORD", "pw")
import gate2 as G  # noqa: E402

failed = run = 0


def ok(name, fn):
    global failed, run
    run += 1
    try:
        fn()
        print("  ok   " + name)
    except Exception as e:
        failed += 1
        print("  FAIL %s: %r" % (name, e))


class FakeWP:
    """A small WordPress: plugins and themes, the REST routes gate2 uses, /_evict, one settings
    form, and the Store API. Faults are switches."""
    def __init__(self, **faults):
        self.plugins = {"woocommerce": "active"}
        self.themes = {"twentytwentyfive": "active"}
        self.orders = set()
        self.f = {"install_code": 201, "install_effect": True, "evict_drops": False,
                  "write_loss_path": None, "order_saved": True, **faults}
        self.seen = []

    def __call__(self, o, path, data=None, headers=None, method=None, timeout=120):
        self.seen.append((method or ("POST" if data is not None else "GET"), path))
        h = {"x-boot": "0", "x-wasm-mib": "99"}
        if self.f["write_loss_path"] and self.f["write_loss_path"] in path:
            h["x-write-loss"] = "1"
        route = urllib.parse.parse_qs(urllib.parse.urlparse(path).query).get("rest_route", [None])[0]
        post = method == "POST" or (data is not None and method is None)
        body = data if isinstance(data, (bytes, type(None))) else urllib.parse.urlencode(data).encode()
        js = lambda obj, code=200: {"code": code, "s": 0.01, "body": json.dumps(obj).encode(), "h": h}
        if path.startswith("/wp-login.php"):
            return {"code": 302 if post else 200, "s": 0.01, "body": b"", "h": h}
        if "action=rest-nonce" in path:
            return {"code": 200, "s": 0.01, "body": b"abcdef1234", "h": h}
        if route == "/wp/v2/pages" and post:
            self.pages = getattr(self, "pages", {})
            pid = 900 + len(self.pages)
            self.pages[pid] = None
            return js({"id": pid}, 201)
        if path.startswith("/wp-admin/post.php") and "action=elementor" in path:
            return {"code": 200, "s": 0.01, "body": b'var elementorCommonConfig = {"ajax":{"url":"https:\\/\\/x\\/wp-admin\\/admin-ajax.php","nonce":"abcdef1234"}};', "h": h}
        if path == "/wp-admin/admin-ajax.php" and isinstance(data, dict) and data.get("action") == "elementor_ajax":
            ok = data.get("_nonce") == "abcdef1234"
            if ok and self.f.get("elementor_saves", True):
                el = json.loads(data["actions"])["save_builder"]["data"]["elements"]
                self.pages[int(data["editor_post_id"])] = el[0]["elements"][0]["settings"]["title"]
            return js({"success": ok, "data": {"responses": {"save_builder": {"success": ok}}}})
        if path.startswith("/?page_id="):
            pid = int(path.split("page_id=")[1].split("&")[0])
            mark = (getattr(self, "pages", {}) or {}).get(pid)
            body = ('<div class="elementor-widget-heading"><h2>%s</h2></div>' % mark).encode() if mark else b"<p>empty</p>"
            return {"code": 200, "s": 0.01, "body": body, "h": h}
        if route == "/wp/v2/plugins" and not post:
            return js([{"plugin": "%s/%s.php" % (s, s), "status": st} for s, st in self.plugins.items()])
        if route == "/wp/v2/plugins" and post:
            slug = json.loads(body)["slug"]
            if self.f["install_effect"]:
                self.plugins[slug] = "inactive"
            return js({"plugin": slug}, self.f["install_code"])
        if route and route.startswith("/wp/v2/plugins/"):
            slug = route.split("/")[4]
            self.plugins[slug] = json.loads(body)["status"]
            return js({"status": self.plugins[slug]})
        if route and route.startswith("/wp/v2/themes"):
            ts = [{"stylesheet": s, "status": st} for s, st in self.themes.items()]
            if "status=active" in path:
                ts = [t for t in ts if t["status"] == "active"]
            return js(ts)
        if path == "/_dbexport":
            if self.f.get("no_export"):
                return {"code": 404, "s": 0.01, "body": b"", "h": h}
            act = [s for s, st in self.plugins.items() if st == "active"] + list(self.f.get("option_extra", ()))
            ser = "a:%d:{%s}" % (len(act), "".join('i:%d;s:%d:"%s";' % (n, len("%s/%s.php" % (a, a)), "%s/%s.php" % (a, a)) for n, a in enumerate(act)))
            rows = [{"sql": "CREATE TABLE wp_options (x)"},
                    {"sql": 'INSERT INTO "wp_options" ("option_id", "option_name", "option_value", "autoload") VALUES (?, ?, ?, ?)', "params": [1, "active_plugins", ser, "yes"]}]
            return {"code": 200, "s": 0.01, "body": "\n".join(json.dumps(r) for r in rows).encode(), "h": h}
        if path == "/_evict":
            if self.f.get("no_evict"):
                return {"code": 404, "s": 0.01, "body": b"", "h": h}
            if self.f["evict_drops"]:
                self.plugins = {k: v for k, v in self.plugins.items() if k == "woocommerce"}
            return js({"evicting": True})
        if route == "/wc/store/v1/products":
            return js([{"id": 11}])
        if route == "/wc/store/v1/cart":
            r = js({}); r["h"] = {**h, "Nonce": "n1"}; return r
        if route == "/wc/store/v1/cart/add-item":
            return js({}, 201)
        if route == "/wc/store/v1/checkout":
            if self.f["order_saved"]:
                self.orders.add(7)
            return js({"order_id": 7})
        if route and route.startswith("/wc/v3/orders/"):
            return js({"id": 7}) if 7 in self.orders else js({"code": "nope"}, 404)
        if path.startswith("/wp-admin/plugin-install.php"):
            return {"code": 200, "s": 0.01, "body": b'<form><input type="hidden" name="_wpnonce" value="abcdef1234"></form>', "h": h}
        if path.startswith("/wp-admin/update.php"):
            return {"code": 200, "s": 0.01, "body": b"<p>The uploaded file exceeds the limit.</p>", "h": h}
        if path.startswith("/wp-admin/options.php") or (post and "wc-settings" in path):
            return {"code": 302, "s": 0.01, "body": b"", "h": h}
        if path.startswith("/wp-admin/"):
            page = (b'<body class="wp-admin"><div id="wpbody-content"><form method="post" action="options.php">'
                    b'<input type="hidden" name="_wpnonce" value="x"><input name="opt" value="1">'
                    b'<input type="checkbox" name="off" value="1"></form></div></body>')
            return {"code": 200, "s": 0.01, "body": page, "h": h}
        return {"code": 404, "s": 0.01, "body": b"", "h": h}


def run_phase(fake, phase, only):
    buf = io.StringIO()
    G.OUT = buf
    G.ROWS.clear()
    G.instrument(fake)
    o = G.login()
    state = {}
    for item in G.items(only=only):
        G.CTX.clear(); G.CTX.update({"phase": phase, "item": item["slug"], "kind": item["kind"]})
        {"install": G.phase_install, "function": G.phase_function}[phase](o, item, state)
    lines = [json.loads(l) for l in buf.getvalue().splitlines()]
    return lines, state


def report_of(lines, logs=None):
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
        f.write("\n".join(json.dumps(l) for l in lines))
    try:
        return G.report([f.name], logs)
    finally:
        os.remove(f.name)


def item(rep, slug):
    return next(i for i in rep["items"] if i["item"] == slug)


def t_classes():
    assert G.classify(True, True) == "ok/ok" and G.classify(False, False) == "fail/fail"
    assert G.classify(False, True) == "fail/changed" and G.classify(True, False) == "ok/unchanged"


def t_clean_install():
    lines, state = run_phase(FakeWP(), "install", ["advanced-custom-fields"])
    w = [l for l in lines if l["ev"] == "write"]
    assert [x["cls"] for x in w] == ["ok/ok"], w
    steps = {l["step"]: l["ok"] for l in lines if l["ev"] == "step"}
    assert steps == {"install": True, "reset": True}, steps
    r = item(report_of(lines), "advanced-custom-fields")
    assert r["disagreements"] == 0 and r["firstFail"] is None and r["allPassed"], r


def t_fail_changed():
    lines, _ = run_phase(FakeWP(install_code=500), "install", ["advanced-custom-fields"])
    r = item(report_of(lines), "advanced-custom-fields")
    assert r["writes"]["fail/changed"] == 1 and r["disagreements"] == 1, r


def t_ok_unchanged():
    # The fallback is deterministic here: a pinned zip is present (stubbed), the upload is tried
    # and refused. Without a zip, the run records a note instead (checked below).
    real = G.zip_bytes
    G.zip_bytes = lambda item: b"PK\x05\x06" + b"\x00" * 18
    try:
        lines, _ = run_phase(FakeWP(install_effect=False), "install", ["advanced-custom-fields"])
    finally:
        G.zip_bytes = real
    r = item(report_of(lines), "advanced-custom-fields")
    vias = [l.get("via") for l in lines if l["ev"] == "write"]
    assert vias == ["rest /wp/v2/plugins", "upload form"], vias
    assert r["writes"]["ok/unchanged"] == 1 and r["writes"]["fail/fail"] == 1 and r["disagreements"] == 1 and r["firstFail"] == "install", r
    G.zip_bytes = lambda item: None
    try:
        lines2, _ = run_phase(FakeWP(install_effect=False), "install", ["advanced-custom-fields"])
    finally:
        G.zip_bytes = real
    assert any(l.get("step") == "install-upload" and "no pinned zip" in l.get("note", "") for l in lines2), "no note without a zip"


def t_reset_loses():
    lines, state = run_phase(FakeWP(evict_drops=True), "install", ["advanced-custom-fields"])
    r = item(report_of(lines), "advanced-custom-fields")
    assert r["firstFail"] == "reset" and state["advanced-custom-fields"]["afterReset"] is False, (r, state)
    assert ("POST", "/_evict") in [(m, p) for m, p in G.RAW.seen], "no /_evict"


def t_write_loss_counted():
    lines, _ = run_phase(FakeWP(write_loss_path="rest_route=/wp/v2/plugins"), "install", ["advanced-custom-fields"])
    r = item(report_of(lines), "advanced-custom-fields")
    assert r["writeLossHeaders"] >= 1, r
    lines2, _ = run_phase(FakeWP(), "install", ["advanced-custom-fields"])
    assert item(report_of(lines2), "advanced-custom-fields")["writeLossHeaders"] == 0, "control counted write-loss"


def t_woo_control():
    lines, _ = run_phase(FakeWP(), "function", ["woocommerce"])
    order = [l for l in lines if l["ev"] == "write" and l["what"] == "order"]
    assert order and order[0]["cls"] == "ok/ok", order
    lines2, _ = run_phase(FakeWP(order_saved=False), "function", ["woocommerce"])
    order2 = [l for l in lines2 if l["ev"] == "write" and l["what"] == "order"]
    assert order2 and order2[0]["cls"] == "ok/unchanged", order2
    st = {(l["step"], l.get("page")): l["ok"] for l in lines if l["ev"] == "step"}
    assert st[("settings", None)] is True and st[("job", None)] is True, st


def t_function_plugin():
    fake = FakeWP()
    fake.plugins["advanced-custom-fields"] = "inactive"
    lines, _ = run_phase(fake, "function", ["advanced-custom-fields"])
    ws = {l["what"]: l["cls"] for l in lines if l["ev"] == "write"}
    assert ws.get("activate") == "ok/ok" and ws.get("deactivate") == "ok/ok", ws
    assert fake.plugins["advanced-custom-fields"] == "inactive", "left active: the solo profile needs it off"


def t_one_seo_plugin():
    fake = FakeWP()
    fake.plugins["wordpress-seo"] = "inactive"
    fake.plugins["seo-by-rank-math"] = "active"
    lines, _ = run_phase(fake, "function", ["wordpress-seo"])
    st = [l for l in lines if l["ev"] == "step"]
    assert st and st[0].get("refused", "").startswith("another SEO plugin is active: seo-by-rank-math"), st
    assert not any(l["ev"] == "write" for l in lines), "something was written after the refusal"
    assert fake.plugins["wordpress-seo"] == "inactive", "Yoast was activated beside Rank Math"
    # Control: with Rank Math inactive, Yoast runs (and is deactivated after).
    fake2 = FakeWP()
    fake2.plugins["wordpress-seo"] = "inactive"
    fake2.plugins["seo-by-rank-math"] = "inactive"
    lines2, _ = run_phase(fake2, "function", ["wordpress-seo"])
    ws = {l["what"]: l["cls"] for l in lines2 if l["ev"] == "write"}
    assert ws.get("activate") == "ok/ok" and fake2.plugins["wordpress-seo"] == "inactive", ws


def t_approach_a_no_evict():
    lines, state = run_phase(FakeWP(no_evict=True), "install", ["advanced-custom-fields"])
    st = [l for l in lines if l["ev"] == "step" and l["step"] == "reset"]
    assert st and st[0]["ok"] is None and "not on this path" in st[0]["note"], st
    r = item(report_of(lines), "advanced-custom-fields")
    assert r["firstFail"] is None, r


def t_request_classes():
    C = G.request_class
    cases = [
        (("GET", "/wp-admin/edit.php?post_type=page"), "admin-page"),
        (("POST", "/wp-admin/options.php", {"a": 1}), "admin-write"),
        (("POST", "/wp-admin/admin-ajax.php", {"action": "heartbeat"}), "admin-ajax:heartbeat"),
        (("POST", "/wp-admin/admin-ajax.php", b"action=wordfence_scan&x=1"), "admin-ajax:wordfence_scan"),
        (("GET", "/wp-admin/admin-ajax.php?action=rest-nonce"), "admin-ajax:rest-nonce"),
        (("POST", "/wp-admin/admin-ajax.php", {"action": "elementor_ajax", "actions": '{"save_builder":{}}'}), "editor-save"),
        (("POST", "/wp-admin/admin-ajax.php", {"action": "elementor_ajax", "actions": '{"get_document_config":{}}'}), "admin-ajax:elementor_ajax"),
        (("POST", "/?rest_route=/wp/v2/pages/12"), "editor-save"),
        (("DELETE", "/?rest_route=/wp/v2/pages/12"), "rest-write"),
        (("POST", "/?rest_route=/wp/v2/plugins"), "rest-write"),
        (("GET", "/?rest_route=/wp/v2/types"), "rest-read"),
        (("GET", "/wp-json/wp/v2/posts"), "rest-read"),
        (("GET", "/wp-login.php"), "login"),
        (("POST", "/_evict"), "operator"),
        (("GET", "/?page_id=3"), "front"),
    ]
    bad = [(a, want, C(*a)) for a, want in cases if C(*a) != want]
    assert not bad, bad


def t_seo_guard_option():
    # pft1a, 2026-11-13: Yoast left the build, so the REST list had no Yoast, but the option kept it.
    fake = FakeWP(option_extra=["wordpress-seo"])
    fake.plugins["seo-by-rank-math"] = "inactive"
    lines, _ = run_phase(fake, "function", ["seo-by-rank-math"])
    st = [l for l in lines if l.get("ev") == "step" and l.get("step") == "activate"]
    assert st and st[0].get("refused", "").startswith("another SEO plugin is active: wordpress-seo (in the active_plugins option"), st
    assert fake.plugins["seo-by-rank-math"] == "inactive", "Rank Math was activated beside an option-only Yoast"
    # control: the same site with a clean option runs Rank Math
    fake2 = FakeWP()
    fake2.plugins["seo-by-rank-math"] = "inactive"
    lines2, _ = run_phase(fake2, "function", ["seo-by-rank-math"])
    st2 = [l for l in lines2 if l.get("ev") == "step" and l.get("step") == "activate"]
    assert st2 and st2[0].get("ok") is True and not st2[0].get("refused"), st2
    assert not [l for l in lines2 if l.get("ev") == "guard"], "a readable option must not log a guard note"
    # no export (not b-dosql): the REST guard alone, and a note says so
    fake3 = FakeWP(no_export=True, option_extra=["wordpress-seo"])
    fake3.plugins["seo-by-rank-math"] = "inactive"
    lines3, _ = run_phase(fake3, "function", ["seo-by-rank-math"])
    assert [l for l in lines3 if l.get("ev") == "guard" and "REST list only" in l.get("note", "")], "no note when the option was not read"


def t_stack_profile():
    try:
        G.STACK = True
        fake = FakeWP()
        fake.plugins["advanced-custom-fields"] = "inactive"
        lines, _ = run_phase(fake, "function", ["advanced-custom-fields"])
        assert fake.plugins["advanced-custom-fields"] == "active", "the stack profile deactivated the item"
        assert not any(l.get("what") == "deactivate" for l in lines), "a deactivate was written"
    finally:
        G.STACK = False
    # stack-activate keeps the one-SEO guard
    fake = FakeWP()
    fake.plugins.update({"wordpress-seo": "inactive", "seo-by-rank-math": "active"})
    buf = io.StringIO(); G.OUT = buf; G.instrument(fake); o = G.login()
    G.phase_stack_activate(o, {"kind": "plugin", "slug": "wordpress-seo", "version": "", "sha": ""}, {})
    st = [json.loads(l) for l in buf.getvalue().splitlines() if '"ev": "step"' in l]
    assert st and st[-1].get("refused", "").startswith("another SEO plugin is active"), st
    assert fake.plugins["wordpress-seo"] == "inactive"


def t_elementor_job():
    fake = FakeWP()
    fake.plugins["elementor"] = "active"
    buf = io.StringIO(); G.OUT = buf; G.instrument(fake); o = G.login()
    ok, info = G.elementor_job(o)
    ws = [json.loads(l) for l in buf.getvalue().splitlines() if '"ev": "write"' in l]
    assert ok is True and ws and ws[-1]["cls"] == "ok/ok", (ok, ws)
    cls = [json.loads(l)["class"] for l in buf.getvalue().splitlines() if '"ev": "req"' in l]
    assert "editor-save" in cls, cls
    # control: the save answers success but the page does not render the heading -> ok/unchanged
    fake2 = FakeWP(elementor_saves=False)
    buf = io.StringIO(); G.OUT = buf; G.instrument(fake2); o = G.login()
    ok, _ = G.elementor_job(o)
    ws = [json.loads(l) for l in buf.getvalue().splitlines() if '"ev": "write"' in l]
    assert ok is False and ws[-1]["cls"] == "ok/unchanged", ws


def t_report_classes():
    lines, _ = run_phase(FakeWP(write_loss_path="rest_route=/wp/v2/plugins"), "install", ["advanced-custom-fields"])
    rep = report_of(lines)
    c = rep["classes"]
    assert c["rest-write"]["n"] >= 1 and c["rest-write"]["writeLoss"] >= 1 and c["login"]["n"] == 2, c
    assert all("failRate" in v and "wasmMedian" in v for v in c.values()), c


def t_tier1_lists():
    t1 = G.items(os.path.join(HERE, "tier1.txt"))
    assert [i["slug"] for i in t1] == ["elementor", "wordpress-seo", "contact-form-7", "advanced-custom-fields", "wordfence", "updraftplus", "astra"], t1
    assert not any(i["kind"] == "control" for i in t1), "tier 1 has no WooCommerce control"
    g2 = {i["slug"]: (i["version"], i["sha"]) for i in G.items()}
    for path in ("tier1.txt", "tier1-alt.txt"):
        for i in G.items(os.path.join(HERE, path)):
            if i["slug"] in g2:
                assert g2[i["slug"]] == (i["version"], i["sha"]), "%s pins differ from gate2.txt" % i["slug"]
    # tier1-build.txt (the built-in fallback, suite.txt format) holds the same pins as tier1.txt.
    t1p = {i["slug"]: (i["version"], i["sha"]) for i in t1}
    build = {l.split()[0]: tuple(l.split()[1:3]) for l in open(os.path.join(HERE, "tier1-build.txt")) if l.strip() and not l.startswith("#")}
    assert set(build) == {"elementor", "wordpress-seo", "advanced-custom-fields", "wordfence", "updraftplus"}, sorted(build)
    assert all(build[s] == t1p[s] for s in build), "tier1-build.txt pins differ from tier1.txt"
    alt = [i["slug"] for i in G.items(os.path.join(HERE, "tier1-alt.txt"))]
    assert alt == ["seo-by-rank-math", "wpforms-lite", "hello-elementor"], alt


def t_headers_only():
    lines, _ = run_phase(FakeWP(), "install", ["advanced-custom-fields"])
    reqs = [l for l in lines if l["ev"] == "req"]
    assert reqs, "no request recorded"
    for r in reqs:
        assert "body" not in r and "cookie" not in json.dumps(r).lower() and "pw" not in json.dumps(r), r
    assert all("?" not in r["path"] for r in reqs), "a query string was recorded"


def t_report_prediction_and_logs():
    lines, _ = run_phase(FakeWP(evict_drops=True), "install", ["advanced-custom-fields"])
    with tempfile.NamedTemporaryFile("w", delete=False) as f:
        f.write("x Durable Object's isolate exceeded its memory limit and was reset.\nother\nexceeded its memory limit\n")
    try:
        rep = report_of(lines, f.name)
    finally:
        os.remove(f.name)
    assert rep["totals"]["memoryResetLogLines"] == 2, rep["totals"]
    assert "install or reset fails" in item(rep, "advanced-custom-fields")["predicted"]


def t_form_fields():
    html = (b'<form method="get"><input name="s"></form><form method="post" action="options.php">'
            b'<input name="a" value="1"><input type="checkbox" name="b" value="1"><input type="checkbox" name="c" value="2" checked>'
            b'<textarea name="d">hi</textarea><select name="e"><option value="x">x</option><option value="y" selected>y</option></select>'
            b'<input type="file" name="f"></form>')
    action, f = G.form_fields(html)
    assert action == "options.php" and f == {"a": "1", "c": "2", "d": "hi", "e": "y"}, (action, f)
    assert G.form_fields(b"<form method=get></form>") == (None, None)


def t_items():
    its = G.items()
    assert its[0]["slug"] == "woocommerce" and its[0]["kind"] == "control"
    assert {"elementor", "wordpress-seo", "seo-by-rank-math", "astra", "storefront"} <= {i["slug"] for i in its}
    assert all(re.fullmatch(r"[0-9a-f]{64}", i["sha"]) for i in its[1:])
    # gate2-build.txt (the track-B build list, suite.txt format for fetch.sh) holds the same pins.
    build = {l.split()[0]: tuple(l.split()[1:3]) for l in open(os.path.join(HERE, "gate2-build.txt")) if l.strip() and not l.startswith("#")}
    want = {i["slug"]: (i["version"], i["sha"]) for i in its if i["kind"] == "plugin"}
    assert build == want, "gate2-build.txt and gate2.txt pins differ"


for name, fn in [("the four read-back classes", t_classes), ("control: a clean install is ok/ok and survives the reset", t_clean_install),
                 ("an install that answers 500 but installs is fail/changed (a disagreement)", t_fail_changed),
                 ("an install that answers 201 but installs nothing is ok/unchanged, and the upload fallback is tried", t_ok_unchanged),
                 ("an install lost at /_evict fails at the reset step", t_reset_loses),
                 ("x-write-loss is counted, and not counted on a clean run", t_write_loss_counted),
                 ("the WooCommerce control: an order is ok/ok, and a lost order is ok/unchanged", t_woo_control),
                 ("a plugin is activated, run, and deactivated again (solo)", t_function_plugin),
                 ("one SEO plugin per site: refused when the other is active; control runs", t_one_seo_plugin),
                 ("one-SEO guard reads the active_plugins option: a plugin with no files still counts", t_seo_guard_option),
                 ("an approach-A site with no /_evict: the reset step is not on this path, not a fail", t_approach_a_no_evict),
                 ("the recording is headers only: no body, no cookie, no password, no query", t_headers_only),
                 ("every request is classed for the admin-container classifier", t_request_classes),
                 ("tier 1 stack: items stay active, and stack-activate keeps the one-SEO guard", t_stack_profile),
                 ("Elementor's job: editor, save_builder, render; a save that does not render is ok/unchanged", t_elementor_job),
                 ("the report has a class table with fail rate, resets, write-loss and memory", t_report_classes),
                 ("the tier 1 lists: seven items, no WooCommerce, pins equal gate2.txt", t_tier1_lists),
                 ("the report shows the prediction and counts the log reset lines", t_report_prediction_and_logs),
                 ("the settings form parser", t_form_fields), ("the item list", t_items)]:
    ok(name, fn)
G.OUT = sys.stdout
print("cases_run=%d failed=%d" % (run, failed))
sys.exit(1 if failed else 0)
