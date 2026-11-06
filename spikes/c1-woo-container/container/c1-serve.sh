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
	wait 2>/dev/null
}
# SIGQUIT too, for a stop sent with the php-fpm image's own stop signal.
trap "stop; exit 0" TERM INT QUIT
php-fpm -F &
FPM=$!
nginx -g "daemon off;" &
NGX=$!
wait -n "$FPM" "$NGX"
rc=$?
# A signal interrupts wait with a status above 128 and runs the trap, which
# exits; so here one of the two servers really exited.
echo "c1-serve: php-fpm or nginx exited (status $rc): stopping the other" >&2
stop
exit 1
