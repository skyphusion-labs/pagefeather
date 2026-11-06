#!/bin/bash
# Test of the warm-up (issue #92): container/warm.php and its nginx server on
# 127.0.0.1:8081. Runs INSIDE the c1 image, as root, with no Litestream:
#   docker run --rm -v "$PWD/spikes/c1-woo-container/tests:/t" \
#     --entrypoint bash <image> /t/warm-image-test.sh
# It installs WordPress and WooCommerce on an empty /data (install.php) and
# keeps a copy of that database (pristine). Every case starts new servers
# (c1-serve.sh with WARM_WP=off), after the old ones are proven gone, so
# OPcache is cold and a changed file is read again (validate_timestamps=0).
#
# Shipped checks (each must hold):
#   reach    GET 127.0.0.1:8081/_warm: 200 and an x-c1-warm header
#   compile  its OPcache scripts after are more than before
#   cookie   no Set-Cookie in that answer
#   nowrite  on a site that has served a page (pristine, then one GET /), the
#            warm-up writes NOTHING: PRAGMA data_version on a connection held
#            across the call, the row counts and the option names and value
#            hashes of wp_options, the Action Scheduler actions (hook and
#            status), logs, claims and groups, and wp_woocommerce_sessions
#   subset   on a pristine site (no page served yet), the warm-up writes only
#            what a first GET / writes on the same pristine site: its added
#            and changed option names and its new action hooks are a subset
#   port80   GET 127.0.0.1/_warm (port 80, where the Worker comes in) has no
#            x-c1-warm header: warm.php did not run
#   eth0     a connect to <container address>:8081 is refused
#   listen   /proc/net/tcp and tcp6: port 8081 listens on 127.0.0.1 only
#   bound    WARM_MAX_FILES=5: compiled 5, stop "max files"
#   lowmem   opcache.memory_consumption=40: stop at "opcache free below
#            16 MiB", and no OPcache restart (oom 0)
#   trigger  c1-serve.sh's own warm-up (WARM_WP=on, no manual call), with
#            PHP-FPM started 3 s late: the boot log gets "warm: done {json}"
#            with compiled > 0 (seen live 2026-11-06: the warm-up got nginx's
#            502 before FPM accepted, and logged the 502 page as done)
#   trigfail the same trigger with warm.php missing: "warm: failed (HTTP 404)"
#            and no "warm: done"
# Arms that must FAIL a named check, or the check cannot see its defect:
#   listen 0.0.0.0:8081                      listen, eth0 (the deny line answers 403)
#   listen 0.0.0.0:8081, no allow and deny   eth0 (and the answer runs warm.php)
#   an extra listen [::]:8081                listen
#   /_warm on port 80                        port80
#   a plugin sets a cookie on init           cookie holds with the shipped warm.php,
#                                            and fails with header_remove() taken out
#   a plugin writes an option on init        nowrite
#   c1-serve.sh waits for any /_fpm-ping answer, not a 200   trigger
#   c1-serve.sh logs any answer as done      trigfail
#   warm.php minus DISABLE_WP_CRON           nowrite: reported, not required (it
#                                            writes only when a cron event is due)
# Exit 0 only when every shipped check holds and every required arm fails.
set -u
export PHP_WORKERS=2 PUBLIC_HOST=localhost ADMIN_PASSWORD=warm-test-password SPIKE_TOKEN=t WARM_WP=off OBJECT_CACHE=apcu
W=/opt/wp/warm.php
MU=/var/www/html/wp-content/mu-plugins
DB=/data/wordpress.sqlite
cp /etc/nginx/nginx.conf /tmp/nginx.shipped.conf
cp "$W" /tmp/warm.shipped.php
fails=0
say() { printf '%s\n' "$*"; }
# check <name> <1 holds | 0 fails>: a shipped check.
check() { if [ "$2" = 1 ]; then say "  ok   $1"; else say "  FAIL $1"; fails=$((fails + 1)); fi; }
# must_fail <arm> <check> <1 holds | 0 fails>: an arm.
must_fail() { if [ "$3" = 0 ]; then say "  ok   arm \"$1\" fails $2"; else say "  FAIL arm \"$1\": $2 still holds, so the check is blind"; fails=$((fails + 1)); fi; }

