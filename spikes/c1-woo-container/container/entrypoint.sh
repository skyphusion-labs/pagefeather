#!/bin/sh
# Spike C1 container start:
# 1. Restore the SQLite file from R2 if a replica exists (a sleeping container
#    loses its disk).
# 2. Otherwise install WordPress and WooCommerce.
# 3. Run PHP-FPM and nginx (container/c1-serve.sh, issue #99) under
#    Litestream, which replicates every change to R2 while PHP runs.
set -e
# Start steps go to the container log (issue #99), with the kind of stdout and
# stderr this runtime gives, and whether the stderr path can be opened (php-fpm
# and nginx open it). /proc/$$ is this shell: inside $( ) or a subshell with a
# redirect, /proc/self/fd/1 and 2 are the capture pipe or /dev/null instead
# (the first version read those, and always said pipe and ok).
# The same lines go to the boot log in R2 (bootlog.sh): the container's stdout
# and stderr do not reach Workers Logs.
. /usr/local/bin/bootlog.sh
trap 'blog "entrypoint exit"; bput' EXIT
bloop &
blog "entrypoint start, uid $(id -u), kernel $(uname -r)"
blog "status $(grep -E '^(Uid|Gid|CapEff|CapBnd|NoNewPrivs|Seccomp):' /proc/$$/status | tr '\t\n' '  ')"
blog "fd1 $(readlink /proc/$$/fd/1), fd2 $(readlink /proc/$$/fd/2)"
if ( : >> /proc/$$/fd/2 ) 2>/dev/null; then blog "open of the stderr path ok"; else blog "open of the stderr path FAILED"; fi
# php-fpm-c1.conf reads it: pm.max_children.
export PHP_WORKERS="${PHP_WORKERS:-2}"
# A new id for each container start: tests use it to prove a restart happened.
cat /proc/sys/kernel/random/uuid > /var/www/html/_boot.txt
mkdir -p /data
# The logs that PHP appends to, made now and owned by www-data (issue #104).
# install.php and the seed step run PHP as root; a mail sent then (the "new
# site" mail) created /tmp/c1-mail.log owned by root, and the PHP-FPM children
# (www-data) could not append to it: every later line was lost in silence
# (measured on wp-c1-mail, 2026-11-06).
for f in /tmp/c1-mail.log /tmp/c1-req.log /tmp/c1-purge.log; do
	: >> "$f"
	chown www-data:www-data "$f"
	chmod 0644 "$f"
done
blog "PHP logs owned by $(stat -c %U /tmp/c1-mail.log)"
litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists /data/wordpress.sqlite
blog "restore done (database file: $( [ -f /data/wordpress.sqlite ] && echo yes || echo no))"
# Import (issue #31): load the seed when there is no replica (seed.sh).
. /opt/wp/seed.sh
seed_load
if [ ! -f /data/wordpress.sqlite ]; then
	echo "no replica: installing"
	php /var/www/html/install.php
fi
chown -R www-data:www-data /data 2>/dev/null || true
blog "/data owner $(stat -c %U /data)"
# Object cache: OBJECT_CACHE=apcu (the default) puts the APCu drop-in in
# place; none runs without one. APCu memory belongs to the PHP-FPM master and
# its children, so it starts empty with every container.
if [ "${OBJECT_CACHE:-apcu}" != none ]; then
	cp /opt/wp/object-cache.php /var/www/html/wp-content/object-cache.php
else
	rm -f /var/www/html/wp-content/object-cache.php
fi
# Litestream runs as a child, not PID 1: Linux ignores SIGKILL sent to PID 1
# from inside the container, so a crash could not be tested. This shell
# forwards SIGTERM, so a normal stop still lets Litestream finish its sync.
blog "starting litestream replicate with c1-serve.sh"
litestream replicate -config /etc/litestream.yml -exec /usr/local/bin/c1-serve.sh &
LS=$!
echo "$LS" > /run/litestream.pid
# Snapshots of processes, ports and inside answers after 5, 20 and 60 s.
( sleep 5; bsnap 5s; sleep 15; bsnap 20s; sleep 40; bsnap 60s ) &
# SIGQUIT too: the php-fpm base image used it as its stop signal (issue #99).
trap 'kill -TERM "$LS"; wait "$LS"; exit $?' TERM INT QUIT

# Sampler for the concurrency work (container/stats.php, what=samples), every
# 2 s: time, the /proc/stat cpu line (user nice system idle iowait irq softirq
# steal, in ticks), the cgroup cpu.stat if there is one (usage and throttling),
# the load average, the accept backlog of port 9000 (PHP-FPM: requests that no
# free child took yet), the PHP-FPM children by state (R running, S sleeping,
# D disk wait; the master is not counted), and the proportional memory (PSS,
# kB) of all PHP-FPM processes and of all nginx processes.
(
	while :; do
		t=$(date +%s.%N | cut -c1-14)
		cpu=$(head -1 /proc/stat | cut -d" " -f3-)
		cg=""
		[ -r /sys/fs/cgroup/cpu.stat ] && cg=$(awk '{printf "%s=%s ", $1, $2}' /sys/fs/cgroup/cpu.stat)
		load=$(cut -d" " -f1-4 /proc/loadavg)
		bl=$(cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk 'function hex(x, i, n) { n = 0; x = tolower(x); for (i = 1; i <= length(x); i++) n = n * 16 + index("0123456789abcdef", substr(x, i, 1)) - 1; return n } $4 == "0A" && $2 ~ /:2328$/ { split($5, q, ":"); n += hex(q[2]) } END { print n + 0 }')
		master=0; read -r master < /run/php-fpm.pid 2>/dev/null || master=0
		ps=$(cat /proc/[0-9]*/stat 2>/dev/null | awk -v m="$master" '$2 == "(php-fpm)" && $1 != m { s[$3]++ } END { for (k in s) printf "%s%d ", k, s[k] }')
		# One awk for all processes, no fork per process: the first version ran
		# a cat for every process every 2 s, which cost several CPU seconds in a
		# 400 s run, more than nginx did (issue #99). awk reads each comm, and the
		# smaps_rollup of php-fpm and nginx only.
		pss=$(awk 'FNR == 1 && FILENAME ~ /comm$/ { c = $1; d = FILENAME; sub(/comm$/, "smaps_rollup", d); if (c == "php-fpm" || c == "nginx") { while ((getline l < d) > 0) if (l ~ /^Pss:/) { split(l, f); k[c] += f[2] } close(d) } } END { printf "fpm=%d nginx=%d", k["php-fpm"], k["nginx"] }' /proc/[0-9]*/comm 2>/dev/null)
		echo "$t cpu $cpu | cg $cg| load $load | backlog $bl | php $ps| pss $pss" >> /tmp/c1-samples.log
		sleep 2
	done
) &

# Queue runner (issue #45): with QUEUE_RUNNER=local (the default), request
# wp-cron.php from inside the container every CRON_SECONDS (10). It runs in
# PHP-FPM, so it shares the APCu object cache, and it does not go out
# through the Worker. php/c1-queue.php turns Action Scheduler's async loopback
# off. nginx.conf does not count these requests as activity, so they do not
# keep an idle container awake.
if [ "${QUEUE_RUNNER:-local}" = local ]; then
	(
		while sleep "${CRON_SECONDS:-10}"; do
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
# nginx appends a line to it for each request (nginx.conf).
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
set +e
wait "$LS"
rc=$?
blog "litestream exited (status $rc): the container ends"
exit $rc
