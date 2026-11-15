#!/bin/bash
# #582 M2c, the live measurement of lazy function bodies. Runs from the Vultr VPS against throwaway sites the lead
# deploys (one per arm: the same build, engine and primed opcache.zip; only PHP_INI differs). Never from a laptop.
#   vps-run.sh            (reads $RUN_ENV, default /root/run.env; writes $OUT, default /root/out)
# run.env: B (the site, https://<name>.workers.dev), SPIKE_TOKEN, ADMIN_PASSWORD. B_body, B_script and B_whole override
# B per arm. ARMS (default "body script whole") picks the arms, BOOTS (5) and WARM (5) the counts.
# Arms: body (opcache.pagefeather_lazy_unit=body), script (=script), whole (opcache.pagefeather_lazy_load=0). Each
# arm's site must report that mode in /_mem (ini.lb.lazy_unit, ini.lb.lazy_load), or the arm is refused.
# Per boot: a request with x-runtime-recycle: force (spike-gated: the runtime is dropped after it, as a memory recycle
# would), log in (it must report x-perf boot 1: a new runtime), /_mem, the FIRST post-new.php, /_mem, then WARM more
# post-new.php,
# each between two /_mem reads. Each request is one JSON line in $OUT/<arm>.jsonl: wall time, x-perf (phpMs, wasm
# before and after, remote pack fetches), and the deltas of body_load_ns, body_loads, script_loads,
# body_bytes_loaded and body_bytes_resident. $OUT/summary.json and the printed table read the decision line:
# the first post-new.php after a boot must spend at most 250 ms or 5% of its wall time in body loads.
set -u
RUN_ENV=${RUN_ENV:-/root/run.env}; OUT=${OUT:-/root/out}
[ -r "$RUN_ENV" ] || { echo "vps-run: cannot read $RUN_ENV"; exit 1; }
# shellcheck disable=SC1090
. "$RUN_ENV"
: "${SPIKE_TOKEN:?SPIKE_TOKEN is not set in $RUN_ENV}" "${ADMIN_PASSWORD:?ADMIN_PASSWORD is not set in $RUN_ENV}"
ARMS=${ARMS:-body script whole}; BOOTS=${BOOTS:-5}; WARM=${WARM:-5}
mkdir -p "$OUT"
J=$(mktemp "${TMPDIR:-/tmp}/m2c-jar.XXXXXX"); T=$(mktemp -d "${TMPDIR:-/tmp}/m2c.XXXXXX")
trap 'rm -rf "$J" "$T"' EXIT
H=(-H "x-spike-token: $SPIKE_TOKEN")
rc=0
for arm in $ARMS; do
  v="B_$arm"; base=${!v:-${B:-}}
  [ -n "$base" ] || { echo "vps-run: no B or $v for arm $arm"; rc=1; continue; }
  f="$OUT/$arm.jsonl"; : > "$f"
  for boot in $(seq 1 "$BOOTS"); do
    rm -f "$J"
    curl -s "${H[@]}" -H 'x-runtime-recycle: force' -c "$J" -b "$J" -o /dev/null -D "$T/r.txt" "$base/wp-login.php"
    grep -qi '^x-runtime-recycled:' "$T/r.txt" || { echo "vps-run: $arm boot $boot: the forced recycle was not done (no x-runtime-recycled; is SPIKE_TOKEN right?)"; rc=1; continue; }
    curl -s -c "$J" -b "$J" -o /dev/null -D "$T/l.txt" --data-urlencode "pwd=$ADMIN_PASSWORD" -d 'log=admin&wp-submit=Log+In&redirect_to=%2Fwp-admin%2F&testcookie=1' "$base/wp-login.php"
    python3 -I -c 'import json, sys
p = [json.loads(l.split(":", 1)[1]) for l in open(sys.argv[1], errors="replace") if l.lower().startswith("x-perf:")]
sys.exit(0 if p and p[0].get("boot") == 1 else 1)' "$T/l.txt" || { echo "vps-run: $arm boot $boot: the login did not boot a new runtime (x-perf boot is not 1)"; rc=1; continue; }
    for i in $(seq 0 "$WARM"); do
      curl -s "${H[@]}" -o "$T/a.json" "$base/_mem"
      w=$(curl -s -c "$J" -b "$J" -o /dev/null -D "$T/h.txt" -w '%{http_code} %{time_total}' "$base/wp-admin/post-new.php")
      curl -s "${H[@]}" -o "$T/b.json" "$base/_mem"
      python3 -I - "$arm" "$boot" "$i" "$w" "$T" >> "$f" <<'PY' || { echo "vps-run: $arm boot $boot request $i: no reading (see above)" >&2; rc=1; }
