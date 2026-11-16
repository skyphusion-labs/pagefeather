#!/usr/bin/env python3
"""Score one engine of the #724 live run (#598) against the bar pinned before the data.

  python3 -I tests/load/reuse_score.py OFF.jsonl ON.jsonl [--logs-off L.jsonl] [--logs-on L.jsonl]

OFF and ON are tests/load/reuse_run.py files of the same engine (npm-off and npm-on, or lean-off and lean-on).
--logs-* are Workers Logs of each arm's site (and its dispatcher), one JSON object per line, as exported; the
lines this reads are the Worker's own JSON (m: isolate-reset, write-loss, mem-reuse, boot-refused, object-deadline,
...) and the platform outcome (outcome: exceededMemory). A bar that needs the logs and has none says
"could not measure", never a pass. Prints the bar table (spec: #598 issuecomment-6910964924), then the #605
reading (#598 issuecomment-6912013983): every admin request over 30 s. Exit 0 when the on arm passes every bar
that could be measured, 1 when one fails, 2 when one could not be measured and none failed.
Env: BOOT_GATE_MAX_REFUSE_S (default 60), SLOW_S (default 30, the #605 threshold).
"""
import json, statistics, sys

import os
MAX_REFUSE_S = float(os.environ.get("BOOT_GATE_MAX_REFUSE_S", "60"))
SLOW_S = float(os.environ.get("SLOW_S", "30"))  # the #605 reading: admin requests slower than this
NAMED = ("in-flight", "newer-runtime", "no-drain", "no-guards")


def load(p):
    rows = []
    with open(p) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass
    return rows


def logs(p):
    if not p:
        return None
    out = []
    for o in load(p):
        m = o.get("message") if isinstance(o.get("message"), (dict, str)) else None
        if isinstance(m, str):
            try:
                m = json.loads(m)
            except ValueError:
                m = None
        out.append({"raw": o, "j": m if isinstance(m, dict) else o})
    return out


ADMIN_KINDS = ("dashboard", "post-new", "edit", "save", "before-gap", "after-gap")