mkdir -p /data
php /var/www/html/install.php || { say "FAIL install"; exit 1; }
chown -R www-data:www-data /data
cp /opt/wp/object-cache.php /var/www/html/wp-content/object-cache.php
: > /tmp/c1-req.log; chown www-data /tmp/c1-req.log
for f in "$DB" "$DB-wal" "$DB-shm"; do [ -f "$f" ] && cp -p "$f" "/tmp/pristine.$(basename "$f")"; done

# Listening sockets: "<hex address> <hex port>" from /proc/net/tcp and tcp6.
listening() { awk '$4 == "0A" { split($2, a, ":"); print a[1], a[2] }' /proc/net/tcp /proc/net/tcp6 2>/dev/null; }
port_up() { listening | awk -v p="$1" '$2 == p { f = 1 } END { exit f ? 0 : 1 }'; }
# 1 when port 8081 (1F91) listens, and only on 127.0.0.1 (0100007F).
loopback_only() { listening | awk '$2 == "1F91" { n++; if ($1 != "0100007F") bad = 1 } END { print (n > 0 && !bad) ? 1 : 0 }'; }

# Signal every process named nginx or php-fpm (from /proc: the image has no pkill).
killname() { local sig=$1 d c; for d in /proc/[0-9]*; do c=$(cat "$d/comm" 2>/dev/null) || continue; case "$c" in nginx|php-fpm*) kill "-$sig" "${d#/proc/}" 2>/dev/null ;; esac; done; }
S=""
stop_servers() {
	[ -n "$S" ] && kill -TERM "$S" 2>/dev/null && wait "$S" 2>/dev/null
	S=""
	killname QUIT
	local i
	for i in $(seq 1 40); do
		port_up 0050 || port_up 1F91 || port_up 2328 || return 0
		sleep 0.25
	done
	killname KILL; sleep 1
	if port_up 0050 || port_up 1F91 || port_up 2328; then say "FAIL the old servers did not stop"; exit 1; fi
}
serve() {
	stop_servers
	/usr/local/bin/c1-serve.sh > /tmp/warm-serve.log 2>&1 & S=$!
	local i
	# A 200, not any answer: nginx answers 502 until PHP-FPM accepts.
	for i in $(seq 1 120); do [ "$(curl -s -o /dev/null -w '%{http_code}' -m 1 http://127.0.0.1/_fpm-ping)" = 200 ] && return 0; sleep 0.5; done
	say "FAIL the servers did not answer"; cat /tmp/warm-serve.log; exit 1
}
pristine() {
	stop_servers
	rm -f "$DB" "$DB-wal" "$DB-shm"
	for f in /tmp/pristine.*; do cp -p "$f" "/data/${f#/tmp/pristine.}"; done
}
hdr() { tr -d '\r' < /tmp/warm.h | awk -F': ' -v k="$1" 'tolower($1) == k { print substr($0, length($1) + 3) }'; }

