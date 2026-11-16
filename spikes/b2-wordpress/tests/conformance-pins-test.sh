#!/usr/bin/env bash
# #759: the CONFORMANCE test plugins are upstream files byte for byte, the build ships them dormant, and the
# loader (php/conformance.php) reads them only when SKYPHUSION_CONFORMANCE is defined, which index.js does only
# for the site var CONFORMANCE = "on" (deploy/conformance.sh renders it only on a throwaway that is not live).
#   1. each file's git blob sha and sha256 equal conformance/PINS (the blob sha is upstream's at the ref);
#   2. build.sh copies the three files and the loader;
#   3. php: without the constant the loader returns and defines nothing; with it, all three load;
#   4. index.js defines the constant for exactly "on".
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/conformance-pins-test.XXXXXX")
trap 'rm -rf "$T"' EXIT

echo "1. pins (conformance/PINS)"
n=0
while IFS='|' read -r f _repo _ref _path blob sha; do
  f=$(echo "$f" | tr -d ' '); blob=$(echo "$blob" | tr -d ' '); sha=$(echo "$sha" | tr -d ' ')
  case "$f" in ''|\#*) continue ;; esac
  n=$((n+1))
  gb=$(git -C "$HERE" hash-object "conformance/$f" 2>/dev/null)
  s=$(shasum -a 256 "$HERE/conformance/$f" 2>/dev/null | cut -c1-64)
  ok "$f: git blob $blob and sha256 match" "$([ "$gb" = "$blob" ] && [ "$s" = "$sha" ] && echo 1 || echo 0)"
done < "$HERE/conformance/PINS"
ok "PINS lists the three files" "$([ "$n" = 3 ] && echo 1 || echo 0)"

echo "2. build.sh ships them, dormant"
ok "the loader is copied into mu-plugins" "$(grep -E '^cp php/.* php/conformance\.php "\$wp/wp-content/mu-plugins/"$' "$HERE/build.sh" >/dev/null && echo 1 || echo 0)"
for f in basic-auth.php woocommerce-e2e-test-helper.php woocommerce-cleanup.php; do
  ok "conformance/$f is copied into wp-content/conformance (not mu-plugins)" "$(grep -E "^cp .*conformance/$f.* \"\\\$wp/wp-content/conformance/\"$" "$HERE/build.sh" >/dev/null && echo 1 || echo 0)"
done

echo "3. php/conformance.php loads them only with SKYPHUSION_CONFORMANCE"
mkdir -p "$T/wp-content/conformance"; cp "$HERE"/conformance/*.php "$T/wp-content/conformance/"
cat > "$T/run.php" <<'PHP'
<?php
define( 'ABSPATH', __DIR__ . '/' );
define( 'WP_CONTENT_DIR', __DIR__ . '/wp-content' );
$GLOBALS['hooks'] = array();
function add_filter( $h ) { $GLOBALS['hooks'][] = $h; return true; }
function add_action( $h ) { $GLOBALS['hooks'][] = $h; return true; }
if ( 'on' === $argv[2] ) { define( 'SKYPHUSION_CONFORMANCE', true ); }
if ( 'string' === $argv[2] ) { define( 'SKYPHUSION_CONFORMANCE', 'on' ); }
require $argv[1];
echo json_encode( array(
	'basic' => function_exists( 'json_basic_auth_handler' ),
	'helper' => function_exists( 'register_helper_api' ),
	'cleanup' => function_exists( 'wc_cleanup_reset_site' ),
	'determine_current_user' => in_array( 'determine_current_user', $GLOBALS['hooks'], true ),
	'rest_api_init' => in_array( 'rest_api_init', $GLOBALS['hooks'], true ),
) );
PHP
off=$(php "$T/run.php" "$HERE/php/conformance.php" off 2>&1)
ok "no constant: nothing loads, no hook ($off)" "$([ "$off" = '{"basic":false,"helper":false,"cleanup":false,"determine_current_user":false,"rest_api_init":false}' ] && echo 1 || echo 0)"
str=$(php "$T/run.php" "$HERE/php/conformance.php" string 2>&1)
ok "the constant as a string, not true: nothing loads" "$([ "$str" = '{"basic":false,"helper":false,"cleanup":false,"determine_current_user":false,"rest_api_init":false}' ] && echo 1 || echo 0)"
on=$(php "$T/run.php" "$HERE/php/conformance.php" on 2>&1)
ok "the constant true: all three load, Basic auth hooks determine_current_user ($on)" "$([ "$on" = '{"basic":true,"helper":true,"cleanup":true,"determine_current_user":true,"rest_api_init":true}' ] && echo 1 || echo 0)"

echo "4. index.js defines it for exactly \"on\""
ok "the define is guarded by ENV.CONFORMANCE === 'on'" "$(grep -cF "if (ENV.CONFORMANCE === 'on') lines.push(\`define('SKYPHUSION_CONFORMANCE', true);\`);" "$HERE/index.js" | grep -qx 1 && echo 1 || echo 0)"
ok "no other line defines SKYPHUSION_CONFORMANCE" "$([ "$(grep -c "SKYPHUSION_CONFORMANCE" "$HERE/index.js")" = 1 ] && echo 1 || echo 0)"
echo "$fails failing case(s)"
[ "$fails" = 0 ]
