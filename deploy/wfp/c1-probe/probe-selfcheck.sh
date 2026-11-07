#!/bin/bash
# Offline self-check of the slice 7 feasibility probe (#147). No network, no
# Docker, no deploy: it only proves the probe's files are well-formed before
# the lead's live run. Needs bash, node, python3 (tomllib).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
PY=""
for p in python3 python3.14 python3.13 python3.12 python3.11; do
	command -v "$p" >/dev/null 2>&1 && "$p" -c 'import tomllib' 2>/dev/null && { PY=$p; break; }
done
[ -n "$PY" ] || { echo "FAIL no python3 with tomllib"; exit 1; }

ok "worker.js parses (node --check)" "$(node --check "$HERE/worker.js" 2>/dev/null && echo 1 || echo 0)"
ok "server.py compiles" "$("$PY" -m py_compile "$HERE/container/server.py" 2>/dev/null && echo 1 || echo 0)"
ok "Dockerfile present" "$([ -f "$HERE/container/Dockerfile" ] && echo 1 || echo 0)"

# The wrangler.toml binds a Container, its Durable Object and the migration, and
# nothing that is not the Probe class (the minimal surface the probe tests).
v=$("$PY" - "$HERE/wrangler.toml" <<'PY'
import tomllib, sys
d = tomllib.load(open(sys.argv[1], "rb"))
c = d.get("containers", [])
do = d.get("durable_objects", {}).get("bindings", [])
mig = d.get("migrations", [])
checks = [
    d.get("name") == "site-c1probe",
    len(c) == 1 and c[0].get("class_name") == "Probe" and c[0].get("image") == "./container/Dockerfile",
    len(do) == 1 and do[0].get("name") == "PROBE" and do[0].get("class_name") == "Probe",
    len(mig) == 1 and mig[0].get("new_sqlite_classes") == ["Probe"],
    "nodejs_compat" in d.get("compatibility_flags", []),
]
print("1" if all(checks) else "0")
PY
)
ok "wrangler.toml: one Probe container, its DO and migration, name site-c1probe" "$v"

# Regression guard (fc#147): every Dockerfile COPY source must resolve inside
# the build context wrangler passes, or the image build dies with "not found"
# before it ever reaches the WfP upload gate (the bug that stalled the first run).
v=$("$PY" - "$HERE/wrangler.toml" "$HERE/container/Dockerfile" "$HERE" <<'PY'
import tomllib, sys, os, re
d = tomllib.load(open(sys.argv[1], "rb"))
ctxrel = (d.get("containers") or [{}])[0].get("image_build_context", ".")
ctx = os.path.normpath(os.path.join(sys.argv[3], ctxrel))
missing = []
for line in open(sys.argv[2]):
    m = re.match(r"\s*COPY\s+(\S+)\s+\S+", line)
    if m and not m.group(1).startswith("--") and not os.path.exists(os.path.join(ctx, m.group(1))):
        missing.append(m.group(1))
sys.stderr.write("missing: " + ",".join(missing) + "\n") if missing else None
print("1" if not missing else "0")
PY
)
ok "every Dockerfile COPY source resolves in the build context" "$v"

[ "$fails" = 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
