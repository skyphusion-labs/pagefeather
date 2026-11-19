#!/usr/bin/env python3
"""The conformance run's results into the cells of docs/support-matrix.md (#759).

    matrix.py cells --tier "Paid DO" --run-tag <tag> --date YYYY-MM-DD --build <build id> --cache on|off \\
        --suite <suite>=<ours results.json>:<baseline results.json> [--suite ...] [--routes <routes.json>] \\
        [--areas areas.txt] [--json <report.json>] [--apply docs/support-matrix.md] [--strict]

The inputs are the files runner.py summarize wrote (one per run) and the route runner's result. The
verdict of each test is runner.py's own compare_rows, never a second one. areas.txt maps each spec
file to a matrix row. The run's identity (tier, tag, date, build, cache) comes in as arguments: this
never reads a run's env file, which holds the passwords, and it refuses a path to one.

A cell, per the matrix's own rules (docs/support-matrix.md, "How to read a cell"):
  yes            every test that ran passed here, or failed on stock too; at least one passed. Never
                 without the citation (the run tag, date, build and cache).
  limited        some tests fail here and pass on stock (verdict OURS), counted.
  no             every test that ran fails here and passes on stock.
  not measured   a result needs a look (check, flaky, absent from the baseline), or nothing passed,
                 even on stock. It is never turned into yes.
--apply changes only the given tier's column, for the features this run measured. A cell that says
"not measured" (or holds only an earlier run's text) is replaced. Any other cell is measured text, a
citation or a known limit, and is KEPT. A run never UPGRADES a cell: a passing run is appended as
"; conformance run: ...", so it never erases a limit it does not test (the block editor's memory
ceiling, the stock page's age). A run MUST DOWNGRADE one: OURS failures where the measured text leads
with "yes" put the run's limited or no first, naming the failing specs, and keep the old text after
"; before this run: ". A later run replaces its own part, so a fixed regression lifts the downgrade. A feature the
matrix does not have yet is added as a row of its section, "not measured" in the other columns.
Every change is printed old to new. The excluded specs (exclude/<suite>.txt) are written as a
"not run" block between two markers, replaced on each apply. Exit 1 with --strict when a spec maps
to no row, and when a test fails only here (OURS), so a run that needs a look is not quiet.
"""
import argparse, fnmatch, json, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import runner

TIERS = ("Free DO", "Paid DO", "WfP", "Hyperdrive")
SECTIONS = ("WordPress", "WooCommerce")
NOTRUN_BEGIN = "<!-- conformance: not run (matrix.py writes this block; do not edit by hand) -->"
NOTRUN_END = "<!-- conformance: end of not run -->"


def parse_areas(text):
    out = []
    for n, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^(\S+)\s+(\S+)\s+(WordPress|WooCommerce)\s*\|\s*(.+)$", line)
        if not m:
            raise ValueError("areas line %d: want <suite> <glob> <WordPress|WooCommerce> | <feature>: %r" % (n, line))
        out.append((m.group(1), m.group(2), m.group(3), m.group(4).strip()))
    return out


def area_of(suite, f, areas):
    for s, g, sec, feat in areas:
        if s == suite and fnmatch.fnmatchcase(f, g):
            return (sec, feat)
    return None


def feature_rows(pairs, areas):
    """pairs: [(suite, ours rows, baseline rows)]. Returns {(section, feature): [rows]}, [(suite, file)] unmapped."""
    feats, unmapped = {}, []
    for suite, ours, base in pairs:
        for r in runner.compare_rows(base, ours):
            a = area_of(suite, r["file"], areas)
            if a is None:
                if (suite, r["file"]) not in unmapped:
                    unmapped.append((suite, r["file"]))
                continue
            feats.setdefault(a, []).append(dict(r, suite=suite))
    return feats, unmapped


def _n(c, k):
    return c.get(k, 0)


def cell(rows, cite):
    if not cite:
        raise ValueError("a cell needs a citation (the matrix rule: no yes without one)")
    c = {}
    for r in rows:
        c[r["verdict"]] = c.get(r["verdict"], 0) + 1
    n = len(rows)
    ran = n - _n(c, "skipped")
    ours = _n(c, "OURS")
    look = n - sum(_n(c, k) for k in ("pass", "upstream", "ours-passes", "skipped", "OURS"))
    if ours:
        specs = sorted({r["file"] for r in rows if r["verdict"] == "OURS"})
        named = ", ".join("`%s`" % f for f in specs[:6]) + (" and %d more" % (len(specs) - 6) if len(specs) > 6 else "")
        word = "no" if ours == ran else "limited"
        return word, "%s: %d of %d tests fail here and pass on stock (%s): %s" % (word, ours, n, cite, named)
    if look:
        return "not measured", "not measured: %d of %d results need a look (%s)" % (look, n, cite)
    if not (_n(c, "pass") + _n(c, "ours-passes")):
        return "not measured", "not measured: no test passed, even on stock (%s)" % cite
    bits = ["%d pass" % _n(c, "pass")]
    if _n(c, "upstream"):
        bits.append("%d fail on stock too" % _n(c, "upstream"))
    if _n(c, "ours-passes"):
        bits.append("%d pass only here" % _n(c, "ours-passes"))
    if _n(c, "skipped"):
        bits.append("%d skipped" % _n(c, "skipped"))
    return "yes", "yes (%s: %s)" % (cite, ", ".join(bits))


