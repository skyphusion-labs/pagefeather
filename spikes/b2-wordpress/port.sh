# shellcheck shell=bash
# A free TCP port on 127.0.0.1 (#839). The inspector pick (#808) is the same
# bind: python3 binds port 0, then lsof confirms nothing is listening.
# run.sh records the port it bound in .dev-port (this directory). Later steps
# export that port. An explicit PORT is never changed.
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
