#!/bin/bash
# Spike C1 (issue #99): the web server that Litestream runs (-exec in
# entrypoint.sh). It starts PHP-FPM and nginx in the foreground and supervises
# both:
# - If one of them exits, it stops the other and exits 1. Litestream then
#   exits and the container ends, as it did when php -S died.
# - On SIGTERM, SIGINT or SIGQUIT (Litestream forwards its own signal to this process,
#   cmd/litestream/replicate.go v0.5.18, shutdown()), it stops both and exits
#   0. Litestream then does its final sync.
# Needs bash 5 (wait -n): the image has it; macOS /bin/bash 3.2 does not.
set -u
# /proc/$$: this shell (inside $( ), /proc/self/fd/2 is the capture pipe).
echo "c1-serve: start, fd2 $(readlink /proc/$$/fd/2)"
# Logs through pipes (issue #99). php-fpm (error_log = /proc/self/fd/2, from
# the base image) and nginx (error_log /dev/stderr) OPEN that path, and opening
# /proc/self/fd/2 fails (ENXIO) when stderr is a socket. A pipe always opens.
# The cat processes write to the real stdout and stderr, which works for any
# kind of file.
# Each line also goes to the boot log (bootlog.sh, BOOT_LOG) with the epoch
# time, written there first.
relay() {
	local tag=$1 fd=$2 l
	while IFS= read -r l; do
		[ -z "${BOOT_LOG:-}" ] || printf '%s %s %s\n' "$EPOCHREALTIME" "$tag" "$l" >> "$BOOT_LOG"
		printf '%s\n' "$l" >&"$fd"
	done
}
exec 2> >(relay err 2)
exec 1> >(relay out 1)
FPM=""
NGX=""
# Stop: SIGQUIT first (a graceful stop in nginx and PHP-FPM: requests in
# progress finish), then SIGKILL after STOP_GRACE_S (10). 10 s leaves time
# for the final Litestream sync inside the 30 s that /_store-stop waits for a
# stop (worker.js, issue #93). The bound is needed:
# bash starts a background child with SIGQUIT ignored, and a SIGQUIT that comes
# before the child sets its own handler is lost (measured locally, issue #99).
# Without the bound, this script would then wait for ever and the container
# would answer nothing.
stop() {
	local p i alive
	for p in $FPM $NGX; do kill -QUIT "$p" 2>/dev/null; done
	for ((i = 0; i < ${STOP_GRACE_S:-10}; i++)); do
		alive=0
		for p in $FPM $NGX; do kill -0 "$p" 2>/dev/null && alive=1; done
		[ "$alive" = 0 ] && break
		sleep 1
	done
	for p in $FPM $NGX; do kill -KILL "$p" 2>/dev/null; done
	# Only the two servers: a bare wait would also wait for the log pipes.
	wait "$FPM" "$NGX" 2>/dev/null
}
# SIGQUIT too, for a stop sent with the php-fpm image's own stop signal.
trap "stop; exit 0" TERM INT QUIT
echo "c1-serve: starting php-fpm"
php-fpm -F &
FPM=$!
echo "c1-serve: starting nginx"
nginx -g "daemon off;" &
NGX=$!
echo "c1-serve: php-fpm $FPM, nginx $NGX"
# The warm-up (issue #92): one request that boots WordPress in PHP-FPM, so the
# first shopper request after a start finds OPcache and APCu warm. In the
# background: the servers answer shoppers at once. Its lines go to the boot log.
if [ "${WARM_WP:-on}" = on ]; then
	(
		for i in $(seq 1 60); do curl -s -o /dev/null -m 2 http://127.0.0.1/_fpm-ping && break; sleep 0.5; done
		echo "c1-serve: warm: start"
		w=$(curl -s -m 300 http://127.0.0.1:8081/_warm 2>&1) || true
		echo "c1-serve: warm: done ${w:-no answer}"
	) &
fi
wait -n -p died "$FPM" "$NGX"
rc=$?
[ "${died:-}" = "$FPM" ] && who=php-fpm || who=nginx
echo "c1-serve: $who (pid ${died:-unknown}) exited with status $rc" >&2
# A signal interrupts wait with a status above 128 and runs the trap, which
# exits; so here one of the two servers really exited.
stop
exit 1