# diffcall <url> <out.json>: GET <url> with the database held open on one
# connection; writes data_version, the counts, and the names of what changed.
diffcall() {
	php -r '
$db = new PDO("sqlite:/data/wordpress.sqlite");
$snap = function () use ($db) {
	$o = array("data_version" => (int) $db->query("PRAGMA data_version")->fetchColumn(), "counts" => array(), "options" => array(), "actions" => array());
	foreach (array("wp_options", "wp_actionscheduler_actions", "wp_actionscheduler_logs", "wp_actionscheduler_claims", "wp_actionscheduler_groups", "wp_woocommerce_sessions") as $t) {
		$o["counts"][$t] = (int) $db->query("SELECT COUNT(*) FROM $t")->fetchColumn();
	}
	foreach ($db->query("SELECT option_name, option_value FROM wp_options") as $r) { $o["options"][$r[0]] = md5((string) $r[1]); }
	foreach ($db->query("SELECT hook, status FROM wp_actionscheduler_actions") as $r) { $o["actions"][] = $r[0] . " " . $r[1]; }
	return $o;
};
$b = $snap();
$rc = (int) trim((string) shell_exec("curl -s -m 300 -D /tmp/warm.h -o /tmp/warm.b " . escapeshellarg($argv[1]) . "; echo $?"));
$a = $snap();
$added = array_values(array_diff(array_keys($a["options"]), array_keys($b["options"])));
$removed = array_values(array_diff(array_keys($b["options"]), array_keys($a["options"])));
$changed = array();
foreach ($a["options"] as $k => $h) { if (isset($b["options"][$k]) && $b["options"][$k] !== $h) { $changed[] = $k; } }
$d = array("curl" => $rc, "data_version" => array($b["data_version"], $a["data_version"]), "counts_before" => $b["counts"], "counts_after" => $a["counts"],
	"options_added" => $added, "options_removed" => $removed, "options_changed" => $changed,
	"actions_added" => array_values(array_diff($a["actions"], $b["actions"])));
$d["wrote"] = $b["data_version"] !== $a["data_version"] || $b["counts"] !== $a["counts"] || $added || $removed || $changed || $d["actions_added"];
file_put_contents($argv[2], json_encode($d));' "$1" "$2"
}
wrote() { php -r '$d = json_decode(file_get_contents($argv[1]), true); echo $d["wrote"] ? 1 : 0;' "$1"; }
show() { php -r '$d = json_decode(file_get_contents($argv[1]), true); unset($d["counts_before"]); echo "  ", json_encode($d), "\n";' "$1"; }

# nowrite_case <label>: pristine site, new servers, one GET / (a shopper), then
# the warm-up. Prints the diffs; returns the warm-up diff in /tmp/<label>.warm.json.
nowrite_case() {
	pristine; serve
	diffcall "http://127.0.0.1/" "/tmp/$1.get.json"
	diffcall "http://127.0.0.1:8081/_warm" "/tmp/$1.warm.json"
	say "  after a GET /, the warm-up:"; show "/tmp/$1.warm.json"
}

say "== shipped: a pristine site, the warm-up first"
pristine; serve
diffcall "http://127.0.0.1:8081/_warm" /tmp/first.warm.json
code=$(head -1 /tmp/warm.h | cut -d' ' -f2); w=$(hdr x-c1-warm)
say "  warm: $code $w"; say "  its writes (a first boot):"; show /tmp/first.warm.json
check "reach (200 and x-c1-warm)" "$([ "$code" = 200 ] && [ -n "$w" ] && echo 1 || echo 0)"
check "compile (OPcache scripts grow)" "$(php -r '$w = json_decode($argv[1], true); echo is_array($w) && $w["after"]["scripts"] > $w["before"]["scripts"] ? 1 : 0;' "$w")"
check "cookie (no Set-Cookie)" "$([ -z "$(hdr set-cookie)" ] && echo 1 || echo 0)"
say "== shipped: a pristine site, a first GET / (what a first shopper writes)"
pristine; serve
diffcall "http://127.0.0.1/" /tmp/first.get.json
show /tmp/first.get.json
check "subset (the warm-up's first-boot writes are a subset of a first GET /'s)" "$(php -r '
$w = json_decode(file_get_contents("/tmp/first.warm.json"), true); $g = json_decode(file_get_contents("/tmp/first.get.json"), true);
$hooks = function ($l) { return array_map(function ($x) { return explode(" ", $x)[0]; }, $l); };
$extra = array_merge(array_diff($w["options_added"], $g["options_added"]), array_diff($w["options_changed"], array_merge($g["options_changed"], $g["options_added"])),
	array_diff($w["options_removed"], $g["options_removed"]), array_diff($hooks($w["actions_added"]), $hooks($g["actions_added"])));
