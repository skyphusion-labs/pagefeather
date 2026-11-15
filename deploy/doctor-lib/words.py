"""doctor wording (#652): the plain-English report, made from facts.py's data. FIRST DRAFT.

Conrad is researching what a WordPress developer wants to see. His research replaces the wording
here. Change this file only; facts.py stays as it is. Style: short sentences, plain words (STE).
"""
import datetime


def _t(ms):
    return datetime.datetime.utcfromtimestamp(ms / 1000.0).strftime("%Y-%m-%d %H:%M UTC")


def _n(v):
    return "could not measure" if v is None else str(v)


def _ms(v):
    return "-" if v is None else ("%d ms" % v if v >= 10 else "%.1f ms" % v)


def verdict(f):
    """One of: cannot_see, problems, cannot_count, healthy."""
    if f["visibility"] == "cannot_see":
        return "cannot_see"
    sig = dict((i["m"], i["count"]) for i in (f.get("signals") or {}).get("items", []))
    ours_bad = any((sig.get(k) or 0) > 0 for k in ("isolate-reset", "write-loss", "overloaded"))
    shed = ((next((i for i in f["signals"]["items"] if i["m"] == "php-lock"), {}).get("split") or {}).get("shed") or 0)
    if f["visibility"] == "outcomes":
        oc = f.get("outcomes") or {}
        bad = sum(v for k, v in oc.items() if k != "ok")
        if bad or ours_bad or shed or f.get("memory_resets_seen"):
            return "problems"
        if f.get("outcomes") is None:
            return "cannot_count"
        return "healthy"
    if ours_bad or shed or f.get("memory_resets_seen"):
        return "problems"
    return "cannot_count"


def render(f):
    L = []
    w = f["window"]
    L.append("Doctor report for %s, %s to %s." % (f["site"], _t(w["from"]), _t(w["to"])))
    L.append("Doctor only reads. It changed nothing.")
    L.append("")
    v = verdict(f)
    if v == "cannot_see":
        L.append("I CANNOT SEE THIS SITE'S LOGS. This is not a healthy result.")
        L.append("I looked for these names and found no log rows:")
        for t in f["tried"]:
            L.append("  - %s: %s" % (t["service"], "the read failed" if t["rows"] is None else "0 rows"))
        L.append("Possible reasons:")
        s = f.get("settings") or {}
        if s.get("read") and not s.get("enabled"):
            L.append("  - Logging is OFF for %s. Deploy it with OBSERVABILITY=1 to turn it on." % f["settings_of"])
        elif not s.get("read"):
            L.append("  - I could not read the log settings of %s (no access, or no such script)." % f["settings_of"])
        L.append("  - The name is wrong. Give the exact Worker name with --service.")
        L.append("  - Nobody used the site in this window. Try a longer window with --hours.")
        if f.get("read_failed"):
            L.append("  - A log read failed. Check the token can read Workers Logs.")
        return "\n".join(L) + "\n"
    L.append("I can see this site's logs, under the name %s." % f["service"])
    others = [t for t in f["tried"] if t["rows"] and t["service"] != f["service"]]
    for t in others:
        L.append("I also saw %d rows under %s. Use --service to choose it." % (t["rows"], t["service"]))
    L.append("Log rows: %d console lines, %d request records." % (f["console_lines"], f["event_rows"]))
    L.append("")
    if f["visibility"] == "console_only":
        L.append("FAILURES CANNOT BE COUNTED AT THIS LOGGING LEVEL.")
        L.append("The site logs its own lines only (OBSERVABILITY=1). It does not log each request's result.")
        L.append("So 'no failures' below would be wrong. Doctor does not say it.")
        L.append("To count failures, the site needs request logs (OBSERVABILITY=full).")
        L.append("Request logs record client IP addresses. Use them on a throwaway site only (THROWAWAY=1).")
    else:
        L.append("Request results:")
        oc = f.get("outcomes")
        if oc is None:
            L.append("  could not measure")
        else:
            names = {"ok": "ok", "exceededMemory": "out of memory", "exceededCpu": "out of CPU time",
                     "exception": "crashed (exception)", "canceled": "canceled"}
            for k in sorted(oc, key=lambda k: (k != "ok", k)):
                L.append("  %-22s %d" % (names.get(k, k), oc[k]))
        s = f.get("sample")
        if s:
            L.append("Timing, from %d of %d request records%s:" % (s["rows"], s["of"], "" if s["complete"] else " (NOT the whole window: the read stopped early)"))
            for where, label in (("worker", "Worker"), ("durable_object", "Durable Object")):
                x = s[where]
                if x["rows"]:
                    L.append("  %s: %d records. CPU p50 %s, p95 %s. Total time p50 %s, p95 %s." % (
                        label, x["rows"], _ms(x["cpu_ms"]["p50"]), _ms(x["cpu_ms"]["p95"]), _ms(x["wall_ms"]["p50"]), _ms(x["wall_ms"]["p95"])))
            if s["slowest_paths"]:
                L.append("  Slowest paths (p95 total time):")
                for p in s["slowest_paths"]:
                    L.append("    %s  %s  (%d requests)" % (_ms(p["wall_ms_p95"]), p["path"], p["requests"]))
    L.append("")
    sg = f["signals"]
    L.append("Pagefeather's own signals:")
    if not sg["structured_lines"]:
        L.append("  could not measure: I found no Pagefeather structured lines (%s), so I cannot count these." % _n(sg["structured_lines"]))
    for i in sg["items"]:
        extra = ""
        if i["split"]:
            extra = " (" + ", ".join("%s %d" % (k, n) for k, n in sorted(i["split"].items())) + ")"
        L.append("  %-20s %s%s. Matches header %s: %s." % (i["m"], _n(i["count"]), extra, i["header"], i["meaning"]))
    for h in sg["header_only"]:
        L.append("  %-20s not in the logs. Look at the response header: %s." % (h["header"], h["meaning"]))
    pl = next((i for i in sg["items"] if i["m"] == "php-lock"), None)
    if pl and pl["split"]:
        L.append("Note: 'queued' means requests waited their turn (slow, not failed). 'shed' means a request got a fast 503.")
    L.append("")
    mr = f.get("memory_resets_seen")
    if mr is None:
        L.append("Memory resets: could not measure.")
    elif mr:
        L.append("Memory resets happened in this window. The runtime's reset line is not one line per failed request, so doctor does not count it.")
    else:
        L.append("Memory resets: none seen.")
    s = f.get("settings") or {}
    if not s.get("read"):
        L.append("Privacy: I could not read the log settings, so I cannot say if query strings are hidden.")
    elif s.get("enabled") and s.get("redact_query_string") is not True:
        L.append("PRIVACY WARNING: query strings are NOT hidden in this site's logs. They can hold order keys and logins.")
        L.append("Fix: deploy the site again with OBSERVABILITY=1 (the deploy turns the hiding on and checks it).")
    elif s.get("enabled"):
        L.append("Privacy: query strings are hidden in this site's logs.")
    L.append("")
    L.append({"healthy": "Summary: no failures found.",
              "problems": "Summary: PROBLEMS FOUND. See above.",
              "cannot_count": "Summary: no problems seen, but failures cannot be counted at this logging level."}[v])
    if not f.get("complete", True):
        L.append("Some reads were incomplete. Treat the numbers above as a lower bound.")
    return "\n".join(L) + "\n"
