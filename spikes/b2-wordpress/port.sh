# shellcheck shell=bash
# A free TCP port on 127.0.0.1 (#839). The inspector pick (#808) is the same
# bind: python3 binds port 0, then lsof confirms nothing is listening.
# run.sh records the port it bound in .dev-port (this directory). Later steps
# learn that port with server_port. An explicit PORT is never changed.
# server_port fails when PORT is unset and .dev-port is missing. It does not
# pick a port, and it has no default.
# Sourced, not executed.

# One ephemeral port. Empty output and status 1 when the bind fails.
bind_free_port() {
	python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

# A port that is free after the bind is released. Retries when the port is
# taken between the bind and the check. Prints one port, or status 1.
pick_free_port() {
	local i=0 p n held
	while [ "$i" -lt 20 ]; do
		p=$(bind_free_port) || return 1
		case "$p" in
			''|*[!0-9]*) i=$((i + 1)); continue ;;
		esac
		if [ "${#p}" -gt 5 ]; then
			i=$((i + 1)); continue
		fi
		n=$((10#$p))
		if [ "$n" -lt 1 ] || [ "$n" -gt 65535 ]; then
			i=$((i + 1)); continue
		fi
		held=$(lsof -t -nP -iTCP:"$n" -sTCP:LISTEN 2>/dev/null | sort -u | head -1)
		if [ -z "$held" ]; then
			printf '%s\n' "$n"
			return 0
		fi
		i=$((i + 1))
	done
	return 1
}

# The port run.sh wrote, or status 1 when the file is missing or not a port.
read_recorded_port() {
	local p n
	[ -f .dev-port ] || return 1
	p=$(tr -d '[:space:]' < .dev-port)
	case "$p" in
		''|*[!0-9]*) return 1 ;;
	esac
	if [ "${#p}" -gt 5 ]; then
		return 1
	fi
	n=$((10#$p))
	if [ "$n" -lt 1 ] || [ "$n" -gt 65535 ]; then
		return 1
	fi
	printf '%s\n' "$n"
}

# The port a later step should use. Exports PORT.
#   PORT set: that value, unchanged. port_from=given.
#   .dev-port: the port run.sh recorded. port_from=recorded.
#   nothing set: a free port. port_from=picked. The caller prints "port N".
take_port() {
	local p
	port_from=given
	if [ -n "${PORT:-}" ]; then
		export PORT
		return 0
	fi
	port_from=recorded
	if p=$(read_recorded_port); then
		PORT=$p
		export PORT
		return 0
	fi
	port_from=picked
	p=$(pick_free_port) || return 1
	PORT=$p
	export PORT
	return 0
}

# Absolute directory of this file, captured at source time. run.sh writes
# .dev-port here after it cds to this directory. A relative BASH_SOURCE would
# point at the wrong place if the caller cds before server_port runs.
port_sh_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# The local wrangler port for opcache-a.sh (#1124). Prints one port.
#   OPCACHE_A_PORT set: that port. It wins over PORT.
#   else PORT set: that port. The operator pinned it.
#   neither: a free port (bind port 0). A taken 8798 is left alone.
# A pinned port that a process already holds is a failure. The line names
# the pid and the command. Nothing is killed. Status 1, and no port printed.
# A value that is not a port from 1 to 65535 is the same failure.
opcache_a_port() {
	local pin="" pin_name="" p n held
	if [ -n "${OPCACHE_A_PORT:-}" ]; then
		pin=$OPCACHE_A_PORT
		pin_name=OPCACHE_A_PORT
	elif [ -n "${PORT:-}" ]; then
		pin=$PORT
		pin_name=PORT
	fi
	if [ -z "$pin" ]; then
		p=$(pick_free_port) || return 1
		printf '%s\n' "$p"
		return 0
	fi
	case "$pin" in
		''|*[!0-9]*)
			echo "$pin_name must be a port from 1 to 65535, got: $pin" >&2
			return 1
			;;
	esac
	if [ "${#pin}" -gt 5 ]; then
		echo "$pin_name must be a port from 1 to 65535, got: $pin" >&2
		return 1
	fi
	n=$((10#$pin))
	if [ "$n" -lt 1 ] || [ "$n" -gt 65535 ]; then
		echo "$pin_name must be a port from 1 to 65535, got: $pin" >&2
		return 1
	fi
	# lsof exits 1 when nothing listens. The || true keeps set -e from
	# treating a free port as a failed command.
	held=$(lsof -t -nP -iTCP:"$n" -sTCP:LISTEN 2>/dev/null | sort -u | head -1 || true)
	if [ -n "$held" ]; then
		echo "port $n is in use by pid $held ($(ps -o user= -o command= -p "$held" | cut -c1-120)): set OPCACHE_A_PORT to a free port" >&2
		return 1
	fi
	printf '%s\n' "$n"
}

# The port of the server run.sh already started. Exports PORT.
#   PORT set: that value, unchanged. port_from=given.
#   .dev-port beside this file: the port run.sh recorded. port_from=recorded.
#   neither: status 1 and a line on stderr. Never a default port.
server_port() {
	local p
	port_from=given
	if [ -n "${PORT:-}" ]; then
		export PORT
		return 0
	fi
	port_from=recorded
	if [ ! -f "$port_sh_dir/.dev-port" ]; then
		echo "no PORT and no .dev-port in $port_sh_dir: run.sh did not record the port it bound" >&2
		return 1
	fi
	if p=$(cd "$port_sh_dir" && read_recorded_port); then
		PORT=$p
		export PORT
		return 0
	fi
	echo "no PORT and .dev-port in $port_sh_dir is not a port" >&2
	return 1
}

# #924: LOCAL_HTTPS=1 serves the local server over HTTPS (wrangler dev --local-protocol https, a self-signed
# certificate for localhost). WordPress allows application passwords only over HTTPS, so a local conformance seed
# needs it to reach its password step. Sets LOCAL_SCHEME (http or https), LOCAL_CURL_K (curl -k for wrangler's own
# certificate) and LOCAL_PROTO_ARGS (the wrangler flag). Unset or 0 is http; any other value is refused.
# The three globals are read by run.sh, which sources this file.
# shellcheck disable=SC2034
local_scheme() {
	case "${LOCAL_HTTPS:-}" in
		'' | 0) LOCAL_SCHEME=http; LOCAL_CURL_K=(); LOCAL_PROTO_ARGS=() ;;
		1) LOCAL_SCHEME=https; LOCAL_CURL_K=(-k); LOCAL_PROTO_ARGS=(--local-protocol https) ;;
		*) echo "LOCAL_HTTPS must be 1, 0 or unset, not \"${LOCAL_HTTPS}\"" >&2; return 1 ;;
	esac
}
