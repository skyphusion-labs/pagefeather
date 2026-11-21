#!/usr/bin/env python3
"""Score one engine of the #724 live run (#598) against the bar pinned before the data.

  python3 -I tests/load/reuse_score.py OFF.jsonl ON.jsonl [--logs-off DIR] [--logs-on DIR] [--disp-off DIR] [--disp-on DIR]

OFF and ON are tests/load/reuse_run.py files of the same engine (npm-off and npm-on, or lean-off and lean-on).
--logs-* and --disp-* are Workers Logs exports (the lead's wexport.py <service> <from> <to> <dir>), one directory
per service: lines.jsonl (one console line per row, its JSON fields flattened at the top level, plus t in ms and
rid) and invocations.jsonl (one row per invocation: t, outcome, status, path, wallMs, cpuMs, rid, ...). --logs-* is
the arm's site; --disp-* is the dispatcher, for the #605 rows. Read from the site: invocation outcome
exceededMemory, and the lines m: isolate-reset, write-loss, mem-reuse (offer: kept or the refusal reason),
boot-gate, boot-refused, object-deadline, and the purge lines (purge, purge_zone: asked, coalesced, sent,
refused), printed per arm as a confounder, not a bar. A request is joined to its lines by its x-perf-id (the lines' id field,
front Worker and object both), then by rid to its invocations; to the dispatcher by path and time. A bar that
needs the logs and has none says "could not measure", never a pass. Prints the bar table (spec: #598 issuecomment-6910964924), then the #605
reading (#598 issuecomment-6912013983): every admin request over 30 s. Exit 0 when the on arm passes every bar
that could be measured, 1 when one fails, 2 when one could not be measured and none failed, 3 on a bad argument
or input.
Env: BOOT_GATE_MAX_REFUSE_S (default 60), SLOW_S (default 30, the #605 threshold).
"""
import json, statistics, sys

import os


def usage_error(msg):
    """A bad argument or input exits 3, never 1 (1 is a bar FAIL) or 2 (could not measure)."""
    sys.stderr.write(msg.rstrip() + "\n")
    sys.exit(3)


MAX_REFUSE_S = float(os.environ.get("BOOT_GATE_MAX_REFUSE_S", "60"))
SLOW_S = float(os.environ.get("SLOW_S", "30"))  # the #605 reading: admin requests slower than this
NAMED = ("in-flight", "newer-runtime", "no-drain", "no-guards")
MIN_BOOTS = 5  # #1022: bar 6 needs at least this many boot rows on each arm
# #1022 issuecomment-7067599082 (the lead's ruling, set before the lean-on data): a Workers for Platforms user script
# exposes no invocation rows, so bar 2 counts the platform's own memory-death line instead, for BOTH arms.
PLATFORM_DEATH = "Durable Object's isolate exceeded its memory limit and was reset."


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


def logs(d):
    """One wexport.py directory: lines.jsonl and invocations.jsonl. None when not given."""
    if not d:
        return None
    lp, ip = os.path.join(d, "lines.jsonl"), os.path.join(d, "invocations.jsonl")
    if not (os.path.isfile(lp) and os.path.isfile(ip)):
        usage_error("reuse-score: %s must hold lines.jsonl and invocations.jsonl (a wexport.py directory)" % d)
    L, I = load(lp), load(ip)
    X = {"lines": L, "inv": I, "rids_by_id": {}, "lines_by_rid": {}, "inv_by_rid": {}}
    for o in L:
        X["lines_by_rid"].setdefault(o.get("rid"), []).append(o)
        if o.get("id"):
            X["rids_by_id"].setdefault(o["id"], set()).add(o.get("rid"))
    for o in I:
        X["inv_by_rid"].setdefault(o.get("rid"), []).append(o)
    return X


def joined(X, perf_id):
    """The site's lines and invocations of one request, by its x-perf-id."""
    rids = X["rids_by_id"].get(perf_id, set())
    lines = [l for r in rids for l in X["lines_by_rid"].get(r, [])]
    inv = [i for r in rids for i in X["inv_by_rid"].get(r, [])]
    return lines, inv


def dispatcher_row(D, r):
    """The dispatcher invocation of a client request: same pathname, started within 5 s of the client's start."""
    path = r.get("path", "").split("?")[0] or "/"
    start = (r["t"] - (r.get("s") or 0)) * 1000
    c = [i for i in D["inv"] if i.get("path") == path and abs(i.get("t", 0) - start) <= 5000]
    return min(c, key=lambda i: abs(i["t"] - start)) if c else None


