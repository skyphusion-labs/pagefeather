#!/bin/bash
# Start wrangler dev, wait for the port or an error, then print one request.
# PORT (default 8797) picks the local port, so two seats on one laptop do not
# answer each other's requests (measured 2026-11-05: a collision on 8797).
#
# ./run.sh --stop stops the server this script started on PORT, and nothing else.
# The server is recorded in .dev-<PORT>.pid (the listening workerd and its
# wrangler parent). A port held by anything else is refused, never killed: a
# kill by pattern (pkill -f "wrangler dev --port N") also hit other seats'
# servers, and a server left on the port answered the next run's requests
# (2026-11-06: an OPcache dump answered 409 "not booted" from a server that
# was not the run's own).
cd "$(dirname "$0")" || exit 1
PORT=${PORT:-8797}
PIDF=".dev-$PORT.pid"
listener() { lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | sort -u | head -1; }
stop() {
	[ -f "$PIDF" ] || return 0
	for p in $(cat "$PIDF"); do kill "$p" 2>/dev/null; done
	for _ in $(seq 1 20); do [ -z "$(listener)" ] && break; sleep 0.5; done
	rm -f "$PIDF"
}
if [ "${1:-}" = --stop ]; then
	stop
	exit 0
fi
held=$(listener)
if [ -n "$held" ]; then
	if [ -f "$PIDF" ] && grep -qw "$held" "$PIDF"; then
		stop # our own server from an earlier run
	fi
	held=$(listener)
	if [ -n "$held" ]; then
		echo "port $PORT is in use by pid $held ($(ps -o user= -o command= -p "$held" | cut -c1-120)): not started by this script; set PORT to a free port" >&2
		exit 1
	fi
fi
rm -f out.json; : > dev.log
# SITE_ORIGIN (issue #33): the site's links are localhost:<port>, the address
# e2e.sh and opcache.sh use, whatever request boots PHP first.
# DEV_VARS: more vars, "NAME:value" separated by spaces (opcache.sh sets PHP_RECYCLE:off).
vars=()
for v in ${DEV_VARS:-}; do vars+=(--var "$v"); done
wrangler dev --port "$PORT" --log-level warn ${DEV_ENV:+--env $DEV_ENV} --var "SITE_ORIGIN:http://localhost:$PORT" "${vars[@]}" > dev.log 2>&1 &
started=$!
up=0
for _ in $(seq 1 60); do
	grep -q 'ERROR' dev.log && { grep -v '^\s*$' dev.log | grep -v '🪵' | head -20 | cut -c1-400; kill "$started" 2>/dev/null; exit 1; }
	curl -s -m 2 -o /dev/null "localhost:$PORT/_ping" 2>/dev/null && { up=1; break; }
	sleep 1
done
[ "$up" = 1 ] || { echo "wrangler dev did not answer on port $PORT in 60 s" >&2; kill "$started" 2>/dev/null; exit 1; }
# The port was free before the start, so the listener now is this run's.
L=$(listener)
echo "$L $(ps -o ppid= -p "$L" | tr -d ' ') $started" > "$PIDF"
curl -s -m 120 "localhost:$PORT/${1:-}" -o out.json; echo "http_exit=$?"
head -c 2000 out.json; echo
grep -v '^\s*$' dev.log | grep -v '🪵' | tail -8 | cut -c1-400
