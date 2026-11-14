"""#508 arena A/B (Rollins, measure394.py pnrest) to one per-request CSV.
  ab-to-csv.py <out.csv> <arm.jsonl>...   (arm = file name without .jsonl, e.g. abA1)
Names, numbers and statuses only."""
import csv, json, sys, datetime
out, files = sys.argv[1], sys.argv[2:]
cols = ["arm", "arena", "t_utc", "phase", "label", "method", "status", "ms", "boot", "x_isolate_reset", "x_write_loss",
        "wasm0_mib", "wasm1_mib", "inflates", "reinflates", "rest_readback_state", "rest_readback_ms"]
n = 0
with open(out, "w", newline="") as f:
    w = csv.writer(f); w.writerow(cols)
    for path in files:
        arm = path.split("/")[-1].rsplit(".", 1)[0]
        arena = "on" if arm.startswith("abB") else "off"
        for line in open(path):
            if not line.strip(): continue
            r = json.loads(line)
            if "code" not in r: continue
            p = r.get("perf") or {}
            t = datetime.datetime.utcfromtimestamp(r["t"]).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z" if isinstance(r.get("t"), (int, float)) else ""
            w.writerow([arm, arena, t, r.get("phase", ""), r.get("label", ""), r.get("method", ""), r.get("code"),
                        round(r["s"] * 1000) if isinstance(r.get("s"), (int, float)) else "", r.get("boot", ""), r.get("reset") or "", r.get("writeLoss") or "",
                        p.get("wasm0MiB", ""), p.get("wasm1MiB", ""), p.get("inflates", ""), p.get("reinflates", ""),
                        r.get("state", ""), round(r["stateS"] * 1000) if isinstance(r.get("stateS"), (int, float)) else ""])
            n += 1
print(out, n, "rows")
