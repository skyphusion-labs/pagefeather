#!/bin/bash
# Start wrangler dev, wait for the port or an error, then print one request.
# PORT (default 8797) picks the local port, so two seats on one laptop do not
# answer each other's requests (measured 2026-11-05: a collision on 8797).
cd "$(dirname "$0")" || exit 1
pkill -f "wrangler dev --port ${PORT:-8797}" 2>/dev/null
rm -f out.json; : > dev.log
# SITE_ORIGIN (issue #33): the site's links are localhost:<port>, the address
# e2e.sh and opcache.sh use, whatever request boots PHP first.
(wrangler dev --port ${PORT:-8797} --log-level warn ${DEV_ENV:+--env $DEV_ENV} --var "SITE_ORIGIN:http://localhost:${PORT:-8797}" > dev.log 2>&1 &)
for _ in $(seq 1 60); do
  grep -q 'ERROR' dev.log && { grep -v '^\s*$' dev.log | grep -v '🪵' | head -20 | cut -c1-400; exit 1; }
  curl -s -m 2 -o /dev/null localhost:${PORT:-8797}/_ping 2>/dev/null && break
  sleep 1
done
curl -s -m 120 "localhost:${PORT:-8797}/${1:-}" -o out.json; echo "http_exit=$?"
head -c 2000 out.json; echo
grep -v '^\s*$' dev.log | grep -v '🪵' | tail -8 | cut -c1-400
