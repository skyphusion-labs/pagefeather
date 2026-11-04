#!/bin/sh
# Spike C1 container start:
# 1. Restore the SQLite file from R2 if a replica exists (a sleeping container
#    loses its disk).
# 2. Otherwise install WordPress and WooCommerce.
# 3. Run PHP's server under Litestream, which replicates every change to R2
#    while PHP runs.
set -e
export PHP_CLI_SERVER_WORKERS="${PHP_WORKERS:-2}"
# A new id for each container start: tests use it to prove a restart happened.
cat /proc/sys/kernel/random/uuid > /var/www/html/_boot.txt
mkdir -p /data
litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists /data/wordpress.sqlite
if [ ! -f /data/wordpress.sqlite ]; then
	echo "no replica: installing"
	php /var/www/html/install.php
fi
chown -R www-data:www-data /data 2>/dev/null || true
# Litestream runs as a child, not PID 1: Linux ignores SIGKILL sent to PID 1
# from inside the container, so a crash could not be tested. This shell
# forwards SIGTERM, so a normal stop still lets Litestream finish its sync.
litestream replicate -config /etc/litestream.yml -exec "php -S 0.0.0.0:80 -t /var/www/html /var/www/html/router.php" &
LS=$!
echo "$LS" > /run/litestream.pid
trap 'kill -TERM "$LS"; wait "$LS"; exit $?' TERM INT

# Idle shutdown. The Container class sleepAfter never stopped this container:
# its Durable Object reported running=false and did nothing (measured
# 2026-11-04: the same container after 17 idle minutes). So the container
# stops itself: after IDLE_SECONDS with no request, SIGTERM to Litestream (it
# finishes its sync), and the container exits. The next request starts a new
# one, which restores the database from R2.
touch /tmp/last-request
(
	while sleep 60; do
		idle=$(( $(date +%s) - $(stat -c %Y /tmp/last-request) ))
		if [ "$idle" -ge "${IDLE_SECONDS:-900}" ]; then
			echo "idle ${idle} s: stopping"
			kill -TERM "$LS"
			exit 0
		fi
	done
) &
wait "$LS"
