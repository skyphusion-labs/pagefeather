#!/usr/bin/env python3
"""Read one c1 load job (one "arm") the way docs/approach-c1.md does (#99).

Usage: python3 tests/load/c1_arm.py <dir> [--seed-complete N] [--seed-pending N]

<dir> holds, for one job:
  result.json   the runner's result: deploy/results/bench-runner-<job>.json
                (tests/bench-runner, tests/load/load.py with its "slow" list)
  req.log       the container request log: /_stats.php?what=req
  samples.log   the container 2 s samples: /_stats.php?what=samples
  db.json       the row and action counts after the job: /_stats.php?what=db
tests/load/c1_pull.sh <dir> fetches the last three from a site (B, SPIKE_TOKEN).
Read them right after the job: the container loses them when it stops, and a
deploy stops it.

It prints one JSON object:
  hol    head-of-line: for each slow request (10 s or more, load.py "slow"),
         its line in the request log and whether it was HELD: its PHP start
         came within 1 s after a local cron run (wp-cron.php) of 10 s or more
         ended. Also the long cron runs and a base rate.
  cpu    the cgroup CPU (usage_usec) over the job window (runner started_utc to
         finished_utc), the orders (container count minus the seed's 127), CPU
         per order.
  split  the PHP CPU of shopper and of cron requests (getrusage per request,
         from the request log); the queue work done and left (actions);
         "corrected" CPU per order = (cgroup CPU + actions left x cron CPU per
         completed action) / orders, so a run that left more queue work is not
         counted as cheaper; "outside_php" = cgroup CPU / all PHP CPU.
  steps  per load step: rps, ok per second, checkouts, p50 and p99, the max.
--seed-complete and --seed-pending are the seed's action counts after its
first drain (154 and 13 for the wp-c1 copies of #99; 153 when one seed action
failed).
"""
import argparse, datetime, json, os, sys

HOLD_S = 1.0     # a PHP start this close after a long cron run ended is held
LONG_CRON_S = 10  # a cron run this long is "long"
SEED_ORDERS = 127


def _ts(s):
    return datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp()


def read_req(path):
    out = []
    for ln in open(path):
        w = ln.split()
        if len(w) < 7:
            continue
        out.append({"t": float(w[0]), "wall": float(w[1]), "cpu": float(w[2]), "status": w[4], "m": w[5], "p": w[6]})
    return out


def kind_of(p, m):
    if "wc/store/v1/checkout" in p:
        return "checkout"
    if "wc/store/v1/cart/add-item" in p:
        return "add"
    if "wc/store/v1/cart" in p:
        return "cart"
    if m == "GET" and "rest_route" not in p and not p.startswith(("/wp-cron", "/_", "/ping")):
        return "browse"
    return "other"


def hol(res, lines):
    cron = [l for l in lines if l["p"].startswith("/wp-cron.php") and l["wall"] >= LONG_CRON_S]
    ends = sorted(l["t"] + l["wall"] for l in cron)
    held_at = lambda t: any(0 <= t - e <= HOLD_S for e in ends)
    slow = sorted((s for st in res["targets"][0]["load"]["steps"] for s in st.get("slow", [])), key=lambda x: x["t0"])
    used, rows = set(), []
    for s in slow:
        end = s["t0"] + s["ttfb"]
        cand = [(abs(l["t"] + l["wall"] - end), i) for i, l in enumerate(lines)
                if i not in used and kind_of(l["p"], l["m"]) == s["k"] and s["t0"] - 1 <= l["t"] <= end and abs(l["t"] + l["wall"] - end) <= 1.5]
        if not cand:
            rows.append({"kind": s["k"], "total": s["s"], "matched": False})
            continue
        _, i = min(cand)
        used.add(i)
        l = lines[i]
        rows.append({"kind": s["k"], "total": s["s"], "ttfb": s["ttfb"], "matched": True, "php_wait": round(l["t"] - s["t0"], 2),
                     "php_wall": l["wall"], "held": held_at(l["t"]), "ray": s.get("ray")})
    shoppers = [l for l in lines if kind_of(l["p"], l["m"]) != "other"]
    return {"long_cron_runs": len(cron), "long_cron_walls": sorted(round(l["wall"], 1) for l in cron),
            "slow": len(slow), "matched": sum(r["matched"] for r in rows), "held": sum(bool(r.get("held")) for r in rows),
            "base_rate": "%d of %d shopper requests started within %.0f s after a long cron run ended" % (sum(held_at(l["t"]) for l in shoppers), len(shoppers), HOLD_S),
            "requests": rows}


