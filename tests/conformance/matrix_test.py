#!/usr/bin/env python3
"""matrix.py (#759): the run's results into support-matrix cells. Run: python3 -I tests/conformance/matrix_test.py"""
import json, os, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import matrix as M
import runner

fails = 0
def ok(label, cond, detail=""):
    global fails
    print(("PASS " if cond else "FAIL ") + label + (("  (" + str(detail)[:200] + ")") if (detail and not cond) else ""))
    fails += 0 if cond else 1

AREAS = M.parse_areas("""
# a comment
wp  specs/dashboard.test.js          WordPress | Install, pages, login, dashboard
wc  order/order-coupon.spec.ts       WooCommerce | Coupons
wc  order/*                          WooCommerce | Orders and HPOS
wc  shipping/*                       WooCommerce | Shipping
""")
CITE = "conformance `c1` 2026-11-18, build `b1`, cache on"

# 1. The map: the first matching line wins; a file no line maps is None.
ok("area: a specific file above its directory wins", M.area_of("wc", "order/order-coupon.spec.ts", AREAS) == ("WooCommerce", "Coupons"))
ok("area: the directory glob", M.area_of("wc", "order/order-refund.spec.ts", AREAS) == ("WooCommerce", "Orders and HPOS"))
ok("area: * matches across directories", M.area_of("wc", "order/sub/x.spec.ts", AREAS) == ("WooCommerce", "Orders and HPOS"))
ok("area: another suite's line does not match", M.area_of("wp", "order/order-refund.spec.ts", AREAS) is None)
ok("area: unmapped is None", M.area_of("wc", "basic/basic.spec.ts", AREAS) is None)
try:
    M.parse_areas("wc order/* Coupons")
    ok("area: a line without section | feature is refused", False)
except ValueError:
    ok("area: a line without section | feature is refused", True)

def R(verdict, n=1, f="order/a.spec.ts"):
    return [{"file": f, "title": "t%d" % i, "verdict": verdict, "status": "x", "baseline": "y"} for i in range(n)]

# 2. Cells.
w, t = M.cell(R("pass", 3), CITE)
ok("cell: all pass is yes, with the citation", w == "yes" and CITE in t and "3 pass" in t, t)
w, t = M.cell(R("pass", 3) + R("OURS", 1), CITE)
ok("cell: a test that fails only here is limited, counted", w == "limited" and "1 of 4" in t and CITE in t, t)
w, t = M.cell(R("OURS", 2) + R("skipped", 1), CITE)
ok("cell: every run test fails only here is no", w == "no" and CITE in t, t)
w, t = M.cell(R("pass", 2) + R("check", 1), CITE)
ok("cell: a result that needs a look is not measured, never yes", w == "not measured" and "1 of 3" in t, t)
w, t = M.cell(R("pass", 2) + R("flaky", 1), CITE)
ok("cell: a flaky result is not measured", w == "not measured", t)
w, t = M.cell(R("upstream", 2) + R("skipped", 1), CITE)
ok("cell: nothing passed, even on stock, is not measured", w == "not measured", t)
w, t = M.cell(R("pass", 2) + R("upstream", 1) + R("ours-passes", 1), CITE)
ok("cell: fails on stock too, and passes only here, still yes, both counted", w == "yes" and "1 fail on stock too" in t and "1 pass only here" in t, t)
try:
    M.cell(R("pass", 1), "")
    ok("cell: no yes without a citation", False)
except ValueError:
    ok("cell: no yes without a citation", True)

# 3. The verdict comes from runner.compare_rows, the one implementation.
ours = [{"file": "order/a.spec.ts", "title": "x", "project": "p", "status": "unexpected"}, {"file": "basic/b.spec.ts", "title": "y", "project": "p", "status": "expected"}]
base = [{"file": "order/a.spec.ts", "title": "x", "project": "p", "status": "expected"}, {"file": "basic/b.spec.ts", "title": "y", "project": "p", "status": "expected"}]
feats, unmapped = M.feature_rows([("wc", ours, base)], AREAS)
ok("rows: the verdict is runner.compare_rows'", feats[("WooCommerce", "Orders and HPOS")][0]["verdict"] == "OURS")
ok("rows: an unmapped spec is reported, with its suite", unmapped == [("wc", "basic/b.spec.ts")], unmapped)

