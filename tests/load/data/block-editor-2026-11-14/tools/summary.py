"""Summarise a be-run.mjs output dir (steps.csv, requests.csv, events.csv) as markdown.
  summary.py <run dir> [<run dir> ...]
Rules: p50/p95 nearest-rank over PASSED steps only. A setup editor-check that needed more than one
attempt, or never passed, counts as a failure of step 1 (new-load) for that platform. An iteration is
complete only when all 14 steps passed. Headers and statuses only."""
import csv, math, os, sys, collections
STEPS = [t + "-" + s for t in ("post", "page") for s in ("new-load", "new-type", "publish", "new-verify", "edit-load", "edit-append", "edit-verify")]
def nr(v, p):
    v = sorted(v); return v[max(0, math.ceil(p / 100 * len(v)) - 1)] if v else None
steps, reqs, evs = [], [], []
for d in sys.argv[1:]:
    steps += list(csv.DictReader(open(os.path.join(d, "steps.csv"))))
    reqs += list(csv.DictReader(open(os.path.join(d, "requests.csv"))))
    if os.path.exists(os.path.join(d, "events.csv")):
        evs += list(csv.DictReader(open(os.path.join(d, "events.csv"))))
plats = sorted({s["platform"] for s in steps})
print("## Setup (login and the block editor check)\n")
print("| platform | login | editor-check attempts | passed on attempt | counts as |")
print("|---|---|---|---|---|")
setup_fail = {}
for P in plats:
    su = [s for s in steps if s["platform"] == P and s["iter"] == "setup"]
    login = next((s for s in su if s["step"] == "login"), {})
    ec = [s for s in su if s["step"].startswith("editor-check")]
    okat = next(("%d" % (i + 1) if s["ok"] == "1" else "%d (after its retry)" % (i + 1) for i, s in enumerate(ec) if s["ok"] == "1" or s["retry_ok"] == "1"), None)
    setup_fail[P] = okat != "1"
    print("| %s | %s | %d | %s | %s |" % (P, "ok" if login.get("ok") == "1" else ("ok after retry" if login.get("retry_ok") == "1" else "FAIL"), len(ec), okat or "never", "pass" if okat == "1" else "step 1 failure"))
print("\n## Iterations\n")
print("| platform | iterations run | complete (14 of 14) | first failing step: count |")
print("|---|---|---|---|")
for P in plats:
    its = sorted({s["iter"] for s in steps if s["platform"] == P and s["iter"].isdigit()}, key=int)
    comp, firsts = 0, collections.Counter()
    for n in its:
        rows = {s["step"]: s for s in steps if s["platform"] == P and s["iter"] == n}
        bad = [st for st in STEPS if rows.get(st, {}).get("ok") != "1"]
        if not bad: comp += 1
        else: firsts[bad[0]] += 1
    if not its and setup_fail[P]:
        firsts["post-new-load (setup never passed)"] = 10
    print("| %s | %d | %d | %s |" % (P, len(its), comp, ", ".join("%s: %d" % kv for kv in firsts.most_common()) or "none"))
print("\n## Per step: passed first try / run (recovered by one retry), and p50 / p95 ms (first-try passes only)\n")
print("| step | " + " | ".join(P for P in plats) + " |")
print("|---|" + "---|" * len(plats))
for st in STEPS:
    cells = []
    for P in plats:
        r = [s for s in steps if s["platform"] == P and s["step"] == st and s["iter"].isdigit()]
        ok = [int(s["ms"]) for s in r if s["ok"] == "1"]
        if not r:
            cells.append("not reached" + (" (fails at step 1)" if setup_fail[P] else "")); continue
        rec = sum(1 for s in r if s["ok"] == "0" and s["retry_ok"] == "1")
        cells.append("%d / %d%s; %s / %s" % (len(ok), len(r), " (+%d recovered)" % rec if rec else "", "{:,}".format(nr(ok, 50)) if ok else "-", "{:,}".format(nr(ok, 95)) if ok else "-"))
    print("| %s | %s |" % (st, " | ".join(cells)))
print("\n## Failures (step, reason, the call behind it, retry)\n")
for P in plats:
    for s in steps:
        if s["platform"] == P and s["ok"] == "0":
            print("- %s %s %s: %s; editor: %s; call: %s; retry_ok %s" % (P, s["iter"], s["step"], s["fail_reason"][:120], s["editor_error"][:80] or "-", s["failing_call"] or "-", s["retry_ok"]))
print("\n## Requests by kind (non-static): count, 5xx or no answer, x-isolate-reset, x-runtime-recycled\n")
print("| platform | kind | requests | 5xx / no answer | x-isolate-reset | x-runtime-recycled | x-write-loss |")
print("|---|---|---|---|---|---|---|")
for P in plats:
    for k in ("html", "rest", "ajax"):
        r = [q for q in reqs if q["platform"] == P and q["kind"] == k]
        real = [q for q in r if not (q["status"] == "NO-ANSWER" and "ERR_ABORTED" in q["failure"])]
        bad = [q for q in real if q["status"] == "NO-ANSWER" or (q["status"].isdigit() and int(q["status"]) >= 500)]
        print("| %s | %s | %d | %d | %d | %d | %d |" % (P, k, len(r), len(bad), sum(1 for q in r if q["x_isolate_reset"]), sum(1 for q in r if q["x_runtime_recycled"]), sum(1 for q in r if q["x_write_loss"] not in ("", "0"))))
print("\n## Browser errors (events.csv)\n")
c = collections.Counter((e["platform"], e["kind"]) for e in evs if "added to the iframe incorrectly" not in e["text"])
for (P, k), n in sorted(c.items()):
    print("- %s %s: %d" % (P, k, n))
