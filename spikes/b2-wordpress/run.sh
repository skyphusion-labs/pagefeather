#!/bin/bash
# Start wrangler dev, wait for the port or an error, then print one request.
# PORT (#839): set, that port is used unchanged. A busy explicit port is
# refused, never killed. Unset, a free TCP port on 127.0.0.1 is chosen
# (python3 binds port 0, the same pick as the inspector) and exported.
# One line is printed, "port N", and the port is written to .dev-port so
# opcache.sh, e2e.sh, file-trace.sh and the woo and plugin steps use it.
# Two builds that both took 8797 collided (2026-11-05, and a lead run on
# 2026-11-16).
#
# INSPECTOR_PORT (#802): workerd's inspector listens on 9230 unless
# --inspector-port is set, so two seats collide there even when PORT differs.
# Set: that port is passed through, exactly. Unset: a free port is chosen
# (python3 binds port 0) and printed on one line, "inspector port N".
# A port another process holds is refused, never killed.
#
# ./run.sh --stop stops the server this script started, and nothing else.
# At start the server is put in its own session. .dev-<PORT>.pid records
# every pid in that tree (wrangler, its node, and every workerd child), not
# a process name. --stop signals that tree and its process group, then
# checks the port for 10 seconds. A listener that remains is a failure: the
# exit status is non-zero and the line names the port and the pids still
# listening. A --stop with no pid file says so and checks the recorded
# .dev-port, or PORT. It does not kill a process this run did not start.
# A port held by anything else is refused, never killed: a kill by pattern
# (pkill -f "wrangler dev --port N") also hit other seats' servers, and a
# server left on the port answered the next run's requests (2026-11-06: an
# OPcache dump answered 409 "not booted" from a server that was not the
# run's own). On 2026-11-16 a workerd child outlived a killed wrangler three
# times, and the next run read the wrong server or lost its port (#847).
cd "$(dirname "$0")" || exit 1
# shellcheck source=port.sh
. ./port.sh
# The pinned Wrangler (deploy/wr, #371). A bare `wrangler` ran whatever was installed globally: on
# the laptop a Homebrew copy, on a GitHub runner nothing at all, so wrangler dev never started and
# this script waited out its whole bound (deploy-workers runs 43311450307, 43311776702).
WR=${WR:-$(cd ../.. && pwd)/deploy/wr}
# How long to wait for the first answer. A cold runner downloads the pinned Wrangler and starts
# workerd with the PHP wasm, so the wait is longer than a warm laptop needs; it ends at the answer.
DEV_WAIT_S=${DEV_WAIT_S:-180}
# A pid this stop may signal. Never this shell, and never pid 0 or 1.
safe_pid() {
	case "$1" in
		''|*[!0-9]*) return 1 ;;
	esac
	[ "$1" -gt 1 ] || return 1
	[ "$1" != "$$" ] && [ "$1" != "$PPID" ]
}

# Add $1 to PIDS once. PIDS belongs to the caller (bash local is dynamic).
add_pid() {
	safe_pid "$1" || return 1
	case " $PIDS " in
		*" $1 "*) return 0 ;;
	esac
	PIDS="$PIDS $1"
}

# $1 and its descendants. WALKED stops a cycle. A pid already listed is still
# walked, so children spawned since the last record are included.
add_tree() {
	local pid=$1 c
	case " $WALKED " in
		*" $pid "*) return 0 ;;
	esac
	WALKED="$WALKED $pid"
	add_pid "$pid" || return 0
	for c in $(pgrep -P "$pid" 2>/dev/null); do
		add_tree "$c"
	done
}

listeners_of() { lsof -t -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -u; }
listener_on() { listeners_of "$1" | head -1; }
listener_list() {
	local p line=""
	for p in $(listeners_of "$1"); do
		line="$line $p"
	done
	printf '%s' "${line# }"
}