# 4. The route runner.
res = {"routes": {"/wp/v2/posts": {"namespace": "wp/v2"}, "/wc/v3/orders": {"namespace": "wc/v3"}, "/wc/v3/coupons": {"namespace": "wc/v3"}},
       "failures": [{"route": "/wc/v3/coupons", "as": "admin GET", "status": 500, "kind": "server_error"}], "missing_core": []}
rc = M.routes_cells(res, CITE)
ok("routes: wp/v2 all answer is yes", rc[("WordPress", "REST API")][0] == "yes", rc)
ok("routes: a failing wc route is limited, counted", rc[("WooCommerce", "WooCommerce REST API")][0] == "limited" and "1 of 2" in rc[("WooCommerce", "WooCommerce REST API")][1], rc)

# 5. --apply: only the tier's column changes, a new feature becomes a row, the not-run block is replaced.
MD = """# Support matrix

## WordPress

| feature | Free DO | Paid DO | WfP | Hyperdrive |
|---|---|---|---|---|
| Install, pages, login, dashboard | yes (#638) | old paid | old wfp | not measured |
| Cron | not measured | not measured | not measured | not measured |

## WooCommerce

| feature | Free DO | Paid DO | WfP | Hyperdrive |
|---|---|---|---|---|
| Coupons | not measured | not measured | not measured | not measured |

## Not measured, and what will measure it

tail text
"""
cells = {("WordPress", "Install, pages, login, dashboard"): ("yes", "yes (conformance `c1` d, build `b`, cache on: 2 pass)"), ("WooCommerce", "Shipping"): ("limited", "limited: 1 of 2 tests fail here and pass on stock (conformance `c1` d, build `b`, cache on)")}
block = "### Not run in conformance `c1`\n\n- wp `specs/install.test.js`: a reason\n"
new, changes = M.apply_md(MD, "Paid DO", cells, block)
ok("apply: a cell with measured text KEEPS it; the run is appended", "| Install, pages, login, dashboard | yes (#638) | old paid; conformance run: yes (conformance `c1` d, build `b`, cache on: 2 pass) | old wfp | not measured |" in new, new)
ok("apply: the other columns and rows are untouched", "| Cron | not measured | not measured | not measured | not measured |" in new and "| Coupons | not measured | not measured | not measured | not measured |" in new)
ok("apply: a new feature is a new row in its section, not measured elsewhere", "| Shipping | not measured | limited: 1 of 2 tests fail here and pass on stock (conformance `c1` d, build `b`, cache on) | not measured | not measured |" in new, new)
ok("apply: every change is reported old to new", ("WordPress", "Install, pages, login, dashboard", "old paid", "old paid; conformance run: yes (conformance `c1` d, build `b`, cache on: 2 pass)") in changes and ("WooCommerce", "Shipping", None, "limited: 1 of 2 tests fail here and pass on stock (conformance `c1` d, build `b`, cache on)") in changes, changes)
ok("apply: the not-run block sits between its markers", M.NOTRUN_BEGIN in new and M.NOTRUN_END in new and "specs/install.test.js" in new)
again, ch2 = M.apply_md(new, "Paid DO", cells, block)
ok("apply: applying twice changes nothing more", again == new and ch2 == [], ch2)
ok("apply: the text after the tables is kept", "tail text" in new)
try:
    M.apply_md(MD, "Paid", cells, block)
    ok("apply: an unknown tier is refused", False)
except ValueError:
    ok("apply: an unknown tier is refused", True)