def routes_cells(res, cite):
    """The route runner has no stock baseline: a failure is a failure. wp/v2 and the root go to REST API, wc* to
    WooCommerce REST API."""
    groups = {("WordPress", "REST API"): [], ("WooCommerce", "WooCommerce REST API"): []}
    ns_of = {route: (row.get("namespace") or "") for route, row in (res.get("routes") or {}).items()}
    def key(ns):
        return ("WooCommerce", "WooCommerce REST API") if ns.startswith("wc") else ("WordPress", "REST API") if (ns.startswith("wp/") or ns == "") else None
    for route, ns in ns_of.items():
        k = key(ns)
        if k:
            groups[k].append(route)
    failed = {f.get("route") for f in (res.get("failures") or [])}
    out = {}
    for k, routes in groups.items():
        if not routes:
            continue
        bad = sorted(r for r in routes if r in failed)
        if bad:
            out[k] = ("limited", "limited: %d of %d routes fail (%s; route runner)" % (len(bad), len(routes), cite))
        else:
            out[k] = ("yes", "yes (%s: route runner, %d routes, 0 failures)" % (cite, len(routes)))
    return out


def exclude_label(item):
    kind = getattr(item, "kind", None)
    if kind == "title":
        return "%s :: %s" % (item.path, item.title), item.reason
    if kind == "file":
        return item.path, item.reason
    pat, reason = item
    return pat, reason


def notrun_block(excludes, tag):
    lines = ["### Not run in conformance `%s`, and why" % tag, "",
             "These specs are excluded in `tests/conformance/exclude/` and are not a result either way.", ""]
    for suite in sorted(excludes):
        for item in excludes[suite]:
            pat, reason = exclude_label(item)
            lines.append("- %s `%s`: %s" % (suite, pat, reason or "no reason given"))
    return "\n".join(lines) + "\n"


APPENDED = "; conformance run: "
DOWNGRADED = "; before this run: "
_OWN = re.compile(r"^(yes|limited|no|not measured)[: (].*\(conformance `")


def merge(old, new):
    """A cell's new text. A cell that says "not measured", or holds only an earlier run's text, is replaced. Any
    other cell is measured text (a citation, a known limit): it is KEPT. A run never UPGRADES a cell: a passing run
    is appended after the measured text, so a passing suite never erases a limit it does not test. A run MUST
    DOWNGRADE one (the lead's ruling, 2026-11-17): when it finds OURS failures and the measured text leads with
    "yes", the run's limited or no leads, naming the failing specs, and the old text follows "; before this run: ",
    so an old yes never hides a regression. An earlier run's part is replaced on the next run, never stacked."""
    old = old.strip()
    head, sep, rest = old.partition(DOWNGRADED)
    if sep and _OWN.match(head):
        human = rest.strip()
    else:
        human = old.split(APPENDED, 1)[0].strip()
        if _OWN.match(human):
            human = ""
    if human in ("", "not measured"):
        return new
    if re.match(r"^(limited|no)\b", new) and re.match(r"^yes\b", human):
        return new + DOWNGRADED + human
    return human + APPENDED + new


def _esc(t):
    return t.replace("|", "\\|")


def _split_row(line):
    cells = re.split(r"(?<!\\)\|", line.strip())
    return [c.strip() for c in cells[1:-1]]