ADMIN_KINDS = ("dashboard", "post-new", "edit", "save", "before-gap", "after-gap")


def platform_deaths(lines):
    """#1022 issuecomment-7067648245: one death logs one platform line per in-flight request, so the count is DISTINCT
    isolates that end with one. The line carries no iso: it takes the iso of an engine line of the same request (rid),
    else the isolate whose perf lines were live then (the last m: perf iso before it). A line with neither counts by
    its own timestamp, so nothing is undercounted. Returns (lines, distinct timestamps, distinct isolates)."""
    ls = sorted(lines, key=lambda o: o.get("t") or 0)
    by_rid = {}
    for o in ls:
        if o.get("iso") and o.get("rid"):
            by_rid.setdefault(o["rid"], o["iso"])
    dead, stamps, units, live = 0, set(), set(), None
    for o in ls:
        if o.get("m") == "perf" and o.get("iso"):
            live = o["iso"]
        # #1022 issuecomment-7068680062: the text in ANY field. Many deaths carry it only inside an engine line
        # (failed, error, endFailed), with no standalone platform line.
        if PLATFORM_DEATH in json.dumps(o):
            dead += 1
            stamps.add(o.get("t"))
            iso = o.get("iso") or by_rid.get(o.get("rid")) or live
            units.add(("iso", iso) if iso else ("t", o.get("t")))
    return dead, len(stamps), len(units)


def arm(rows, lg):
    a = [r for r in rows if r.get("kind") in ADMIN_KINDS]
    g = [r for r in rows if r.get("kind") == "guest"]
    rb = [r for r in rows if r.get("kind") == "read-back"]
    A = {"admin": len(a), "guests": len(g)}
    A["resets"] = sum(1 for r in a + g if r.get("x-isolate-reset"))
    A["noAnswer"] = sum(1 for r in a if r.get("status") == "EXC")
    A["lostWrites"] = sum(1 for r in rb if r.get("lostWrite"))
    A["writeLossHdr"] = sum(1 for r in a if r.get("kind") == "save" and r.get("x-write-loss") not in (None, "none", "rolled-back"))
    A["readBackUnknown"] = sum(1 for r in rb if r.get("found") is None)
    if lg is not None:
        A["outcomes"] = {}
        for i in lg["inv"]:
            A["outcomes"][i.get("outcome")] = A["outcomes"].get(i.get("outcome"), 0) + 1
        A["exceededMemory"] = A["outcomes"].get("exceededMemory", 0)
        A["invRows"] = len(lg["inv"])
        A["lineRows"] = len(lg["lines"])
        A["platformLines"], A["platformStamps"], A["platformDeaths"] = platform_deaths(lg["lines"])
        A["logResets"] = sum(1 for o in lg["lines"] if o.get("m") == "isolate-reset")
        A["logWriteLoss"] = sum(1 for o in lg["lines"] if o.get("m") == "write-loss")
        offers = [o.get("offer") for o in lg["lines"] if o.get("m") == "mem-reuse" and o.get("offer")]
        A["offers"] = {k: offers.count(k) for k in sorted(set(offers))}
        A["refusedOffers"] = [x for x in offers if x != "kept"]
        A["gateLines"] = sum(1 for o in lg["lines"] if o.get("m") in ("boot-gate", "boot-refused"))
        A["deadlineLines"] = sum(1 for o in lg["lines"] if o.get("m") == "object-deadline")
        # The purge confounder (not a bar): purges coalesce per object (PURGE_GAP_MS 15 s); two concurrent sites can
        # ask more than the account allows, and a refused purge costs cache freshness only. Counted per arm.
        pl = [o for o in lg["lines"] if o.get("m") == "purge"]
        pz = [o for o in lg["lines"] if o.get("m") == "purge_zone"]
        A["purge"] = {"asked": sum(1 for o in pl if o.get("asked")), "coalesced": sum(1 for o in pl if o.get("coalesced")),
                      "sent": sum(1 for o in pl if o.get("sent")), "refused": sum(1 for o in pl if o.get("sent") and o.get("ok") is False),
                      "zoneSent": len(pz), "zoneRefused": sum(1 for o in pz if o.get("ok") is False),
                      "zoneStatus": {str(k): sum(1 for o in pz if o.get("status") == k) for k in sorted({o.get("status") for o in pz}, key=str)}}
    led = [r for r in a if r.get("memLive") is not None]
    A["ledger"] = len(led)
    A["ledgerRows"] = led
    # #1022 issuecomment-7069498841 (set before E1's data): the end-of-request ledger is read AFTER dropRuntime, so on a
    # recycling request the one memory left (the reuse spare) reads retiredMem 1, memLive 1. Stacking is two memories at
    # once, or a retired memory on a request that did not itself recycle.
    A["stacked"] = [r for r in led if (r.get("memLive") or 0) >= 2 or ((r.get("retiredMem") or 0) > 0 and not r.get("x-runtime-recycled"))]
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
    A["noDrain"] = sum(1 for r in a if (r.get("memReuse") or {}).get("lastOffer") == "no-drain") if lg is None else A["refusedOffers"].count("no-drain")
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
    # #1022 issuecomment-7069498841 (set before E1's data): the boot cost is the median over BOOT rows only (the old
    # median ran over every admin row, most of them 0).
    bw = [r["bootWaitMs"] for r in a if isinstance(r.get("bootWaitMs"), (int, float)) and r.get("boot")]
    A["bootMedianMs"] = statistics.median(bw) if bw else None
    A["boots"] = len(bw)
    A["slow"] = sorted([r for r in a if isinstance(r.get("s"), (int, float)) and r["s"] > SLOW_S], key=lambda r: r["t"])
    A["order"] = sorted(a, key=lambda r: r["t"])
    return A


