#!/bin/bash
# Start wrangler dev, wait for the port or an error, then print one request.
cd "$(dirname "$0")"
pkill -f 'wrangler dev --port 8797' 2>/dev/null
rm -f out.json; : > dev.log
(wrangler dev --port 8797 --log-level warn ${DEV_ENV:+--env $DEV_ENV} > dev.log 2>&1 &)
for i in $(seq 1 60); do
  grep -q 'ERROR' dev.log && { grep -v '^\s*$' dev.log | grep -v '🪵' | head -20 | cut -c1-400; exit 1; }
  curl -s -m 2 -o /dev/null localhost:8797/_ping 2>/dev/null && break
  sleep 1
done
curl -s -m 120 "localhost:8797/${1:-}" -o out.json; echo "http_exit=$?"
head -c 2000 out.json; echo
grep -v '^\s*$' dev.log | grep -v '🪵' | tail -8 | cut -c1-400
