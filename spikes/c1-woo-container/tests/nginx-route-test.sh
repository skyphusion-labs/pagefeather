#!/bin/bash
# Routing test of container/nginx.conf (issue #99). Runs inside the c1 image,
# as root, with no database (WordPress then answers an error page, which is
# enough: the x-c1-pid header proves that PHP-FPM ran the request).
#   docker run --rm -v "$PWD/spikes/c1-woo-container/tests:/t" \
#     --entrypoint bash <image> /t/nginx-route-test.sh
# Two arms on the same image:
#   shipped: /etc/nginx/nginx.conf. Every case must pass, and no answer may
#            contain PHP source.
#   mutant 1: the slash handling of the first version ("try_files $uri $uri/
#            /index.php": PUT and DELETE to / gave 405).
#   mutant 2: the fba402a version ("try_files ${uri}index.php ...": the PHP
#            source of index.php for GET /, 405 for the rest).
#   Both mutants must fail, or the test cannot see the defect.
set -u
export PHP_WORKERS=2
fails_total=0
run_arm() {
	local name=$1 conf=$2 fails=0
	cp "$conf" /etc/nginx/nginx.conf
	nginx -t -q || { echo "FAIL $name: nginx -t"; return 1; }
	/usr/local/bin/c1-serve.sh > /tmp/route-$name.log 2>&1 & local S=$!
	for i in $(seq 1 30); do curl -s -o /dev/null -m 1 http://127.0.0.1/ping && break; sleep 0.3; done
	# method path want: php (x-c1-pid present), static:<body>, or 301:<location>
	while read -r m p want; do
		local h body
		h=$(curl -s -m 10 -X "$m" -D - -o /tmp/route.body "http://127.0.0.1$p")
		body=$(head -c 40 /tmp/route.body)
		code=$(printf '%s' "$h" | head -1 | cut -d" " -f2)
		loc=$(printf '%s' "$h" | tr -d "\r" | awk -F": " 'tolower($1) == "location" { print $2 }')
		pid=$(printf '%s' "$h" | tr -d "\r" | awk -F": " 'tolower($1) == "x-c1-pid" { print $2 }')
		ok=0
		case "$want" in
			# PHP ran it, and the body is not PHP source.
			php) [ -n "$pid" ] && [ "$code" != 405 ] && ! grep -q "<?php" /tmp/route.body && ok=1 ;;
			301:*) [ "$code" = 301 ] && [ "$loc" = "${want#301:}" ] && ok=1 ;;
			static:*) [ "$code" = 200 ] && [ -z "$pid" ] && [ "$body" = "${want#static:}" ] && ok=1 ;;
		esac
		# No case may ever return PHP source.
		if grep -q "<?php" /tmp/route.body; then ok=0; echo "  SOURCE LEAK on $m $p"; fi
		[ $ok = 1 ] || fails=$((fails + 1))
		printf '  %s %-6s %-36s want %-16s got %s%s%s\n' "$([ $ok = 1 ] && echo ok || echo BAD)" "$m" "$p" "$want" "$code" "${loc:+ location $loc}" "${pid:+ pid $pid}"
	done <<'CASES'
GET / php
PUT /?rest_route=/wp/v2/posts/1 php
PATCH /?rest_route=/wp/v2/posts/1 php
DELETE /?rest_route=/wc/v3/products/1 php
POST /?rest_route=/wc/store/v1/checkout php
OPTIONS /?rest_route=/ php
GET /wp-admin 301:/wp-admin/
GET /wp-admin/ php
PUT /wp-admin/ php
GET /wp-includes/ php
GET /shop/ php
DELETE /shop/item php
GET /no-such-file.php php
GET /index.php php
GET /wp-admin/index.php php
GET /index.php/ php
HEAD / php
GET /ping static:ok
CASES
	kill -TERM $S; wait $S
	echo "$name: $fails failing case(s)"
	return $fails
}
cp /etc/nginx/nginx.conf /tmp/nginx.shipped.conf
perl -0pe 's{\t\t# A path that ends in a slash.*?\n\t\t# Any other path.*?\n\t\tlocation / \{\n\t\t\ttry_files \$uri /index.php\$is_args\$args;\n\t\t\}\n}{\t\tindex index.php;\n\t\tlocation / {\n\t\t\ttry_files \$uri \$uri/ /index.php\$is_args\$args;\n\t\t}\n}s' /tmp/nginx.shipped.conf > /tmp/nginx.mutant.conf
cmp -s /tmp/nginx.shipped.conf /tmp/nginx.mutant.conf && { echo "FAIL: the mutant is the same as the shipped file (the block was not found)"; exit 1; }
# Mutant 2, the fba402a version: the slash location by try_files, which served
# index.php as a static file (PHP source) and 405 for other methods.
perl -0pe 's{(\t\tlocation ~ /\$ \{\n).*?(\n\t\t\}\n)}{$1\t\t\ttry_files \$\{uri\}index.php /index.php\$is_args\$args;$2}s' /tmp/nginx.shipped.conf > /tmp/nginx.mutant2.conf
cmp -s /tmp/nginx.shipped.conf /tmp/nginx.mutant2.conf && { echo "FAIL: mutant 2 is the same as the shipped file"; exit 1; }
echo "== shipped"; run_arm shipped /tmp/nginx.shipped.conf; s=$?
echo "== mutant 1 (first version, try_files \$uri/)"; run_arm mutant1 /tmp/nginx.mutant.conf; m=$?
echo "== mutant 2 (fba402a, try_files \${uri}index.php)"; run_arm mutant2 /tmp/nginx.mutant2.conf; m2=$?
cp /tmp/nginx.shipped.conf /etc/nginx/nginx.conf
if [ $s = 0 ] && [ $m -gt 0 ] && [ $m2 -gt 0 ]; then echo "PASS: shipped 0 failing, mutant 1 $m failing, mutant 2 $m2 failing"; exit 0; fi
echo "FAIL: shipped $s failing, mutant 1 $m, mutant 2 $m2 (want 0, more than 0, more than 0)"; exit 1