# Rewrite .dev-<port>.pid as one line. Field 1 stays a listener when one of
# our pids is listening (opcache.sh and file-trace.sh take that field). The
# rest are the tree. The root is the process this script started in its own
# session, so its pid is the process group id.
record_server() {
	local root=$1 port=$2 pidf first line p gpid
	local PIDS="" WALKED=""
	pidf=".dev-$port.pid"
	if [ -f "$pidf" ]; then
		for p in $(cat "$pidf"); do
			add_pid "$p" || true
		done
	fi
	if kill -0 "$root" 2>/dev/null; then
		add_tree "$root"
	else
		add_pid "$root" || true
	fi
	for p in $(listeners_of "$port"); do
		gpid=$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ')
		case " $PIDS " in
			*" $p "*) ;;
			*)
				# Still in the session this script started (group id is the
				# root). A child that called setsid has a new group id and is
				# not added here; the tree walk records it while its parent
				# is alive.
				if [ "$gpid" = "$root" ]; then
					add_pid "$p" || true
				fi
				;;
		esac
	done
	first=""
	for p in $(listeners_of "$port"); do
		case " $PIDS " in
			*" $p "*) first=$p; break ;;
		esac
	done
	if [ -z "$first" ]; then
		first=$root
	fi
	line=$first
	for p in $PIDS; do
		[ "$p" = "$first" ] || line="$line $p"
	done
	printf '%s\n' "$line" > "$pidf"
}

clear_recorded_port() {
	local port=$1 rec
	[ -f .dev-port ] || return 0
	rec=$(tr -d '[:space:]' < .dev-port)
	[ "$rec" = "$port" ] && rm -f .dev-port
}

# Signal the recorded pids. When one of them is still in a process group
# whose id is a pid we recorded (the session started here), signal that
# group too. A group id we did not record is someone else's session.
signal_recorded() {
	local sig=$1 p gpid
	for p in $PIDS; do
		safe_pid "$p" || continue
		kill "-$sig" "$p" 2>/dev/null || true
	done
	for p in $PIDS; do
		kill -0 "$p" 2>/dev/null || continue
		gpid=$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ')
		safe_pid "$gpid" || continue
		case " $RECORDED " in
			*" $gpid "*) ;;
			*) continue ;;
		esac
		kill "-$sig" -- "-$gpid" 2>/dev/null || true
	done
}

# Stop the server recorded for this port, then prove nothing is listening.
# 20 waits of 0.5 s is the 10 s bound. No pid file: say so and check the
# port, and do not signal whatever is listening.
stop_port() {
	local port=$1 pidf p line i
	local PIDS="" WALKED="" RECORDED=""
	pidf=".dev-$port.pid"
	if [ ! -f "$pidf" ]; then
		if [ -z "$(listener_on "$port")" ]; then
			echo "no record of a server on port $port; the port is free" >&2
			clear_recorded_port "$port"
			return 0
		fi
		line=$(listener_list "$port")
		echo "no record of a server on port $port (.dev-$port.pid is absent)" >&2
		echo "port $port still has a listener after stop (pids: $line)" >&2
		return 1
	fi
	for p in $(cat "$pidf"); do
		if add_pid "$p"; then
			RECORDED="$RECORDED $p"
		fi
	done
	WALKED=""
	for p in $RECORDED; do
		kill -0 "$p" 2>/dev/null || continue
		add_tree "$p"
	done
	signal_recorded TERM
	i=0
	while [ "$i" -lt 20 ]; do
		if [ -z "$(listener_on "$port")" ]; then
			rm -f "$pidf"
			clear_recorded_port "$port"
			return 0
		fi
		# 2 s of TERM, then KILL the same pids. The loop is still the 10 s bound.
		if [ "$i" -eq 4 ]; then
			signal_recorded KILL
		fi
		i=$((i + 1))
		sleep 0.5
	done
	line=$(listener_list "$port")
	echo "port $port still has a listener after stop (pids: $line)" >&2
	return 1
}
if [ "${1:-}" = --stop ]; then
	# An explicit PORT stops that server. Otherwise the port this directory
	# recorded. A run from before #839 left .dev-8797.pid and no .dev-port.
	if [ -z "${PORT:-}" ]; then
		if rec=$(read_recorded_port); then
			PORT=$rec
		elif [ -f .dev-8797.pid ]; then
			PORT=8797
		else
			echo "no record of a server, and no PORT or .dev-port to check" >&2
			exit 1
		fi
	fi
	stop_port "$PORT"
	exit $?