# A known limit is never upgraded by a passing suite: the limit stays first, the run is appended.
LIM = MD.replace("| Install, pages, login, dashboard | yes (#638) | old paid |", "| Install, pages, login, dashboard | yes (#638) | limited: memory ceiling (#768) |")
lim, _ = M.apply_md(LIM, "Paid DO", {("WordPress", "Install, pages, login, dashboard"): ("yes", "yes (conformance `c1` d, build `b`, cache on: 2 pass)")}, block)
ok("apply: a limited cell stays limited; the passing run is appended", "| limited: memory ceiling (#768); conformance run: yes (conformance `c1`" in lim, lim)
# A later run replaces only what an earlier run wrote, never the measured text.
lim2, ch = M.apply_md(lim, "Paid DO", {("WordPress", "Install, pages, login, dashboard"): ("limited", "limited: 1 of 2 tests fail here and pass on stock (conformance `c2` d, build `b`, cache on)")}, block)
row2 = [l for l in lim2.split("\n") if l.startswith("| Install")][0]
ok("apply: a later run replaces its own appended part only", "limited: memory ceiling (#768); conformance run: limited: 1 of 2" in row2 and "`c1`" not in row2, row2)
# A cell that holds only an earlier run's text is replaced whole.
sole, _ = M.apply_md(new, "Paid DO", {("WooCommerce", "Shipping"): ("yes", "yes (conformance `c3` d, build `b`, cache on: 2 pass)")}, block)
ok("apply: a cell that is only an earlier run's text is replaced whole", "| Shipping | not measured | yes (conformance `c3` d, build `b`, cache on: 2 pass) |" in sole, sole)
NM = MD.replace("| Coupons | not measured | not measured |", "| Coupons | not measured | not measured |")
nm, _ = M.apply_md(NM, "Paid DO", {("WooCommerce", "Coupons"): ("yes", "yes (C2)")}, block)
ok("apply: a not measured cell is replaced", "| Coupons | not measured | yes (C2) | not measured | not measured |" in nm, nm)
# DOWNGRADE (the lead's ruling, 2026-11-17): a run never upgrades a cell, but it MUST downgrade one. An OURS failure
# where the cell leads with "yes" makes it lead with limited (or no), keeps the old text after it, names the specs.
YES = MD.replace("| Install, pages, login, dashboard | yes (#638) | old paid |", "| Install, pages, login, dashboard | yes (#638) | yes (results.md 2026-11-07) |")
rows_bad = R("pass", 3, "specs/dashboard.test.js") + R("OURS", 1, "specs/hello.test.js")
dn, _ = M.apply_md(YES, "Paid DO", {("WordPress", "Install, pages, login, dashboard"): M.cell(rows_bad, CITE)}, block)
row = [l for l in dn.split("\n") if l.startswith("| Install")][0]
paid = M._split_row(row)[2]
ok("downgrade: a yes cell with an OURS failure no longer leads with yes", not paid.startswith("yes") and paid.startswith("limited"), paid)
ok("downgrade: the old text is kept after the run's verdict", "before this run: yes (results.md 2026-11-07)" in paid, paid)
ok("downgrade: the run's part names the failing spec", "specs/hello.test.js" in paid, paid)
alln, _ = M.apply_md(YES, "Paid DO", {("WordPress", "Install, pages, login, dashboard"): M.cell(R("OURS", 2, "specs/hello.test.js"), CITE)}, block)
paid = M._split_row([l for l in alln.split("\n") if l.startswith("| Install")][0])[2]
ok("downgrade: nothing passed makes it lead with no", paid.startswith("no:") and "before this run: yes (results.md" in paid, paid)
# A later run replaces only its own part: a passing run lifts the downgrade, and keeps the old yes first.
up, _ = M.apply_md(dn, "Paid DO", {("WordPress", "Install, pages, login, dashboard"): M.cell(R("pass", 4, "specs/hello.test.js"), CITE)}, block)
paid = M._split_row([l for l in up.split("\n") if l.startswith("| Install")][0])[2]
ok("downgrade: a later passing run lifts it, the old yes leads again", paid.startswith("yes (results.md 2026-11-07); conformance run: yes (") and "before this run" not in paid, paid)
again, _ = M.apply_md(dn, "Paid DO", {("WordPress", "Install, pages, login, dashboard"): M.cell(rows_bad, CITE)}, block)
paid = M._split_row([l for l in again.split("\n") if l.startswith("| Install")][0])[2]
ok("downgrade: a later failing run replaces its part, never stacks", paid.count("before this run") == 1 and paid.count("specs/hello.test.js") == 1, paid)
# A limited cell plus a failing run keeps its own lead (it is already not yes); the run is appended, specs named.
lm, _ = M.apply_md(LIM, "Paid DO", {("WordPress", "Install, pages, login, dashboard"): M.cell(rows_bad, CITE)}, block)
paid = M._split_row([l for l in lm.split("\n") if l.startswith("| Install")][0])[2]
ok("a limited cell plus an OURS failure keeps its lead; the run is appended with the spec", paid.startswith("limited: memory ceiling (#768); conformance run: limited") and "specs/hello.test.js" in paid, paid)
w, t = M.cell(R("pass", 1) + R("OURS", 2, "order/x.spec.ts") + R("OURS", 1, "order/y.spec.ts"), CITE)
ok("cell: a limited cell names its failing specs once each", "order/x.spec.ts" in t and "order/y.spec.ts" in t and t.count("order/x.spec.ts") == 1, t)
ok("apply: a pipe in a cell is escaped, so the table keeps its shape", "a \\| b" in M.apply_md(MD, "WfP", {("WooCommerce", "Coupons"): ("yes", "yes a | b")}, block)[0])