def cpu(res, samples_path, db):
    t0, t1 = _ts(res["runner"]["started_utc"]), _ts(res["runner"]["finished_utc"])
    smp = []
    for ln in open(samples_path):
        parts = ln.split("|")
        head = parts[0].split()
        if len(head) < 3 or head[1] != "cpu":
            continue
        t = float(head[0])
        cg = {}
        for p in parts[1:]:
            w = p.split()
            if w and w[0] == "cg":
                cg = {k: int(v) for k, v in (x.split("=", 1) for x in w[1:] if "=" in x)}
        if t0 <= t <= t1 and "usage_usec" in cg:
            smp.append((t, cg["usage_usec"]))
    if len(smp) < 2:
        return {"error": "fewer than 2 cgroup samples in the job window"}
    cpu_s = (smp[-1][1] - smp[0][1]) / 1e6
    dt = smp[-1][0] - smp[0][0]
    orders = db["rows"]["wp_wc_orders"] - SEED_ORDERS
    steps = res["targets"][0]["load"]["steps"]
    return {"window_s": round(dt, 1), "samples": len(smp), "cpu_s": round(cpu_s, 1), "vcpu_mean": round(cpu_s / dt, 3),
            "orders": orders, "orders_client_ok": sum(st["kinds"].get("checkout", {}).get("ok", 0) for st in steps),
            "cpu_s_per_order": round(cpu_s / orders, 3) if orders else None,
            "client_requests": sum(st["requests"] for st in steps)}


def split(res, lines, db, c, seed_complete, seed_pending):
    t0, t1 = _ts(res["runner"]["started_utc"]), _ts(res["runner"]["finished_utc"])
    shop = cron = 0.0
    nshop = ncron = 0
    for l in lines:
        if not (t0 <= l["t"] <= t1):
            continue
        if l["p"].startswith("/wp-cron.php"):
            cron += l["cpu"]; ncron += 1
        elif not l["p"].startswith(("/ping", "/_")):
            shop += l["cpu"]; nshop += 1
    a = db.get("actions", {})
    done = a.get("complete", 0) - seed_complete
    left = a.get("pending", 0) + a.get("in-progress", 0) - seed_pending
    per_action = cron / done if done > 0 else 0.0
    orders = c.get("orders") or 0
    corr = c["cpu_s"] + max(left, 0) * per_action
    php = shop + cron
    return {"shop_php_cpu_s": round(shop, 1), "shop_reqs": nshop,
            "shop_php_cpu_per_order": round(shop / orders, 3) if orders else None,
            "shop_php_cpu_per_req": round(shop / nshop, 4) if nshop else None,
            "cron_php_cpu_s": round(cron, 1), "cron_reqs": ncron, "actions_done": done, "actions_left": left,
            "cron_cpu_per_action": round(per_action, 3),
            "corrected_cpu_per_order": round(corr / orders, 3) if orders else None,
            "outside_php": round(c["cpu_s"] / php, 3) if php else None}


def steps(res):
    out = []
    for st in res["targets"][0]["load"]["steps"]:
        k = st["kinds"]
        ok = sum(v.get("ok", 0) for v in k.values())
        ch = k.get("checkout", {})
        out.append({"users": st["users"], "rps": st["rps"], "ok_per_s": round(ok / st["seconds"], 2), "checkout_ok": ch.get("ok"),
                    "checkout_p50": ch.get("p50"), "checkout_p99": ch.get("p99"), "max_s": max((v.get("max", 0) for v in k.values()), default=0)})
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("dir")
    ap.add_argument("--seed-complete", type=int, default=154)
    ap.add_argument("--seed-pending", type=int, default=13)
    a = ap.parse_args(argv)
    res = json.load(open(os.path.join(a.dir, "result.json")))
    lines = read_req(os.path.join(a.dir, "req.log"))
    db = json.load(open(os.path.join(a.dir, "db.json")))
    c = cpu(res, os.path.join(a.dir, "samples.log"), db)
    out = {"job": res.get("job"), "hol": hol(res, lines), "cpu": c, "steps": steps(res)}
    if "error" not in c:
        out["split"] = split(res, lines, db, c, a.seed_complete, a.seed_pending)
    json.dump(out, sys.stdout, indent=1)
    print()


if __name__ == "__main__":
    main()