fi
port_chose=0
if [ -z "${PORT:-}" ]; then
	# Stop a server this script already recorded, then pick a free port.
	# A port another process holds is left alone.
	if old=$(read_recorded_port); then
		if [ -f ".dev-$old.pid" ]; then
			held=$(listener_on "$old")
			if [ -n "$held" ] && grep -qw "$held" ".dev-$old.pid"; then
				stop_port "$old" || exit 1
			fi
		fi
	fi
	PORT=$(pick_free_port) || { echo "could not pick a free port" >&2; exit 1; }
	export PORT
	port_chose=1
else
	export PORT
fi
PIDF=".dev-$PORT.pid"
listener() { listener_on "$PORT"; }
if [ "$port_chose" = 0 ]; then
	held=$(listener)
	if [ -n "$held" ]; then
		if [ -f "$PIDF" ] && grep -qw "$held" "$PIDF"; then
			stop_port "$PORT" || exit 1 # our own server from an earlier run
		fi
		held=$(listener)
		if [ -n "$held" ]; then
			echo "port $PORT is in use by pid $held ($(ps -o user= -o command= -p "$held" | cut -c1-120)): not started by this script; set PORT to a free port" >&2
			exit 1
		fi
	fi
fi
# Inspector port (#802). Chosen after the PORT stop above, so a server this
# script already recorded is gone before the check. An explicit port that
# another process still holds is refused. Unset picks a free port.
free_port() { bind_free_port; }
inspector_listener() { lsof -t -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -u | head -1; }
inspector_chose=0
if [ -z "${INSPECTOR_PORT:-}" ]; then
	inspector_chose=1
	i=0
	INSPECTOR_PORT=
	while [ "$i" -lt 20 ]; do
		INSPECTOR_PORT=$(free_port) || { echo "could not pick a free inspector port" >&2; exit 1; }
		case "$INSPECTOR_PORT" in
			''|*[!0-9]*) INSPECTOR_PORT=; i=$((i + 1)); continue ;;
		esac
		if [ "$INSPECTOR_PORT" = "$PORT" ]; then
			i=$((i + 1))
			continue
		fi
		ih=$(inspector_listener "$INSPECTOR_PORT")
		if [ -z "$ih" ]; then
			break
		fi
		INSPECTOR_PORT=
		i=$((i + 1))
	done
	if [ -z "$INSPECTOR_PORT" ]; then
		echo "could not pick a free inspector port" >&2
		exit 1
	fi