def apply_md(md, tier, cells, block):
    if tier not in TIERS:
        raise ValueError("unknown tier %r (want one of %s)" % (tier, ", ".join(TIERS)))
    lines = md.split("\n")
    changes = []
    want = {k: v for k, v in cells.items()}
    section, i = None, 0
    out = []
    while i < len(lines):
        line = lines[i]
        h = re.match(r"^## (.+)$", line)
        if h:
            section = h.group(1).strip()
        out.append(line)
        if section in SECTIONS and line.startswith("| feature |") and i + 1 < len(lines) and lines[i + 1].startswith("|---"):
            head = _split_row(line)
            if tier not in head:
                raise ValueError("the %s table has no %r column" % (section, tier))
            col = head.index(tier)
            out.append(lines[i + 1])
            i += 2
            seen = set()
            while i < len(lines) and lines[i].startswith("|"):
                row = _split_row(lines[i])
                feat = row[0]
                k = (section, feat)
                if k in want and len(row) == len(head):
                    new = _esc(merge(row[col].replace("\\|", "|"), want[k][1]))
                    if row[col] != new:
                        changes.append((section, feat, row[col], new.replace("\\|", "|")))
                        row[col] = new
                    out.append("| " + " | ".join(row) + " |")
                    seen.add(k)
                else:
                    out.append(lines[i])
                i += 1
            for k in sorted(x for x in want if x[0] == section and x not in seen):
                row = [k[1]] + ["not measured"] * (len(head) - 1)
                row[col] = _esc(want[k][1])
                out.append("| " + " | ".join(row) + " |")
                changes.append((section, k[1], None, want[k][1]))
            continue
        i += 1
    text = "\n".join(out)
    blk = NOTRUN_BEGIN + "\n" + block.rstrip("\n") + "\n" + NOTRUN_END
    if NOTRUN_BEGIN in text and NOTRUN_END in text:
        a, rest = text.split(NOTRUN_BEGIN, 1)
        _, b = rest.split(NOTRUN_END, 1)
        text = a + blk + b
    else:
        text = text.rstrip("\n") + "\n\n" + blk + "\n"
    return text, changes


def _load(path):
    if os.path.basename(path) == "env":
        sys.exit("matrix.py: %s is a run's env file, which holds the passwords; pass its results.json instead" % path)
    with open(path) as f:
        return json.load(f)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("cells")
    p.add_argument("--tier", required=True, choices=TIERS)
    p.add_argument("--run-tag", required=True)
    p.add_argument("--date", required=True)
    p.add_argument("--build", required=True)
    p.add_argument("--cache", required=True, choices=("on", "off"))
    p.add_argument("--suite", action="append", default=[], help="<suite>=<ours results.json>:<baseline results.json>")
    p.add_argument("--routes")
    p.add_argument("--areas", default=os.path.join(HERE, "areas.txt"))
    p.add_argument("--areas-text", help=argparse.SUPPRESS)
    p.add_argument("--json")
    p.add_argument("--apply")
    p.add_argument("--strict", action="store_true")
    a = ap.parse_args(argv)
    if not re.match(r"^\d{4}-\d\d-\d\d$", a.date):
        sys.exit("matrix.py: --date must be YYYY-MM-DD")
    areas = parse_areas(a.areas_text if a.areas_text is not None else open(a.areas).read())
    cite = "conformance `%s` %s, build `%s`, cache %s" % (a.run_tag, a.date, a.build, a.cache)
    pairs, suites = [], []
    for s in a.suite:
        m = re.match(r"^([a-z-]+)=(.+):(.+)$", s)
        if not m:
            sys.exit("matrix.py: --suite wants <suite>=<ours>:<baseline>, got %r" % s)
        pairs.append((m.group(1), _load(m.group(2)), _load(m.group(3))))
        suites.append(m.group(1))
    feats, unmapped = feature_rows(pairs, areas)
    cells = {k: cell(v, cite) for k, v in feats.items()}
    if a.routes:
        for k, v in routes_cells(_load(a.routes), cite).items():
            cells.setdefault(k, v)
    excludes = {s: runner.read_excludes(s) for s in suites if os.path.exists(os.path.join(HERE, "exclude", s + ".txt"))}
    for (sec, feat), (w, t) in sorted(cells.items()):
        print("%-12s %-11s %s: %s" % (sec, w, feat, t))
    for s, f in unmapped:
        print("unmapped    %s %s (add a line to areas.txt)" % (s, f))
    ours = [(r["suite"], r["file"], r["title"]) for v in feats.values() for r in v if r["verdict"] == "OURS"]
    for s, f, t in ours:
        print("OURS        %s %s :: %s" % (s, f, t))
    if a.json:
        with open(a.json, "w") as f:
            json.dump({"cite": cite, "tier": a.tier, "cells": [[k[0], k[1], w, t] for k, (w, t) in sorted(cells.items())],
                       "unmapped": [list(u) for u in unmapped], "ours": [list(o) for o in ours]}, f, indent=1)
    if a.apply:
        with open(a.apply) as f:
            md = f.read()
        new, changes = apply_md(md, a.tier, cells, notrun_block(excludes, a.run_tag))
        with open(a.apply, "w") as f:
            f.write(new)
        for sec, feat, old, nw in changes:
            print("changed     %s / %s / %s: %r -> %r" % (sec, feat, a.tier, old, nw))
        print("applied: %d cells changed in %s" % (len(changes), a.apply))
    return 1 if (a.strict and (unmapped or ours)) else 0


if __name__ == "__main__":
    sys.exit(main())
