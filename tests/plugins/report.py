#!/usr/bin/env python3
"""Make the plugin matrix (Markdown) from tests/plugins/results/*.jsonl.

A cell is:
  pass      every check passed on the first try
  pass (n)  every check passed; n checks needed a second or third try
  fail: x   the checks named x failed three times
The baseline row "(none)" is the same checks with no suite plugin active.
Usage: report.py > table.md
"""
import json, os, re

HERE = os.path.dirname(__file__)
COLS = [
    ("a-free.jsonl", "A, Free"), ("a-paid.jsonl", "A, Paid"),
    ("hwp-free.jsonl", "HostlessWP, Free"), ("hwp-paid.jsonl", "HostlessWP, Paid"),
    ("b-free.jsonl", "B, Free"), ("b-paid.jsonl", "B, Paid"),
    ("c1-paid.jsonl", "C1, Paid"),
]
ORDER = ["(none)"] + [l.split()[0] for l in open(os.path.join(HERE, "suite.txt")) if l.strip() and not l.startswith("#")]


def load(f):
    p = os.path.join(HERE, "results", f)
    out = {}
    if not os.path.exists(p): return out
    for l in open(p):
        r = json.loads(l)
        # Each group run starts with its own baseline; keep the first one, and
        # count all of them in the retry total.
        if r["plugin"] == "(none)" and "(none)" in out:
            out.setdefault("_baselines", []).append(r); continue
        out[r["plugin"]] = r
    return out


def cell(r):
    if r is None: return "not run"
    if r.get("error"):
        # Name the platform cause when the detail has it: a harness exception
        # from a CPU-limited REST call is a platform failure, not a harness bug.
        d = r.get("detail", "")
        why = "cpu limit" if "cpu limit" in d else ""
        m = re.search(r"'code': (\d+)", d)
        if not why and m: why = m.group(1)
        if why and r["error"] == "harness": return f"fail: plugin list ({why})"
        return f"fail: {r['error']}" + (f" ({why})" if why else "")
    st = r.get("steps", {})
    bad = [k for k, v in st.items() if v["ok"] is False]
    retried = sum(1 for v in st.values() if v.get("tries", 1) > 1 and v["ok"])
    if bad:
        reasons = sorted({v.get("reason") or str(v.get("code", "")) for k, v in st.items() if v["ok"] is False} - {""})
        return "fail: " + ", ".join(bad) + (f" ({', '.join(reasons)})" if reasons else "")
    return "pass" if not retried else f"pass ({retried} retried)"


def main():
    data = [load(f) for f, _ in COLS]
    print("| Plugin | " + " | ".join(n for _, n in COLS) + " |")
    print("| --- |" + " --- |" * len(COLS))
    for p in ORDER:
        print(f"| {p} | " + " | ".join(cell(d.get(p)) for d in data) + " |")
    # Totals
    tot = []
    for d in data:
        rs = [d.get(p) for p in ORDER[1:]]
        n = sum(1 for r in rs if r and r.get("pass"))
        tot.append(f"{n} of {len(ORDER) - 1}")
    print("| **passed** | " + " | ".join(tot) + " |")


if __name__ == "__main__":
    main()