def arm(rows, lg):
    a = [r for r in rows if r.get("kind") in ADMIN_KINDS]
    g = [r for r in rows if r.get("kind") == "guest"]
    rb = [r for r in rows if r.get("kind") == "read-back"]
    A = {"admin": len(a), "guests": len(g)}
    A["resets"] = sum(1 for r in a + g if r.get("x-isolate-reset"))
    A["noAnswer"] = sum(1 for r in a if r.get("status") == "EXC")
    A["lostWrites"] = sum(1 for r in rb if r.get("lostWrite"))
    A["writeLossHdr"] = sum(1 for r in a if r.get("kind") == "save" and r.get("x-write-loss") not in (None, "none"))
    A["readBackUnknown"] = sum(1 for r in rb if r.get("found") is None)
    if lg is not None:
        A["exceededMemory"] = sum(1 for x in lg if (x["raw"].get("outcome") or x["j"].get("outcome")) == "exceededMemory")
        A["logResets"] = sum(1 for x in lg if x["j"].get("m") == "isolate-reset")
        A["logWriteLoss"] = sum(1 for x in lg if x["j"].get("m") == "write-loss")
        A["refusedOffers"] = [x["j"].get("reason") for x in lg if x["j"].get("m") == "mem-reuse" and x["j"].get("reason")]
    led = [r for r in a if r.get("memLive") is not None]
    A["ledger"] = len(led)
    A["stacked"] = [r for r in led if (r.get("memLive") or 0) >= 2 or (r.get("retiredMem") or 0) > 0]
    A["recycles"] = sum(1 for r in a if r.get("x-runtime-recycled"))
    per_iso = {}
    for r in a:
        mr = r.get("memReuse") or {}
        if r.get("iso") and mr:
            d = per_iso.setdefault(r["iso"], {})
            for k in ("taken", "noGuards", "kept", "inFlight", "current"):
                if isinstance(mr.get(k), int):
                    d[k] = max(d.get(k, 0), mr[k])
    A["taken"] = sum(d.get("taken", 0) for d in per_iso.values())
    A["noGuards"] = sum(d.get("noGuards", 0) for d in per_iso.values())
    A["noDrain"] = sum(1 for r in a if (r.get("memReuse") or {}).get("lastOffer") == "no-drain") if lg is None else sum(1 for x in A["refusedOffers"] if x == "no-drain")
    # the quiet gap: did the request after it take the spare (taken rose on its isolate)?
    bg = [r for r in a if r.get("kind") == "before-gap"]; ag = [r for r in a if r.get("kind") == "after-gap"]
    if not (bg and ag):
        A["gap"] = "not run"
    elif not bg[-1].get("x-runtime-recycled"):
        A["gap"] = "not measured: the forced recycle before the gap was not done"
    elif not bg[-1].get("iso") or bg[-1].get("iso") != ag[-1].get("iso"):
        A["gap"] = "not measured: the isolate changed during the gap (%s to %s)" % (bg[-1].get("iso"), ag[-1].get("iso"))
    else:
        t0, t1 = (bg[-1].get("memReuse") or {}).get("taken"), (ag[-1].get("memReuse") or {}).get("taken")
        A["gap"] = "taken" if (isinstance(t0, int) and isinstance(t1, int) and t1 > t0) else "NOT taken"
    # refusal streaks (the gate): consecutive refused admin answers, by time, until an answered one
    ref = sorted(a, key=lambda r: r["t"])
    streaks, cur, after = [], None, []
    for r in ref:
        if r.get("status") == 503 and r.get("x-runtime-wait") == "retired-resident":
            cur = cur or {"t0": r["t"] - (r.get("s") or 0), "n": 0, "decisions": []}
            cur["n"] += 1; cur["decisions"].append(r.get("x-runtime-wait-decision")); cur["t1"] = r["t"]
        elif cur is not None and isinstance(r.get("status"), int) and r["status"] < 500:
            cur["toBootS"] = round(r["t"] - cur["t0"], 1); streaks.append(cur); cur = None
    if cur is not None:
        cur["toBootS"] = None; streaks.append(cur)
    A["refusals"] = sum(s["n"] for s in streaks)
    A["streaks"] = streaks
    A["longestStreakS"] = max([round(s["t1"] - s["t0"], 1) for s in streaks], default=0)
    gs = [r for r in g if isinstance(r.get("status"), int)]
    A["guestNon2xx"] = sum(1 for r in g if not (isinstance(r.get("status"), int) and 200 <= r["status"] < 300))
    gt = sorted(r["s"] for r in gs if isinstance(r.get("s"), (int, float)))
    A["guestP50"] = round(statistics.median(gt), 3) if gt else None
    A["guestP95"] = round(gt[min(len(gt) - 1, int(0.95 * len(gt)))], 3) if gt else None
    bw = [r["bootWaitMs"] for r in a if isinstance(r.get("bootWaitMs"), (int, float))]
    A["bootMedianMs"] = statistics.median(bw) if bw else None
    A["boots"] = len(bw)
    A["slow"] = sorted([r for r in a if isinstance(r.get("s"), (int, float)) and r["s"] > SLOW_S], key=lambda r: r["t"])
    A["order"] = sorted(a, key=lambda r: r["t"])
    return A