if ($extra) { fwrite(STDERR, "  only the warm-up wrote: " . implode(", ", $extra) . "\n"); }
echo $extra ? 0 : 1;')"
say "== shipped: a site that has served (pristine, a GET /, then the warm-up)"
nowrite_case served
check "nowrite (nothing written after a GET /)" "$([ "$(wrote /tmp/served.warm.json)" = 0 ] && echo 1 || echo 0)"
curl -s -m 30 -D /tmp/warm.h -o /dev/null http://127.0.0.1/_warm
check "port80 (no x-c1-warm on port 80; got $(head -1 /tmp/warm.h | cut -d' ' -f2))" "$([ -z "$(hdr x-c1-warm)" ] && echo 1 || echo 0)"
ip=$(php -r 'echo gethostbyname(gethostname());')
curl -s -m 5 -o /dev/null "http://$ip:8081/_warm"; rc=$?
check "eth0 ($ip:8081 refused, curl exit $rc)" "$([ "$rc" = 7 ] && echo 1 || echo 0)"
check "listen (8081 on: $(listening | awk '$2 == "1F91" { printf "%s ", $1 }'))" "$(loopback_only)"

say "== bound: WARM_MAX_FILES=5"
WARM_MAX_FILES=5 serve
curl -s -m 300 -D /tmp/warm.h -o /dev/null http://127.0.0.1:8081/_warm; w=$(hdr x-c1-warm); say "  $w"
check "bound (compiled 5, stop max files)" "$(php -r '$w = json_decode($argv[1], true); echo is_array($w) && $w["compiled"] === 5 && $w["stop"] === "max files" ? 1 : 0;' "$w")"
say "== lowmem: opcache.memory_consumption=40"
mkdir -p /tmp/ini && echo "opcache.memory_consumption=40" > /tmp/ini/zz-low.ini
PHP_INI_SCAN_DIR=":/tmp/ini" serve
curl -s -m 300 -D /tmp/warm.h -o /dev/null http://127.0.0.1:8081/_warm; w=$(hdr x-c1-warm); say "  $w"
oom=$(curl -s -H "x-spike-token: t" "http://127.0.0.1/_stats.php?what=info" | php -r '$i = json_decode(stream_get_contents(STDIN), true); echo $i["opcache"]["oom"] ?? "none";')
check "lowmem (stop at free below 16 MiB, oom $oom)" "$(php -r '$w = json_decode($argv[1], true); echo is_array($w) && $w["stop"] === "opcache free below 16 MiB" && $argv[2] === "0" ? 1 : 0;' "$w" "$oom")"
rm -rf /tmp/ini

# trigger_case <label>: c1-serve.sh's own warm-up from a cold start, with
# PHP-FPM 3 s late (a shim on PATH), and its boot log. Waits for the warm line.
FPM_BIN=$(command -v php-fpm)
mkdir -p /tmp/slowbin
printf '#!/bin/sh\nsleep 3\nexec %s "$@"\n' "$FPM_BIN" > /tmp/slowbin/php-fpm; chmod +x /tmp/slowbin/php-fpm
trigger_case() {
	: > /tmp/trig-boot.log
	WARM_WP=on BOOT_LOG=/tmp/trig-boot.log PATH="/tmp/slowbin:$PATH" serve
	local i
	for i in $(seq 1 180); do grep -q 'c1-serve: warm: \(done\|failed\)' /tmp/trig-boot.log && break; sleep 0.5; done
	say "  $1: $(grep 'c1-serve: warm:' /tmp/trig-boot.log | cut -d' ' -f2- | cut -c1-220 | tr '\n' '|')"
}
trig_done() { grep 'c1-serve: warm: done {' /tmp/trig-boot.log | sed 's/.*warm: done //' | php -r '$w = json_decode(stream_get_contents(STDIN), true); echo is_array($w) && $w["compiled"] > 0 ? 1 : 0;'; }
trig_failed404() { grep -q 'c1-serve: warm: failed (HTTP 404)' /tmp/trig-boot.log && ! grep -q 'c1-serve: warm: done' /tmp/trig-boot.log && echo 1 || echo 0; }
CS=/usr/local/bin/c1-serve.sh
cp "$CS" /tmp/c1-serve.shipped.sh

