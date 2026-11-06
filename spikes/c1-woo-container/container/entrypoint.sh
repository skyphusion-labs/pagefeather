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
# Object cache: OBJECT_CACHE=apcu (the default) puts the APCu drop-in in
# place; none runs without one. APCu memory belongs to PHP's server process and its
# forked workers, so it starts empty with every container.
if [ "${OBJECT_CACHE:-apcu}" != none ]; then
	cp /opt/wp/object-cache.php /var/www/html/wp-content/object-cache.php
else
	rm -f /var/www/html/wp-content/object-cache.php
fi
# Litestream runs as a child, not PID 1: Linux ignores SIGKILL sent to PID 1
# from inside the container, so a crash could not be tested. This shell
# forwards SIGTERM, so a normal stop still lets Litestream finish its sync.
litestream replicate -config /etc/litestream.yml -exec "php -S 0.0.0.0:80 -t /var/www/html /var/www/html/router.php" &
LS=$!
echo "$LS" > /run/litestream.pid
trap 'kill -TERM "$LS"; wait "$LS"; exit $?' TERM INT

# Sampler for the concurrency work (container/stats.php, what=samples), every
# 2 s: time, the /proc/stat cpu line (user nice system idle iowait irq softirq
# steal, in ticks), the cgroup cpu.stat if there is one (usage and throttling),
# the load average, the accept backlog of port 80 (connections that no PHP
# worker took yet), and the PHP processes by state (R running, S sleeping,
# D disk wait).
(
	while :; do
		t=$(date +%s.%N | cut -c1-14)
		cpu=$(head -1 /proc/stat | cut -d" " -f3-)
		cg=""
		[ -r /sys/fs/cgroup/cpu.stat ] && cg=$(awk '{printf "%s=%s ", $1, $2}' /sys/fs/cgroup/cpu.stat)
		load=$(cut -d" " -f1-4 /proc/loadavg)
		bl=$(cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk 'function hex(x, i, n) { n = 0; x = tolower(x); for (i = 1; i <= length(x); i++) n = n * 16 + index("0123456789abcdef", substr(x, i, 1)) - 1; return n } $4 == "0A" && $2 ~ /:0050$/ { split($5, q, ":"); n += hex(q[2]) } END { print n + 0 }')
		ps=$(cat /proc/[0-9]*/stat 2>/dev/null | awk '$2 == "(php)" { s[$3]++ } END { for (k in s) printf "%s%d ", k, s[k] }')
		echo "$t cpu $cpu | cg $cg| load $load | backlog $bl | php $ps" >> /tmp/c1-samples.log
		sleep 2
	done
) &

# Queue runner (issue #45): with QUEUE_RUNNER=local (the default), request
# wp-cron.php from inside the container every CRON_SECONDS (60). It runs in
# PHP's own server, so it shares the APCu object cache, and it does not go out
# through the Worker. php/c1-queue.php turns Action Scheduler's async loopback
# off. router.php does not count these requests as activity, so they do not
# keep an idle container awake.
if [ "${QUEUE_RUNNER:-local}" = local ]; then
	(
		while sleep "${CRON_SECONDS:-60}"; do
			# No ?doing_wp_cron=: wp-cron.php then takes its own lock. With a key that
			# no spawn_cron() set, it returns at once and runs nothing (seen locally).
			curl -s -o /dev/null -m 120 http://127.0.0.1/wp-cron.php || true
		done
	) &
fi

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