# 6. The not-run block: every excluded spec, with its reason, from exclude/<suite>.txt.
b = M.notrun_block({"wp": [("specs/install.test.js", "rewrites wp-config.php")]}, "c1")
ok("not run: each excluded spec and its reason", "`specs/install.test.js`" in b and "rewrites wp-config.php" in b and "c1" in b, b)
bt = M.notrun_block({"wc": runner.read_excludes("wc")}, "c1")
# A tier-scoped row (#1119) is in that tier's not-run block only, with its tier shown.
pl = "api-tests/products/product-list.test.ts"
bh = M.notrun_block({"wc-api": runner.read_excludes("wc-api", "Hyperdrive")}, "h1")
bp = M.notrun_block({"wc-api": runner.read_excludes("wc-api", "Paid DO")}, "p1")
ok("tier row in the Hyperdrive not-run block, marked [Hyperdrive]", ("[Hyperdrive] " + pl) in bh, bh[-300:])
ok("tier row NOT in the Paid DO not-run block", pl not in bp, bp[-300:])
ok("not run: paypal stays a file row", "`paypal/paypal.spec.ts`" in bt and "needs wp-env" in bt, bt)
ok("not run: the email title names the file and the test", "`email/settings-email.spec.ts :: WooCommerce Email Settings > Send email preview`" in bt and "wp-mail-queue.php returns true" in bt, bt)

# 7. The CLI end to end, on files, and it never reads <run-dir>/env.
with tempfile.TemporaryDirectory() as d:
    po, pb = os.path.join(d, "ours.json"), os.path.join(d, "base.json")
    json.dump(ours, open(po, "w")); json.dump(base, open(pb, "w"))
    md = os.path.join(d, "m.md"); open(md, "w").write(MD)
    rcode = M.main(["cells", "--tier", "Paid DO", "--run-tag", "c1", "--date", "2026-11-18", "--build", "b1", "--cache", "on",
                    "--suite", "wc=%s:%s" % (po, pb), "--areas-text", "wc order/* WooCommerce | Orders and HPOS", "--apply", md, "--json", os.path.join(d, "o.json")])
    out = open(md).read()
    ok("cli: applies the cell to the file (its only test fails here, so no)", "| Orders and HPOS | not measured | no: 1 of 1" in out, out[-400:])
    ok("cli: the json report holds the cells and the unmapped specs", json.load(open(os.path.join(d, "o.json")))["unmapped"] == [["wc", "basic/b.spec.ts"]])
    ok("cli: exit 0 with an unmapped spec, without --strict", rcode == 0)
    rs = M.main(["cells", "--tier", "Paid DO", "--run-tag", "c1", "--date", "2026-11-18", "--build", "b1", "--cache", "on",
                 "--suite", "wc=%s:%s" % (po, pb), "--areas-text", "wc order/* WooCommerce | Orders and HPOS", "--strict"])
    ok("cli: --strict exits 1 on an unmapped spec", rs == 1)
    try:
        M.main(["cells", "--tier", "Paid DO", "--run-tag", "c1", "--date", "2026-11-18", "--build", "b1", "--cache", "on", "--suite", "wc=%s/env:%s" % (d, pb)])
        ok("cli: a path to a run's env file is refused (it holds passwords)", False)
    except SystemExit:
        ok("cli: a path to a run's env file is refused (it holds passwords)", True)

print("%d failing" % fails)
sys.exit(1 if fails else 0)
