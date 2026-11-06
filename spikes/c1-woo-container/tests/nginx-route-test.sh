#!/bin/bash
# Routing test of container/nginx.conf (issue #99). Runs inside the c1 image,
# as root, with no database (WordPress then answers an error page, which is
# enough: the x-c1-pid header proves that PHP-FPM ran the request).
#   docker run --rm -v "$PWD/spikes/c1-woo-container/tests:/t" \
#     --entrypoint bash <image> /t/nginx-route-test.sh
# Two arms on the same image:
#   shipped: /etc/nginx/nginx.conf. Every case must pass.
#   mutant:  the same file with the slash location replaced by the first
#            version ("try_files $uri $uri/ /index.php"). It must fail (PUT and
#            DELETE to / gave 405 there), or the test cannot see the defect.
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
			php) [ -n "$pid" ] && [ "$code" != 405 ] && ok=1 ;;
			301:*) [ "$code" = 301 ] && [ "$loc" = "${want#301:}" ] && ok=1 ;;
			static:*) [ "$code" = 200 ] && [ -z "$pid" ] && [ "$body" = "${want#static:}" ] && ok=1 ;;
		esac
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
GET /ping static:ok
CASES
	kill -TERM $S; wait $S
	echo "$name: $fails failing case(s)"
	return $fails
}
cp /etc/nginx/nginx.conf /tmp/nginx.shipped.conf
perl -0pe 's{\t\t# A path that ends in a slash.*?\n\t\tlocation / \{\n\t\t\ttry_files \$uri /index.php\$is_args\$args;\n\t\t\}\n}{\t\tindex index.php;\n\t\tlocation / {\n\t\t\ttry_files \$uri \$uri/ /index.php\$is_args\$args;\n\t\t}\n}s' /tmp/nginx.shipped.conf > /tmp/nginx.mutant.conf
cmp -s /tmp/nginx.shipped.conf /tmp/nginx.mutant.conf && { echo "FAIL: the mutant is the same as the shipped file (the block was not found)"; exit 1; }
echo "== shipped"; run_arm shipped /tmp/nginx.shipped.conf; s=$?
echo "== mutant (first version)"; run_arm mutant /tmp/nginx.mutant.conf; m=$?
cp /tmp/nginx.shipped.conf /etc/nginx/nginx.conf
if [ $s = 0 ] && [ $m -gt 0 ]; then echo "PASS: shipped 0 failing, mutant $m failing"; exit 0; fi
echo "FAIL: shipped $s failing, mutant $m failing (want 0 and more than 0)"; exit 1