import json, sys
arm, boot, i, (code, wall), t = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4].split(), sys.argv[5]
def lb(p):
    try:
        return json.load(open(p))["ini"]["lb"] or {}
    except Exception as e:
        sys.exit("vps-run: %s is not a /_mem reading (%s)" % (p, e))
a, b = lb(t + "/a.json"), lb(t + "/b.json")
want = {"body": (True, "body"), "script": (True, "script"), "whole": (False, None)}[arm]
if b.get("lazy_load") != want[0] or (want[1] and b.get("lazy_unit") != want[1]):
    sys.exit("vps-run: arm %s, but the site reports lazy_load %r, lazy_unit %r" % (arm, b.get("lazy_load"), b.get("lazy_unit")))
perf = {}
for line in open(t + "/h.txt", errors="replace"):
    if line.lower().startswith("x-perf:"):
        perf = json.loads(line.split(":", 1)[1].strip())
d = {k: b.get(k, 0) - a.get(k, 0) for k in ("body_load_ns", "body_loads", "script_loads", "body_bytes_loaded", "body_bytes_resident", "body_fail")}
print(json.dumps({"arm": arm, "boot": boot, "req": i, "first": i == 0, "status": int(code), "wall_ms": round(float(wall) * 1000, 1),
    "body_load_ms": round(d["body_load_ns"] / 1e6, 2), **{k: v for k, v in d.items() if k != "body_load_ns"},
    "phpMs": perf.get("phpMs"), "wasm0MiB": perf.get("wasm0MiB"), "wasm1MiB": perf.get("wasm1MiB"), "rt": perf.get("rt"), "bootFlag": perf.get("boot"),
    "rfN": perf.get("rfN"), "rfKiB": perf.get("rfKiB"), "rfMs": perf.get("rfMs")}))
PY
    done
  done
done
python3 -I - "$OUT" $ARMS <<'PY'
import json, statistics, sys, os
out, arms = sys.argv[1], sys.argv[2:]
S = {}
print("%-7s %-6s %9s %9s %8s %9s %8s %8s %8s" % ("arm", "kind", "wall_ms", "load_ms", "share", "loads", "MiB_res", "wasm1", "status"))
for arm in arms:
    p = os.path.join(out, arm + ".jsonl")
    rows = [json.loads(l) for l in open(p)] if os.path.exists(p) else []
    for kind, sel in (("first", [r for r in rows if r["first"]]), ("warm", [r for r in rows if not r["first"]])):
        if not sel:
            continue
        med = lambda k: statistics.median([r[k] or 0 for r in sel])
        mx = lambda k: max(r[k] or 0 for r in sel)
        share = [((r["body_load_ms"] or 0) / r["wall_ms"]) if r["wall_ms"] else 0 for r in sel]
        s = {"n": len(sel), "wall_ms_median": med("wall_ms"), "body_load_ms_median": med("body_load_ms"), "body_load_ms_max": mx("body_load_ms"),
             "share_median": round(statistics.median(share), 4), "share_max": round(max(share), 4), "body_loads_median": med("body_loads"),
             "script_loads_median": med("script_loads"), "resident_MiB_max": round(mx("body_bytes_resident") / 2**20, 2),
             "wasm1MiB_max": mx("wasm1MiB"), "statuses": sorted({r["status"] for r in sel}), "body_fail": sum(r["body_fail"] or 0 for r in sel)}
        if kind == "first":
            s["fallback_line_crossed"] = any((r["body_load_ms"] or 0) > 250 or ((r["body_load_ms"] or 0) / r["wall_ms"] if r["wall_ms"] else 0) > 0.05 for r in sel)
        if kind == "first":
            rts = {r["rt"] for r in sel}
            s["distinct_runtimes"] = len(rts)
            if len(rts) != len(sel):
                print("vps-run: WARNING %s: %d boots ran on %d runtimes: /_evict did not give each boot a new runtime" % (arm, len(sel), len(rts)))
        S.setdefault(arm, {})[kind] = s
        print("%-7s %-6s %9.0f %9.1f %7.2f%% %9.0f %8.2f %8s %8s" % (arm, kind, s["wall_ms_median"], s["body_load_ms_median"], s["share_median"] * 100,
              s["body_loads_median"], s["resident_MiB_max"], s["wasm1MiB_max"], s["statuses"]))
json.dump(S, open(os.path.join(out, "summary.json"), "w"), indent=2)
for arm, s in S.items():
    if "first" in s and arm != "whole":
        print("decision line (250 ms or 5%%, the first post-new.php after a boot), %s: %s" % (arm, "CROSSED" if s["first"]["fallback_line_crossed"] else "held"))
PY
exit $rc
