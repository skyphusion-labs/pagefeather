#!/bin/bash
# The binding can use a different login database from the origin selected by MySQL.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
cp "$root/spikes/b2-wordpress/php/wp-config.php" "$dir/"
cat > "$dir/wp-settings.php" <<'PHP'
<?php
echo DB_NAME;
PHP
test "$(php "$dir/wp-config.php")" = wordpress
cat > "$dir/wp-runtime.php" <<'PHP'
<?php
define( 'PAGEFEATHER_HYPERDRIVE', true );
function post_message_to_js( $message ) {
    if ( json_decode( $message, true ) !== array( 'mysql' => 'SELECT DATABASE()' ) ) {
        throw new RuntimeException( 'unexpected query' );
    }
    return getenv( 'BRIDGE_REPLY' );
}
PHP
export BRIDGE_REPLY='{"ok":true,"rows":[["shop-west"]]}'
test "$(php "$dir/wp-config.php")" = shop-west
export BRIDGE_REPLY='{"ok":true,"rows":[[{"$b":"c2hvcC13ZXN0"}]]}'
test "$(php "$dir/wp-config.php")" = shop-west
for BRIDGE_REPLY in '{"ok":false}' '{"ok":true,"rows":[[null]]}'; do
    if php "$dir/wp-config.php" >"$dir/out" 2>&1; then exit 1; fi
    grep -q 'selected database' "$dir/out"
done
echo 'Hyperdrive uses the selected database. The local fallback and failed reads are covered.'
