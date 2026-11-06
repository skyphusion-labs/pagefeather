#!/bin/bash
# Test of the warm-up (issue #92): container/warm.php and its nginx server on
# 127.0.0.1:8081. Runs INSIDE the c1 image, as root, with no Litestream:
#   docker run --rm -v "$PWD/spikes/c1-woo-container/tests:/t" \
#     --entrypoint bash <image> /t/warm-image-test.sh
# It installs WordPress and WooCommerce on an empty /data (install.php), then
# runs c1-serve.sh with WARM_WP=off and calls the warm-up itself.
#
# Checks on the shipped image (each must hold):
#   reach   GET 127.0.0.1:8081/_warm: 200 and an x-c1-warm header (warm.php ran)
#   compile its OPcache scripts after are more than before
#   cookie  no Set-Cookie in that answer
#   nowrite PRAGMA data_version on a connection held across the call, and the
#           row counts of wp_options, wp_actionscheduler_actions, _logs, _claims
#           and _groups, and wp_woocommerce_sessions, are the same after
#   port80  GET 127.0.0.1/_warm (port 80, where the Worker comes in) has no
#           x-c1-warm header: warm.php did not run
#   eth0    a connect to <container address>:8081 is refused
#   listen  /proc/net/tcp and tcp6 show port 8081 listening on 127.0.0.1 only
#   bound   with WARM_MAX_FILES=5: compiled 5, stop "max files"
#   lowmem  with opcache.memory_consumption=40: stop "opcache free below
#           16 MiB", and no OPcache restart (oom 0)
# Arms that must FAIL a named check, or the check cannot see its defect:
#   nginx listen 0.0.0.0:8081        eth0 and listen (the deny line then answers 403: shown)
#   nginx listen 0.0.0.0:8081, no allow/deny   eth0
#   nginx listen [::]:8081 too       listen
#   nginx /_warm on port 80          port80
#   a plugin sets a cookie on init   cookie must still hold (header_remove);
#     with warm.php minus header_remove()     cookie
#   a plugin writes an option on init         nowrite
#   warm.php minus DISABLE_WP_CRON            nowrite (reported, not required:
#     it fails only when a cron event is due)
# Exit 0 only when every shipped check holds and every required arm fails.
set -u
export PHP_WORKERS=2 PUBLIC_HOST=localhost ADMIN_PASSWORD=warm-test-password SPIKE_TOKEN=t WARM_WP=off OBJECT_CACHE=apcu
W=/opt/wp/warm.php
cp /etc/nginx/nginx.conf /tmp/nginx.shipped.conf
cp "$W" /tmp/warm.shipped.php
fails=0
say() { printf '%s\n' "$*"; }

mkdir -p /data
php /var/www/html/install.php || { say "FAIL install"; exit 1; }
chown -R www-data:www-data /data
cp /opt/wp/object-cache.php /var/www/html/wp-content/object-cache.php
: > /tmp/c1-req.log; chown www-data /tmp/c1-req.log
MU=/var/www/html/wp-content/mu-plugins

S=""
serve() {
	[ -n "$S" ] && { kill -TERM "$S"; wait "$S" 2>/dev/null; }
	/usr/local/bin/c1-serve.sh > /tmp/warm-serve.log 2>&1 & S=$!
	for _ in $(seq 1 60); do curl -s -o /dev/null -m 1 http://127.0.0.1/_fpm-ping && return 0; sleep 0.5; done
	say "FAIL the servers did not answer"; cat /tmp/warm-serve.log; exit 1
}

# One call with the database held open: prints data_version and the counts
# before and after, then the response headers and body of the call.
call() {
	php -r '
$db = new PDO("sqlite:/data/wordpress.sqlite");
$t = array("wp_options", "wp_actionscheduler_actions", "wp_actionscheduler_logs", "wp_actionscheduler_claims", "wp_actionscheduler_groups", "wp_woocommerce_sessions");
$snap = function () use ($db, $t) {
	$o = array("data_version" => (int) $db->query("PRAGMA data_version")->fetchColumn());
	foreach ($t as $x) { $o[$x] = (int) $db->query("SELECT COUNT(*) FROM $x")->fetchColumn(); }
	return $o;
};
$b = $snap();
$out = shell_exec("curl -s -m 300 -D /tmp/warm.h -o /tmp/warm.b " . escapeshellarg($argv[1]) . "; echo $?");
$a = $snap();
echo json_encode(array("before" => $b, "after" => $a, "curl" => (int) trim($out))), "\n";' "$1"
}
# The local addresses that listen on port 8081 (1F91), from /proc/net/tcp and
# tcp6 (state 0A). Prints them, one per line.
listeners() { awk '$4 == "0A" { split($2, a, ":"); if (a[2] == "1F91") print a[1] }' /proc/net/tcp /proc/net/tcp6 2>/dev/null; }
# 1 when every listener on 8081 is 127.0.0.1 (0100007F) and there is one at least.
loopback_only() { local l n=0; for l in $(listeners); do n=$((n + 1)); [ "$l" = 0100007F ] || { echo 0; return; }; done; [ "$n" -gt 0 ] && echo 1 || echo 0; }
hdr() { tr -d '\r' < /tmp/warm.h | awk -F': ' -v k="$1" 'tolower($1) == k { print substr($0, length($1) + 3) }'; }