def main(argv):
    args, opts = [], {}
    i = 0
    while i < len(argv):
        if argv[i] in ("--logs-off", "--logs-on", "--disp-off", "--disp-on"):
            opts[argv[i]] = argv[i + 1]; i += 2
        else:
            args.append(argv[i]); i += 1
    if len(args) != 2:
        usage_error(__doc__)
    LG = {k: logs(opts.get(k)) for k in ("--logs-off", "--logs-on", "--disp-off", "--disp-on")}
    off = arm(load(args[0]), LG["--logs-off"])
    on = arm(load(args[1]), LG["--logs-on"])
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
            bar(1, "no stacking (on)", "pass", "%d readings: never two memories at once (max memLive %d), and a retired memory only on a recycling request (%d)" % (
                on["ledger"], max([r.get("memLive") or 0 for r in on["ledgerRows"]] or [0]), sum(1 for r in on["ledgerRows"] if (r.get("retiredMem") or 0) > 0)))
        elif "refusedOffers" not in on:
            bar(1, "no stacking (on)", "could not measure", "%d stacked readings; the logs that could excuse them were not given" % len(st))
        elif len(named) >= len(st):
            bar(1, "no stacking (on)", "pass", "%d stacked readings, each matched by a named refused offer (%s)" % (len(st), ", ".join(sorted(set(named)))))
        else:
            bar(1, "no stacking (on)", "FAIL", "%d stacked readings, %d named refused offers; first: %s memLive %s retiredMemMiB %s" % (len(st), len(named), st[0]["perfId"], st[0].get("memLive"), st[0].get("retiredMemMiB")))
    # 2
    d_on, d_off = on["resets"] + on["noAnswer"], off["resets"] + off["noAnswer"]
    # Lost writes as the spec counts them (issuecomment-6910964924: "the write-loss logs"), plus silent losses (a 2xx
    # save absent on read-back), which log no write-loss line. Without both arms' logs, the client stands in: saves
    # answered with an x-write-loss header (1, 2, unknown; not rolled-back), plus silent losses.
    logs2 = "exceededMemory" in on and "exceededMemory" in off
    # #1022: which death source both arms use. Invocation rows on both arms: the invocation outcome, as before. Otherwise
    # the platform's own death line in lines.jsonl (one source for both arms). With no lines either, the logs measure
    # nothing: lost writes fall back to the client, and deaths are could not measure (never a 0 read as a pass).
    if logs2 and on["invRows"] and off["invRows"]:
        dsrc = "invocations"
    elif logs2 and on["lineRows"] and off["lineRows"]:
        dsrc = "platform"
    else:
        dsrc = None
    logs2 = dsrc is not None
    def lost(A):
        if logs2:
            return A["logWriteLoss"] + A["lostWrites"]
        return A["writeLossHdr"] + A["lostWrites"]
    lw_on, lw_off = lost(on), lost(off)
    detail = "lost writes (%s) on %d, off %d (silent on %d, off %d); client resets+no-answer on %d, off %d" % (
        "write-loss logs + silent" if logs2 else "client x-write-loss + silent", lw_on, lw_off, on["lostWrites"], off["lostWrites"], d_on, d_off)
    worse_lw = lw_on > lw_off or (lw_off == 0 and lw_on > 0)
    if dsrc == "invocations":
        detail += "; exceededMemory on %d, off %d" % (on["exceededMemory"], off["exceededMemory"])
        v = "pass" if (d_on <= d_off and on["exceededMemory"] <= off["exceededMemory"] and not worse_lw) else "FAIL"
    elif dsrc == "platform":
        detail += "; platform memory-death isolates on %d, off %d (lines on %d, off %d; timestamps on %d, off %d) (no invocation rows on an arm: the platform's death text in any field stands in, by distinct isolate, #1022)" % (
            on["platformDeaths"], off["platformDeaths"], on["platformLines"], off["platformLines"], on["platformStamps"], off["platformStamps"])
        v = "pass" if (d_on <= d_off and on["platformDeaths"] <= off["platformDeaths"] and not worse_lw) else "FAIL"
    else:
        v = "FAIL" if (d_on > d_off or worse_lw) else "could not measure"
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
    if on["bootMedianMs"] is None or off["bootMedianMs"] is None or on["boots"] < MIN_BOOTS or off["boots"] < MIN_BOOTS:
        bar(6, "boot cost", "could not measure", "boot rows on %d, off %d (fewer than %d on an arm)" % (on["boots"], off["boots"], MIN_BOOTS))
    else:
        bar(6, "boot cost", "pass" if on["bootMedianMs"] <= off["bootMedianMs"] + 50 else "FAIL",
            "median bootWaitMs over boot rows on %s (%d boots), off %s (%d boots)" % (on["bootMedianMs"], on["boots"], off["bootMedianMs"], off["boots"]))
    tb = [s["toBootS"] for s in on["streaks"] if s.get("toBootS") is not None]
    print("\nBOOT_GATE_MAX_REFUSE_S: %s" % ("stays 60 (no refusals)" if not on["streaks"] else
          "%g (the longest time to a successful boot after a refusal, %.1f s, plus 50%%, capped at 600)" % (min(600, round(1.5 * max(tb), 1)), max(tb)) if tb else "a streak never reached a successful boot: report it"))
    for name, A in (("off", off), ("on", on)):
        if "outcomes" in A:
            print("\nlogs, %s arm: invocation outcomes %s; mem-reuse offers %s; isolate-reset %d, write-loss %d, gate %d, object-deadline %d lines"
                  % (name, A["outcomes"], A["offers"], A["logResets"], A["logWriteLoss"], A["gateLines"], A["deadlineLines"]))
            p = A["purge"]
            print("purges, %s arm (a confounder, not a bar: freshness only): asked %d, coalesced %d, sent %d, refused %d; purge_zone sent %d, refused %d, status %s"
                  % (name, p["asked"], p["coalesced"], p["sent"], p["refused"], p["zoneSent"], p["zoneRefused"], p["zoneStatus"]))
    for name, A, lgk, dk in (("off", off, "--logs-off", "--disp-off"), ("on", on, "--logs-on", "--disp-on")):
        print("\n#605 reading, %s arm: %d admin requests over %g s (of %d)" % (name, len(A["slow"]), SLOW_S, A["admin"]))
        if A["slow"]:
            print("| x-perf-id | kind | client s | status | x-object-deadline | x-write-loss | request before: wasm1MiB, iso | next iso new | site: lines (m), invocations (outcome wallMs) | dispatcher: outcome status wallMs |\n|---|---|---|---|---|---|---|---|---|---|")
        lg, dg = LG[lgk], LG[dk]
        for r in A["slow"]:
            o = A["order"]; k = o.index(r)
            prev = o[k - 1] if k > 0 else {}; nxt = o[k + 1] if k + 1 < len(o) else {}
            if lg is None:
                nl = "logs not given"
            else:
                jl, ji = joined(lg, r["perfId"])
                ms = {}
                for l in jl:
                    ms[l.get("m")] = ms.get(l.get("m"), 0) + 1
                nl = "%d %s; %s" % (len(jl), ms, [(i.get("outcome"), i.get("wallMs")) for i in ji]) if (jl or ji) else "none joined"
            if dg is None:
                dl = "not given"
            else:
                d = dispatcher_row(dg, r)
                dl = "%s %s %s" % (d.get("outcome"), d.get("status"), d.get("wallMs")) if d else "none matched"
            print("| %s | %s | %.1f | %s | %s | %s | %s, %s | %s | %s | %s |" % (r["perfId"], r["kind"], r["s"], r["status"], r.get("x-object-deadline", "absent"),
                  r.get("x-write-loss", "-"), prev.get("wasm1MiB"), prev.get("iso"), (nxt.get("iso") not in (None, r.get("iso"))) if nxt else "-", nl, dl))
    bad = [v for v in res if v == "FAIL"]
    return 1 if bad else (2 if "could not measure" in res else 0)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