say "== trigger: c1-serve.sh's own warm-up, PHP-FPM 3 s late"
pristine
trigger_case shipped
check "trigger (warm: done with warm.php's JSON, from a cold start)" "$(trig_done)"
say "== trigfail: the same trigger, warm.php missing"
sed 's#fastcgi_param SCRIPT_FILENAME /opt/wp/warm.php;#fastcgi_param SCRIPT_FILENAME /opt/wp/missing.php;#' /tmp/nginx.shipped.conf > /etc/nginx/nginx.conf
trigger_case missing
check "trigfail (warm: failed (HTTP 404), no done)" "$(trig_failed404)"
cp /tmp/nginx.shipped.conf /etc/nginx/nginx.conf

say "== arm: c1-serve.sh waits for any /_fpm-ping answer (the 2026-11-06 trigger)"
perl -pe 's{\[ "\$\(curl -s -o /dev/null -w .%\{http_code\}. -m 2 http://127\.0\.0\.1/_fpm-ping\)" = 200 \] && \{ ready=1; break; \}}{curl -s -o /dev/null -m 2 http://127.0.0.1/_fpm-ping && { ready=1; break; }}' /tmp/c1-serve.shipped.sh > "$CS"
cmp -s "$CS" /tmp/c1-serve.shipped.sh && { say "  FAIL the wait arm did not apply"; fails=$((fails + 1)); }
trigger_case "any answer"
must_fail "wait for any /_fpm-ping answer" trigger "$(trig_done)"
say "== arm: c1-serve.sh logs any answer as done"
perl -pe 's{^(\t+)200:\\\{\*\)}{$1*)}' /tmp/c1-serve.shipped.sh > "$CS"
cmp -s "$CS" /tmp/c1-serve.shipped.sh && { say "  FAIL the done arm did not apply"; fails=$((fails + 1)); }
sed 's#fastcgi_param SCRIPT_FILENAME /opt/wp/warm.php;#fastcgi_param SCRIPT_FILENAME /opt/wp/missing.php;#' /tmp/nginx.shipped.conf > /etc/nginx/nginx.conf
trigger_case "any answer is done"
must_fail "any answer is done" trigfail "$(trig_failed404)"
cp /tmp/c1-serve.shipped.sh "$CS"; cp /tmp/nginx.shipped.conf /etc/nginx/nginx.conf

say "== arm: listen 0.0.0.0:8081"
sed 's/listen 127\.0\.0\.1:8081;/listen 0.0.0.0:8081;/' /tmp/nginx.shipped.conf > /etc/nginx/nginx.conf
serve
say "  8081 on: $(listening | awk '$2 == "1F91" { printf "%s ", $1 }')"
must_fail "listen 0.0.0.0:8081" listen "$(loopback_only)"
c=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://$ip:8081/_warm"); rc=$?; say "  eth0 answer $c (the deny line), curl exit $rc"
must_fail "listen 0.0.0.0:8081" eth0 "$([ "$rc" = 7 ] && echo 1 || echo 0)"
say "== arm: listen 0.0.0.0:8081, no allow and deny"
sed 's/listen 127\.0\.0\.1:8081;/listen 0.0.0.0:8081;/; /allow 127\.0\.0\.1;/d; /deny all;/d' /tmp/nginx.shipped.conf > /etc/nginx/nginx.conf
serve
curl -s -m 60 -D /tmp/warm.h -o /dev/null "http://$ip:8081/_warm"; rc=$?; say "  eth0 answer $(head -1 /tmp/warm.h | cut -d' ' -f2), x-c1-warm $([ -n "$(hdr x-c1-warm)" ] && echo present || echo absent)"
must_fail "listen 0.0.0.0:8081, no allow and deny" eth0 "$([ "$rc" = 7 ] && echo 1 || echo 0)"
say "== arm: an extra listen [::]:8081"
# Docker turns IPv6 off in a container on a network without it, and nginx then
# cannot bind [::]: the arm cannot run there, and says so.
if [ "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null || echo 1)" = 0 ]; then
	sed 's/listen 127\.0\.0\.1:8081;/listen 127.0.0.1:8081;\n\t\tlisten [::]:8081;/' /tmp/nginx.shipped.conf > /etc/nginx/nginx.conf
	serve
	say "  8081 on: $(listening | awk '$2 == "1F91" { printf "%s ", $1 }')"
	must_fail "listen [::]:8081" listen "$(loopback_only)"