# check <name> <0 or 1, 1 = holds>
check() { if [ "$2" = 1 ]; then say "  ok   $1"; else say "  FAIL $1"; fi; [ "$2" = 1 ]; }

warm_checks() {   # runs reach, compile, cookie, nowrite; prints failing names
	local r w code bad=""
	r=$(call http://127.0.0.1:8081/_warm)
	code=$(head -1 /tmp/warm.h | cut -d' ' -f2); w=$(hdr x-c1-warm)
	say "  warm: $code $w"; say "  db: $r"
	[ "$code" = 200 ] && [ -n "$w" ] || bad="$bad reach"
	php -r '$w = json_decode($argv[1], true); exit(is_array($w) && $w["after"]["scripts"] > $w["before"]["scripts"] ? 0 : 1);' "$w" || bad="$bad compile"
	[ -z "$(hdr set-cookie)" ] || bad="$bad cookie"
	php -r '$d = json_decode($argv[1], true); exit(is_array($d) && $d["before"] === $d["after"] ? 0 : 1);' "$r" || bad="$bad nowrite"
	echo "$bad"
}

say "== shipped"
serve
bad=$(warm_checks | tee /dev/stderr | tail -1)
for c in reach compile cookie nowrite; do check "$c" "$([[ " $bad " == *" $c "* ]] && echo 0 || echo 1)" || fails=$((fails + 1)); done
curl -s -m 30 -D /tmp/warm.h -o /dev/null http://127.0.0.1/_warm
check "port80 (no x-c1-warm on port 80)" "$([ -z "$(hdr x-c1-warm)" ] && echo 1 || echo 0)" || fails=$((fails + 1))
ip=$(php -r 'echo gethostbyname(gethostname());')
curl -s -m 5 -o /dev/null "http://$ip:8081/_warm"; rc=$?
check "eth0 ($ip:8081 refused, curl exit $rc)" "$([ "$rc" = 7 ] && echo 1 || echo 0)" || fails=$((fails + 1))
check "listen (8081 on: $(listeners | tr '\n' ' '))" "$(loopback_only)" || fails=$((fails + 1))

say "== bound: WARM_MAX_FILES=5 (a fresh FPM, so OPcache is cold)"
WARM_MAX_FILES=5 serve
curl -s -m 300 -D /tmp/warm.h -o /dev/null http://127.0.0.1:8081/_warm; w=$(hdr x-c1-warm); say "  $w"
check "bound (compiled 5, stop max files)" "$(php -r '$w = json_decode($argv[1], true); echo is_array($w) && $w["compiled"] === 5 && $w["stop"] === "max files" ? 1 : 0;' "$w")" || fails=$((fails + 1))

say "== lowmem: opcache.memory_consumption=40"
mkdir -p /tmp/ini && echo "opcache.memory_consumption=40" > /tmp/ini/zz-low.ini
PHP_INI_SCAN_DIR=":/tmp/ini" serve
curl -s -m 300 -D /tmp/warm.h -o /dev/null http://127.0.0.1:8081/_warm; w=$(hdr x-c1-warm); say "  $w"
oom=$(curl -s -H "x-spike-token: t" "http://127.0.0.1/_stats.php?what=info" | php -r '$i = json_decode(stream_get_contents(STDIN), true); echo $i["opcache"]["oom"] ?? "none";')
check "lowmem (stop at free below 16 MiB, oom $oom)" "$(php -r '$w = json_decode($argv[1], true); echo is_array($w) && $w["stop"] === "opcache free below 16 MiB" && $argv[2] === "0" ? 1 : 0;' "$w" "$oom")" || fails=$((fails + 1))
rm -rf /tmp/ini

# An arm that must fail <check>: arm <name> <check> <setup> <undo>
arm() {
	local name=$1 want=$2 got
	say "== arm: $name (must fail $want)"
	serve
	case "$want" in
		eth0) curl -s -m 5 -o /dev/null -w '  eth0 answer %{http_code}\n' "http://$ip:8081/_warm"; rc=$?; got=$([ "$rc" = 7 ] && echo holds || echo FAILS) ;;
		listen) say "  8081 on: $(listeners | tr '\n' ' ')"; got=$([ "$(loopback_only)" = 1 ] && echo holds || echo FAILS) ;;
		port80) curl -s -m 30 -D /tmp/warm.h -o /dev/null http://127.0.0.1/_warm; got=$([ -z "$(hdr x-c1-warm)" ] && echo holds || echo FAILS) ;;
		*) bad=$(warm_checks | tail -1); got=$([[ " $bad " == *" $want "* ]] && echo FAILS || echo holds) ;;
	esac
	say "  $want $got"
	echo "$got"
}
need_fail() { local got; got=$(arm "$@" | tee /dev/stderr | tail -1); [ "$got" = FAILS ] || { say "  FAIL: the arm $1 did not fail $2"; fails=$((fails + 1)); }; }

