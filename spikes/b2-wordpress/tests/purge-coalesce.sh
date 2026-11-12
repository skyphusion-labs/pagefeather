#!/bin/bash
# Gate for issue #78, locally: env dosql-local in local workerd (no database
# server needed). Starts its own wrangler dev, runs tests/purge_coalesce_check.py
# against it, and stops only that server. On Cloudflare run the check directly:
#   B=https://<site> ADMIN_PASSWORD=... SPIKE_TOKEN=... python3 tests/purge_coalesce_check.py
# Usage: tests/purge-coalesce.sh [port]   (after ./build.sh and DEV_ENV=dosql-local ./opcache.sh)
set -u
cd "$(dirname "$0")/.." || exit 9
# The pinned Wrangler (deploy/wr, #371), never a global one.
WR=${WR:-$(cd ../.. && pwd)/deploy/wr}
P=${1:-8801}
OUT=$(mktemp -d)
[ -z "$(lsof -t -nP -iTCP:$P -sTCP:LISTEN 2>/dev/null)" ] || { echo "port $P is busy: pick another port"; exit 1; }
"$WR" dev --port "$P" --log-level warn --env dosql-local --var "SITE_ORIGIN:http://localhost:$P" > "$OUT/dev.log" 2>&1 &
W=$!
stop() { L=$(lsof -t -nP -iTCP:$P -sTCP:LISTEN 2>/dev/null | head -1); kill $W $L $( [ -n "$L" ] && ps -o ppid= -p "$L") 2>/dev/null; }
trap stop EXIT
for _ in $(seq 1 90); do curl -H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}" -s -m 2 -o /dev/null "localhost:$P/_ping" && break; sleep 1; done
curl -H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}" -s -o /dev/null -X POST -H "x-admin-password: ${ADMIN_PASSWORD:-local-spike-password}" "localhost:$P/_install"
env -u SPIKE_TOKEN LOCAL=1 B=http://localhost:$P ADMIN_PASSWORD=local-spike-password python3 tests/purge_coalesce_check.py