def main(argv):
    args, opts = [], {}
    i = 0
    while i < len(argv):
        if argv[i] in ("--logs-off", "--logs-on"):
            opts[argv[i]] = argv[i + 1]; i += 2
        else:
            args.append(argv[i]); i += 1
    if len(args) != 2:
        sys.exit(__doc__)
    off = arm(load(args[0]), logs(opts.get("--logs-off")))
    on = arm(load(args[1]), logs(opts.get("--logs-on")))
    res = []

    def bar(n, name, verdict, detail):
        res.append(verdict)
        print("| %s | %s | %s | %s |" % (n, name, verdict, detail))

    print("| # | bar | verdict | measured |\n|---|---|---|---|")
    # 1
    if not on["ledger"]:
        bar(1, "no stacking (on)", "could not measure", "no ledger readings on the on arm")
    else:
        st = on["stacked"]
        named = [x for x in (on.get("refusedOffers") or []) if x in NAMED]
        if not st:
            bar(1, "no stacking (on)", "pass", "%d readings, memLive 1 and retiredMem 0 in all" % on["ledger"])
        elif "refusedOffers" not in on:
            bar(1, "no stacking (on)", "could not measure", "%d stacked readings; the logs that could excuse them were not given" % len(st))
        elif len(named) >= len(st):
            bar(1, "no stacking (on)", "pass", "%d stacked readings, each matched by a named refused offer (%s)" % (len(st), ", ".join(sorted(set(named)))))
        else:
            bar(1, "no stacking (on)", "FAIL", "%d stacked readings, %d named refused offers; first: %s memLive %s retiredMemMiB %s" % (len(st), len(named), st[0]["perfId"], st[0].get("memLive"), st[0].get("retiredMemMiB")))
    # 2
    d_on, d_off = on["resets"] + on["noAnswer"], off["resets"] + off["noAnswer"]
    detail = "client: resets+no-answer on %d, off %d; lost writes on %d, off %d" % (d_on, d_off, on["lostWrites"], off["lostWrites"])
    if "exceededMemory" in on and "exceededMemory" in off:
        detail += "; exceededMemory on %d, off %d" % (on["exceededMemory"], off["exceededMemory"])
        v = "pass" if (d_on <= d_off and on["exceededMemory"] <= off["exceededMemory"] and on["lostWrites"] <= off["lostWrites"]) else "FAIL"
    else:
        v = "FAIL" if (d_on > d_off or on["lostWrites"] > off["lostWrites"]) else "could not measure"
        detail += "; exceededMemory needs both arms' logs"
    if on["readBackUnknown"]:
        detail += "; %d read-backs unknown" % on["readBackUnknown"]
    bar(2, "deaths and lost writes at or below off", v, detail)
    # 3
    if not on["recycles"]:
        bar(3, "reuse happens (on)", "could not measure", "no recycle on the on arm")
    else:
        ok = on["taken"] >= 0.9 * on["recycles"] and on["noGuards"] == 0 and on["noDrain"] == 0
        v = "FAIL" if (not ok or on["gap"] == "NOT taken") else ("pass" if on["gap"] == "taken" else "could not measure")
        bar(3, "reuse happens (on)", v, "taken %d of %d recycles; noGuards %d; no-drain %d; after the gap: %s"
            % (on["taken"], on["recycles"], on["noGuards"], on["noDrain"], on["gap"]))
    # 4
    bar(4, "the gate never stalls", "pass" if on["longestStreakS"] <= MAX_REFUSE_S else "FAIL",
        "%d refusals in %d streaks, longest %.1f s (bound %g s); decisions %s" % (on["refusals"], len(on["streaks"]), on["longestStreakS"], MAX_REFUSE_S,
                                                                               [s["decisions"] for s in on["streaks"]][:5]))
    # 5
    if on["guestP95"] is None or off["guestP95"] is None:
        bar(5, "guests no worse", "could not measure", "no guest timings")
    else:
        ok = on["guestNon2xx"] <= off["guestNon2xx"] and on["guestP95"] <= 1.10 * off["guestP95"]
        bar(5, "guests no worse", "pass" if ok else "FAIL", "non-2xx on %d, off %d; p95 on %.3f s, off %.3f s (p50 %.3f, %.3f)"
            % (on["guestNon2xx"], off["guestNon2xx"], on["guestP95"], off["guestP95"], on["guestP50"], off["guestP50"]))
    # 6
    if on["bootMedianMs"] is None or off["bootMedianMs"] is None:
        bar(6, "boot cost", "could not measure", "boots on %d, off %d" % (on["boots"], off["boots"]))
    else:
        bar(6, "boot cost", "pass" if on["bootMedianMs"] <= off["bootMedianMs"] + 50 else "FAIL",
            "median bootWaitMs on %s (%d boots), off %s (%d boots)" % (on["bootMedianMs"], on["boots"], off["bootMedianMs"], off["boots"]))
    tb = [s["toBootS"] for s in on["streaks"] if s.get("toBootS") is not None]
    print("\nBOOT_GATE_MAX_REFUSE_S: %s" % ("stays 60 (no refusals)" if not on["streaks"] else
          "%g (the longest time to a successful boot after a refusal, %.1f s, plus 50%%, capped at 600)" % (min(600, round(1.5 * max(tb), 1)), max(tb)) if tb else "a streak never reached a successful boot: report it"))
    for name, A, lgk in (("off", off, "--logs-off"), ("on", on, "--logs-on")):
        print("\n#605 reading, %s arm: %d admin requests over %g s (of %d)" % (name, len(A["slow"]), SLOW_S, A["admin"]))
        if A["slow"]:
            print("| x-perf-id | kind | client s | status | x-object-deadline | x-write-loss | request before: wasm1MiB, iso | next iso new | log lines |\n|---|---|---|---|---|---|---|---|---|")
        lg = logs(opts.get(lgk))
        for r in A["slow"]:
            o = A["order"]; k = o.index(r)
            prev = o[k - 1] if k > 0 else {}; nxt = o[k + 1] if k + 1 < len(o) else {}
            nl = "logs not given" if lg is None else str(sum(1 for x in lg if r["perfId"] in json.dumps(x["raw"])))
            print("| %s | %s | %.1f | %s | %s | %s | %s, %s | %s | %s |" % (r["perfId"], r["kind"], r["s"], r["status"], r.get("x-object-deadline", "absent"),
                  r.get("x-write-loss", "-"), prev.get("wasm1MiB"), prev.get("iso"), (nxt.get("iso") not in (None, r.get("iso"))) if nxt else "-", nl))
    bad = [v for v in res if v == "FAIL"]
    return 1 if bad else (2 if "could not measure" in res else 0)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