sed 's/listen 127\.0\.0\.1:8081;/listen 0.0.0.0:8081;/' /tmp/nginx.shipped.conf > /etc/nginx/nginx.conf
need_fail "listen 0.0.0.0:8081" eth0
need_fail "listen 0.0.0.0:8081" listen
sed 's/listen 127\.0\.0\.1:8081;/listen 0.0.0.0:8081;/; /allow 127\.0\.0\.1;/d; /deny all;/d' /tmp/nginx.shipped.conf > /etc/nginx/nginx.conf
need_fail "listen 0.0.0.0:8081, no allow and deny" eth0
sed 's/listen 127\.0\.0\.1:8081;/listen 127.0.0.1:8081;\n\t\tlisten [::]:8081;/' /tmp/nginx.shipped.conf > /etc/nginx/nginx.conf
need_fail "listen [::]:8081 too" listen
perl -0pe 's{(\t\tlocation = /_fpm-ping \{)}{\t\tlocation = /_warm {\n\t\t\tinclude fastcgi.conf;\n\t\t\tfastcgi_param SCRIPT_FILENAME /opt/wp/warm.php;\n\t\t\tfastcgi_pass php;\n\t\t}\n$1}' /tmp/nginx.shipped.conf > /etc/nginx/nginx.conf
need_fail "/_warm on port 80" port80
cp /tmp/nginx.shipped.conf /etc/nginx/nginx.conf
for f in /etc/nginx/nginx.conf; do cmp -s "$f" /tmp/nginx.shipped.conf || { say "FAIL nginx.conf not restored"; fails=$((fails + 1)); }; done

printf '%s\n' '<?php add_action( "init", function () { setcookie( "c1_test", "1" ); } );' > "$MU/zz-warm-test-cookie.php"
got=$(arm "a plugin sets a cookie, shipped warm.php" cookie | tee /dev/stderr | tail -1)
[ "$got" = holds ] || { say "  FAIL: header_remove did not drop the plugin cookie"; fails=$((fails + 1)); }
grep -v '^header_remove();' /tmp/warm.shipped.php > "$W"
cmp -s "$W" /tmp/warm.shipped.php && { say "FAIL the header_remove mutant did not apply"; fails=$((fails + 1)); }
need_fail "a plugin sets a cookie, warm.php minus header_remove" cookie
cp /tmp/warm.shipped.php "$W"; rm -f "$MU/zz-warm-test-cookie.php"

printf '%s\n' '<?php add_action( "init", function () { update_option( "c1_warm_test", microtime( true ) ); } );' > "$MU/zz-warm-test-write.php"
need_fail "a plugin writes an option" nowrite
rm -f "$MU/zz-warm-test-write.php"

grep -v "define( 'DISABLE_WP_CRON', true );" /tmp/warm.shipped.php > "$W"
got=$(arm "warm.php minus DISABLE_WP_CRON (reported only)" nowrite | tail -1)
say "  reported: without DISABLE_WP_CRON the no-write check $got"
cp /tmp/warm.shipped.php "$W"
cmp -s "$W" /tmp/warm.shipped.php || { say "FAIL warm.php not restored"; fails=$((fails + 1)); }

kill -TERM "$S"; wait "$S" 2>/dev/null
say "$fails failing"
exit $fails