else
	case "$INSPECTOR_PORT" in
		*[!0-9]*)
			echo "INSPECTOR_PORT must be a port number, got: $INSPECTOR_PORT" >&2
			exit 1
			;;
	esac
	if [ "${#INSPECTOR_PORT}" -gt 5 ]; then
		echo "INSPECTOR_PORT must be a port from 1 to 65535, got: $INSPECTOR_PORT" >&2
		exit 1
	fi
	n=$((10#$INSPECTOR_PORT))
	if [ "$n" -lt 1 ] || [ "$n" -gt 65535 ]; then
		echo "INSPECTOR_PORT must be a port from 1 to 65535, got: $INSPECTOR_PORT" >&2
		exit 1
	fi
	INSPECTOR_PORT=$n
	ih=$(inspector_listener "$INSPECTOR_PORT")
	if [ -n "$ih" ]; then
		echo "inspector port $INSPECTOR_PORT is in use by pid $ih ($(ps -o user= -o command= -p "$ih" | cut -c1-120)): not started by this script; set INSPECTOR_PORT to a free port" >&2
		exit 1
	fi
fi
# Resolve (and on a fresh clone install) the pinned Wrangler in the foreground, so a missing or
# broken one fails here, loudly, not as a silent timeout below.
"$WR" --version > /dev/null || { echo "the pinned wrangler ($WR) does not run" >&2; exit 1; }
# Record the port before the server listens, so a later step of this build
# reads the same one. Print only when this run chose it.
printf '%s\n' "$PORT" > .dev-port
if [ "$port_chose" = 1 ]; then
	echo "port $PORT"
fi
if [ "$inspector_chose" = 1 ]; then
	echo "inspector port $INSPECTOR_PORT"
fi
rm -f out.json; : > dev.log
# SITE_ORIGIN (issue #33): the site's links are localhost:<port>, the address
# e2e.sh and opcache.sh use, whatever request boots PHP first.
# DEV_LOCAL=1: --local, no remote bindings (#371). The env's AI binding has no local mode, so
# without it wrangler dev starts a remote proxy session, which needs a Cloudflare login.
# DEV_LOG_LEVEL: wrangler's --log-level (default warn); log keeps the Worker's console lines in dev.log (#766).
# DEV_VARS: more vars, "NAME:value" separated by spaces (opcache.sh sets PHP_RECYCLE:off).
# PERSIST_TO: the local state directory (default .wrangler/state). opcache.sh passes a fresh,
# empty one, so what it primes depends on the build, not on what an earlier run left (#313).
vars=()
for v in ${DEV_VARS:-}; do vars+=(--var "$v"); done
# Own session: the process group is this server alone, so a group signal
# cannot reach the shell that started it. The pid is the process group id.
python3 -I -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
	"$WR" dev --port "$PORT" --inspector-port "$INSPECTOR_PORT" --log-level "${DEV_LOG_LEVEL:-warn}" ${DEV_LOCAL:+--local} ${DEV_ENV:+--env $DEV_ENV} ${PERSIST_TO:+--persist-to "$PERSIST_TO"} --var "SITE_ORIGIN:http://localhost:$PORT" --var "SPIKE_TOKEN:${SPIKE_TOKEN:-local-spike-token}" "${vars[@]}" > dev.log 2>&1 &
started=$!
record_server "$started" "$PORT"
up=0
devlog() { grep -v '^\s*$' dev.log | grep -v '🪵' | tail -20 | cut -c1-400 >&2; }
for _ in $(seq 1 "$DEV_WAIT_S"); do
	# Refresh the tree while the server is coming up, so a child that
	# appears after the first record is in the pid file if the parent dies.
	record_server "$started" "$PORT"
	grep -q 'ERROR' dev.log && { devlog; stop_port "$PORT" || true; exit 1; }
	# wrangler dev exited (a start failure that prints no ERROR): say so now, with its log.
	kill -0 "$started" 2>/dev/null || { echo "wrangler dev exited before it answered on port $PORT; last lines of dev.log:" >&2; devlog; stop_port "$PORT" || true; exit 1; }
	curl -H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}" -s -m 2 -o /dev/null "localhost:$PORT/_ping" 2>/dev/null && { up=1; break; }
	sleep 1
done
[ "$up" = 1 ] || { echo "wrangler dev did not answer on port $PORT in $DEV_WAIT_S s; last lines of dev.log:" >&2; devlog; stop_port "$PORT" || true; exit 1; }
# The port was free before the start. Record the listener and the whole tree.
record_server "$started" "$PORT"
curl -H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}" -s -m 120 "localhost:$PORT/${1:-}" -o out.json; echo "http_exit=$?"
head -c 2000 out.json; echo
grep -v '^\s*$' dev.log | grep -v '🪵' | tail -8 | cut -c1-400
