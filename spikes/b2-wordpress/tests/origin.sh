#!/bin/bash
# Issue #33: the site's links must come from the configured site address
# (SITE_ORIGIN), not from whichever request boots the PHP runtime.
#
#   ./tests/origin.sh            # local wrangler dev, default env (B on local D1)
#   DEV_ENV=do-local ./tests/origin.sh
#   FALLBACK=1 ./tests/origin.sh # no SITE_ORIGIN: each page links to its own
#                                 # request's origin, and the first request pins nothing
#
# Starts wrangler dev with a fresh state directory and SITE_ORIGIN set to
# http://localhost:<PORT>, then does what #33 measured: /_install and the first
# page through http://127.0.0.1:<PORT>, then the page through
# http://localhost:<PORT>. PASS only when both pages link to the configured
# origin and never to 127.0.0.1. Needs build/ (./build.sh). No Docker.
# PORT default 8814 (not the shared 8797 or 8798).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
PORT=${PORT:-8814}
CFG="http://localhost:$PORT"
OTHER="http://127.0.0.1:$PORT"
S=$(mktemp -d); trap 'pkill -f "wrangler dev --port $PORT" 2>/dev/null; rm -rf "$S"' EXIT
pkill -f "wrangler dev --port $PORT" 2>/dev/null
# An empty array under set -u: "${VARS[@]+...}" below, for macOS /bin/bash 3.2.
VARS=(--var "SITE_ORIGIN:$CFG"); [ "${FALLBACK:-0}" = 1 ] && VARS=()
(wrangler dev --port "$PORT" --log-level log ${DEV_ENV:+--env "$DEV_ENV"} --persist-to "$S/state" ${VARS[@]+"${VARS[@]}"} > "$S/dev.log" 2>&1 &)
for _ in $(seq 1 90); do curl -s -m 2 -o /dev/null "$OTHER/_ping" && break; sleep 1; done
curl -s -m 2 -o /dev/null "$OTHER/_ping" || { echo "wrangler dev did not start"; tail -20 "$S/dev.log"; exit 1; }
inst=$(curl -s -m 300 -X POST "$OTHER/_install")
echo "install through 127.0.0.1: $(printf '%s' "$inst" | python3 -c 'import json, sys; d = json.load(sys.stdin); print(d.get("out", "")[-60:])' 2>/dev/null || printf '%s' "$inst" | head -c 120)"
curl -s -m 120 -o "$S/via-other.html" "$OTHER/?nocache=1"
curl -s -m 120 -o "$S/via-cfg.html" "$CFG/?nocache=2"
fails=0
for f in via-other via-cfg; do
  want=$CFG; nope=$OTHER
  # FALLBACK: the page through 127.0.0.1 links there, the page through localhost links there.
  if [ "${FALLBACK:-0}" = 1 ] && [ "$f" = via-other ]; then want=$OTHER; nope=$CFG; fi
  good=$(grep -o "$want/" "$S/$f.html" | wc -l | tr -d ' ')
  bad=$(grep -o "$nope/" "$S/$f.html" | wc -l | tr -d ' ')
  size=$(wc -c < "$S/$f.html" | tr -d ' ')
  if [ "$good" -gt 0 ] && [ "$bad" -eq 0 ]; then r=PASS; else r=FAIL; fails=$((fails + 1)); fi
  printf '%s  GET / %-9s links: %s %s, %s %s  (%s bytes)\n' "$r" "$f" "$good" "$want/" "$bad" "$nope/" "$size"
done
grep -o '{"m":"boot"[^}]*}' "$S/dev.log" | head -5 | sed 's/^/  log: /'
exit $((fails > 0))