else
	say "  not run: IPv6 is off in this container (the listen 0.0.0.0 arm covers the listen check)"
fi
say "== arm: /_warm on port 80"
perl -0pe 's{(\t\tlocation = /_fpm-ping \{)}{\t\tlocation = /_warm {\n\t\t\tinclude fastcgi.conf;\n\t\t\tfastcgi_param SCRIPT_FILENAME /opt/wp/warm.php;\n\t\t\tfastcgi_pass php;\n\t\t}\n$1}' /tmp/nginx.shipped.conf > /etc/nginx/nginx.conf
cmp -s /etc/nginx/nginx.conf /tmp/nginx.shipped.conf && { say "  FAIL the port-80 arm did not apply"; fails=$((fails + 1)); }
serve
curl -s -m 60 -D /tmp/warm.h -o /dev/null http://127.0.0.1/_warm
must_fail "/_warm on port 80" port80 "$([ -z "$(hdr x-c1-warm)" ] && echo 1 || echo 0)"
cp /tmp/nginx.shipped.conf /etc/nginx/nginx.conf

say "== arm: a plugin sets a cookie on init"
printf '%s\n' '<?php add_action( "init", function () { setcookie( "c1_test", "1" ); } );' > "$MU/zz-warm-test-cookie.php"
serve
curl -s -m 300 -D /tmp/warm.h -o /dev/null http://127.0.0.1:8081/_warm
check "cookie, with the plugin cookie (the shipped warm.php drops it)" "$([ -z "$(hdr set-cookie)" ] && echo 1 || echo 0)"
grep -v '^header_remove();' /tmp/warm.shipped.php > "$W"
cmp -s "$W" /tmp/warm.shipped.php && { say "  FAIL the header_remove arm did not apply"; fails=$((fails + 1)); }
serve
curl -s -m 300 -D /tmp/warm.h -o /dev/null http://127.0.0.1:8081/_warm; say "  set-cookie: $(hdr set-cookie | cut -c1-40)"
must_fail "warm.php minus header_remove(), with the plugin cookie" cookie "$([ -z "$(hdr set-cookie)" ] && echo 1 || echo 0)"
cp /tmp/warm.shipped.php "$W"; rm -f "$MU/zz-warm-test-cookie.php"

say "== arm: a plugin writes an option on init"
printf '%s\n' '<?php add_action( "init", function () { update_option( "c1_warm_test", microtime( true ) ); } );' > "$MU/zz-warm-test-write.php"
nowrite_case plugwrite
must_fail "a plugin writes an option" nowrite "$([ "$(wrote /tmp/plugwrite.warm.json)" = 0 ] && echo 1 || echo 0)"
rm -f "$MU/zz-warm-test-write.php"

say "== arm: warm.php minus DISABLE_WP_CRON (reported only)"
grep -v "define( 'DISABLE_WP_CRON', true );" /tmp/warm.shipped.php > "$W"
cmp -s "$W" /tmp/warm.shipped.php && { say "  FAIL the cron arm did not apply"; fails=$((fails + 1)); }
nowrite_case nocron
say "  reported: without DISABLE_WP_CRON, after a GET /, the warm-up $([ "$(wrote /tmp/nocron.warm.json)" = 1 ] && echo wrote || echo "wrote nothing")"
cp /tmp/warm.shipped.php "$W"
cmp -s "$W" /tmp/warm.shipped.php || { say "FAIL warm.php not restored"; fails=$((fails + 1)); }
cmp -s /etc/nginx/nginx.conf /tmp/nginx.shipped.conf || { say "FAIL nginx.conf not restored"; fails=$((fails + 1)); }
cmp -s "$CS" /tmp/c1-serve.shipped.sh || { say "FAIL c1-serve.sh not restored"; fails=$((fails + 1)); }

stop_servers
say "$fails failing"
exit $fails
