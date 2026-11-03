#!/bin/bash
# End-to-end check against a running spike: pages, login, admin, editor, REST write.
# Usage: ./e2e.sh [base-url]   (default http://localhost:8797)
# Prints one line per request. Exits 1 if any request fails or reports D1 failures.
set -u
B=${1:-http://localhost:8797}
T=$(mktemp -d); J=$T/jar; H=$T/h; bad=0
val() { grep -i "^$1:" "$H" | head -1 | cut -d: -f2- | tr -d ' \r'; }
row() {
  local code; code=$(head -1 "$H" | cut -d' ' -f2)
  printf "%-30s %s calls=%-4s d1ms=%-5s phpms=%-5s fail=%s\n" "$1" "$code" "$(val x-d1-calls)" "$(val x-d1-ms)" "$(val x-php-ms)" "$(val x-d1-failures)"
  case "$code" in 2*|3*) ;; *) bad=1 ;; esac
  [ "$(val x-d1-failures)" = "0" ] || { bad=1; curl -s "$B/_last" | python3 -c "
import json,sys
for f in json.load(sys.stdin).get('failures',[])[:3]: print('   ', f['error'][:140], '|', f['sql'][:160])"; }
}
get() { curl -s -c "$J" -b "$J" -o "$T/body" -D "$H" "$B$2"; row "$1"; }
get 'GET /' /
get 'GET / (warm)' /
get 'GET /?p=1' '/?p=1'
get 'GET /?page_id=2' '/?page_id=2'
get 'GET /?feed=rss2' '/?feed=rss2'
get 'GET /?s=hello' '/?s=hello'
get 'GET /?cat=1' '/?cat=1'
get 'GET /?m=2026' "/?m=$(date -u +%Y)"
get 'GET REST posts' '/?rest_route=/wp/v2/posts'
get 'GET wp-login.php' /wp-login.php
curl -s -c "$J" -b "$J" -o /dev/null -D "$H" -d 'log=admin&pwd=local-spike-password&wp-submit=Log+In&redirect_to=%2Fwp-admin%2F&testcookie=1' "$B/wp-login.php"; row 'POST wp-login.php'
get 'GET /wp-admin/' /wp-admin/
get 'GET post-new.php' '/wp-admin/post-new.php'
N=$(grep -o 'createNonceMiddleware( "[a-f0-9]*' "$T/body" | grep -o '[a-f0-9]*$')
curl -s -c "$J" -b "$J" -o "$T/post" -D "$H" -H "X-WP-Nonce: $N" -H 'Content-Type: application/json' \
  -d '{"title":"Written to D1","content":"<!-- wp:paragraph --><p>This post lives in Cloudflare D1.</p><!-- /wp:paragraph -->","status":"publish"}' \
  "$B/?rest_route=/wp/v2/posts"; row 'POST REST create post'
id=$(python3 -c "import json; print(json.load(open('$T/post')).get('id',''))")
get 'GET new post' "/?p=$id"
grep -q 'This post lives in Cloudflare D1' "$T/body" && echo "new post content present" || { echo "new post content MISSING"; bad=1; }
get 'GET /wp-admin/edit.php' /wp-admin/edit.php
get 'GET upload.php' /wp-admin/upload.php
rm -rf "$T"
exit $bad
