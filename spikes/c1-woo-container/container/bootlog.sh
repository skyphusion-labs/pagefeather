# Boot log to R2 (issue #99). Sourced by entrypoint.sh. POSIX sh.
#
# The container's stdout and stderr do not reach Workers Logs (measured
# 2026-11-06: 0 container events with observability on). So the start steps,
# the stderr of PHP-FPM and nginx (c1-serve.sh), and snapshots of the
# processes and ports go to /tmp/c1-boot.log, each line with the epoch time,
# and the file is PUT to the replica bucket as
#   <REPLICA_PATH>.boot-<start epoch>.log
# beside the replica (not inside its prefix, so Litestream never sees it), with
# the Litestream key. It works when nginx and PHP-FPM are dead.
# No secret goes into the log: no environment dump, no request bodies.
BOOT_LOG=/tmp/c1-boot.log
BOOT_START=$(date +%s)
BOOT_KEY="$REPLICA_PATH.boot-$BOOT_START.log"
export BOOT_LOG
: > "$BOOT_LOG"
blog() {
	printf '%s c1: %s\n' "$(date +%s.%N | cut -c1-14)" "$*" >> "$BOOT_LOG"
	echo "c1: $*"
}
bput() {
	[ -n "${R2_ENDPOINT:-}" ] && [ -n "${R2_BUCKET:-}" ] || return 0
	if [ ! -f /run/boot.curl ]; then
		old=$(umask); umask 077
		printf 'user = "%s:%s"\n' "$LITESTREAM_ACCESS_KEY_ID" "$LITESTREAM_SECRET_ACCESS_KEY" > /run/boot.curl
		umask "$old"
	fi
	curl -sS -m 20 -o /dev/null -K /run/boot.curl --aws-sigv4 "aws:amz:auto:s3" -T "$BOOT_LOG" "$R2_ENDPOINT/$R2_BUCKET/$BOOT_KEY" 2>/dev/null || true
}
# A snapshot: who runs (pid, ppid, state, uid, name), which ports listen, and
# whether nginx and PHP-FPM answer from inside.
bsnap() {
	blog "snapshot $1"
	for p in /proc/[0-9]*; do
		[ -r "$p/stat" ] || continue
		s=$(cut -d" " -f1-4 "$p/stat" 2>/dev/null)
		u=$(awk '/^Uid:/ { print $2 }' "$p/status" 2>/dev/null)
		blog "  proc $s uid $u"
	done
	awk '$4 == "0A" { print $2 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null | while read -r a; do blog "  listen $a"; done
	blog "  inside /ping $(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1/ping), /_fpm-ping $(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1/_fpm-ping)"
	bput
}
# Upload every 10 s for 10 minutes, then every 60 s, when the file grew.
bloop() {
	last=-1
	while :; do
		n=$(wc -c < "$BOOT_LOG")
		[ "$n" = "$last" ] || { bput; last=$n; }
		if [ $(( $(date +%s) - BOOT_START )) -lt 600 ]; then sleep 10; else sleep 60; fi
	done
}
