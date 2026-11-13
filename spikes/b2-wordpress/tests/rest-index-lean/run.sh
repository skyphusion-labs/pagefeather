#!/bin/bash
# php/rest-index-lean.php against a real WordPress 7.1.4 on SQLite (#394 rank 3). No web server:
# check.php runs each case in-process. Downloads are pinned: WordPress by its published SHA-1,
# the SQLite integration by git commit, WooCommerce and Rank Math by SHA-256 (build.sh,
# tests/plugins/gate2-build.txt). Two sites: plain WordPress, and WooCommerce with the tier 1
# alternates stack (Rank Math, ACF, UpdraftPlus, WPForms Lite). WooCommerce and WPForms Lite register
# REST routes, so the index's route list is large (Rank Math registers none outside its setup).
#   bash spikes/b2-wordpress/tests/rest-index-lean/run.sh
# Needs php with pdo_sqlite, curl, unzip, git.
set -u
HERE=$(cd "$(dirname "$0")" && pwd); APP=$(cd "$HERE/../.." && pwd); ROOT=$(cd "$APP/../.." && pwd)
T=$(mktemp -d); chmod 700 "$T"; trap 'rm -rf "$T"' EXIT
fails=0
ok() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: got '$2', want '$3'"; fails=$((fails + 1)); fi; }
die() { echo "rest-index-lean: $*" >&2; exit 2; }
php -m | grep -qix pdo_sqlite || die "php has no pdo_sqlite (WordPress on SQLite needs it)"
grep -qE '^cp .*php/rest-index-lean\.php.*"\$wp/wp-content/mu-plugins/"' "$APP/build.sh" && echo "  ok   build.sh copies rest-index-lean.php into mu-plugins (both engines)" || { echo "  FAIL build.sh does not copy rest-index-lean.php"; fails=$((fails + 1)); }
WP_VERSION=$(sed -n 's/^WP_VERSION=//p' "$APP/build.sh"); SQLITE_DI_REF=$(sed -n 's/^SQLITE_DI_REF=//p' "$APP/build.sh")
WOO_VERSION=$(sed -n 's/^WOO_VERSION=//p' "$APP/build.sh"); WOO_SHA256=$(sed -n 's/^WOO_SHA256=//p' "$APP/build.sh")
C=${FETCH_CACHE:-$APP/build/cache}; mkdir -p "$C"
z=$C/wordpress-$WP_VERSION.zip
[ -f "$z" ] || curl -sfL "https://wordpress.org/wordpress-$WP_VERSION.zip" -o "$z" || die "WordPress download"
echo "$(curl -sfL "https://wordpress.org/wordpress-$WP_VERSION.zip.sha1")  $z" | shasum -a 1 -c - >/dev/null || die "WordPress SHA-1"
[ -d "$C/sqlite-database-integration" ] || git clone -q https://github.com/WordPress/sqlite-database-integration "$C/sqlite-database-integration" || die "sqlite clone"
git -C "$C/sqlite-database-integration" checkout -q "$SQLITE_DI_REF" || die "sqlite ref"
w=$C/woocommerce-$WOO_VERSION.zip
[ -f "$w" ] || curl -sfL "https://downloads.wordpress.org/plugin/woocommerce.$WOO_VERSION.zip" -o "$w" || die "WooCommerce download"
echo "$WOO_SHA256  $w" | shasum -a 256 -c - >/dev/null || die "WooCommerce SHA-256"

site() { # site <dir> <active plugins, space separated>
  local d=$1; shift
  unzip -q "$z" -d "$d" && mv "$d/wordpress" "$d/wp"
  local W=$d/wp P=$d/wp/wp-content/plugins
  cp -RL "$C/sqlite-database-integration/packages/plugin-sqlite-database-integration" "$P/sqlite-database-integration"
  sed -e "s#{SQLITE_IMPLEMENTATION_FOLDER_PATH}#$P/sqlite-database-integration#" -e "s#{SQLITE_PLUGIN}#sqlite-database-integration/load.php#" \
    "$P/sqlite-database-integration/db.copy" > "$W/wp-content/db.php"
  mkdir -p "$W/wp-content/mu-plugins" "$W/wp-content/database"
  cp "$APP/php/rest-index-lean.php" "$W/wp-content/mu-plugins/"
  for p in "$@"; do
    case $p in
      woocommerce) unzip -q "$w" -d "$P" ;;
      *) FETCH_CACHE=$C SUITE=gate2-build.txt bash "$ROOT/tests/plugins/fetch.sh" "$P" "$p" 2>/dev/null || die "fetch $p" ;;
    esac
  done
  cat > "$W/wp-config.php" <<PHP
<?php
define( 'DB_NAME', 'wp' ); define( 'DB_USER', '' ); define( 'DB_PASSWORD', '' ); define( 'DB_HOST', '' );
define( 'DB_DIR', __DIR__ . '/wp-content/database/' ); define( 'DB_FILE', '.ht.sqlite' );
\$table_prefix = 'wp_';
foreach ( array( 'AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT' ) as \$k ) { define( \$k, 'test-' . \$k ); }
define( 'WP_HOME', 'http://x.test' ); define( 'WP_SITEURL', 'http://x.test' ); define( 'WP_DEBUG', false );
if ( getenv( 'LEAN_OFF' ) ) { define( 'SKYPHUSION_REST_INDEX_LEAN_OFF', true ); }
if ( ! defined( 'ABSPATH' ) ) { define( 'ABSPATH', __DIR__ . '/' ); }
require_once ABSPATH . 'wp-settings.php';
PHP
  local plugins="" p
  for p in "$@"; do
    case $p in
      seo-by-rank-math) plugins="$plugins seo-by-rank-math/rank-math.php" ;;
      advanced-custom-fields) plugins="$plugins advanced-custom-fields/acf.php" ;;
      wpforms-lite) plugins="$plugins wpforms-lite/wpforms.php" ;;
      *) plugins="$plugins $p/$p.php" ;;
    esac
  done
  ( cd "$W" && HTTP_HOST=x.test php -d memory_limit=1G -r '
    $_SERVER["HTTP_HOST"] = "x.test"; define("WP_INSTALLING", true);
    require "wp-load.php"; require ABSPATH . "wp-admin/includes/upgrade.php";
    wp_install("t", "admin", "a@x.test", true, "", "pw");
    update_option("active_plugins", array_values(array_filter(explode(" ", $argv[1]))));
  ' "$plugins" ) > "$d/install.out" 2>&1 || { cat "$d/install.out" >&2; die "install"; }
}
run() { ( cd "$1/wp" && php -d memory_limit=1G "$HERE/check.php" "$1/wp" "${@:2}" 2>>"$1/php.err" | tail -1 ); }
j() { python3 -I -c 'import json, sys; d = json.loads(sys.stdin.read()); v = eval(sys.argv[1], {}, {"d": d}); print(json.dumps(v) if not isinstance(v, str) else v)' "$1"; }

for label in plain stack; do
  D=$T/$label; mkdir -p "$D"
  if [ $label = plain ]; then site "$D"; else site "$D" woocommerce seo-by-rank-math advanced-custom-fields updraftplus wpforms-lite; fi
  echo "== $label"
  c=$(run "$D" compare); echo "     $c" | cut -c1-400
  ok "$label: the editor's preload of / is the same body, lean and full" "$(echo "$c" | j 'd["bodyEqual"]')" true
  ok "$label: the lean answer says lean" "$(echo "$c" | j 'd["stateLean"]')" lean
  ok "$label: the switch answer says full:switch" "$(echo "$c" | j 'd["stateFull"]')" full:switch
  ok "$label: the headers differ only by X-Rest-Index" "$(echo "$c" | j 'd["headersEqualOtherwise"]')" true
  ok "$label: CONDITION 2: the empty-endpoint filter is off after the call" "$(echo "$c" | j 'd["filterLeftOn"]')" false
  ok "$label: CONDITION 2: get_routes() after it has every route" "$(echo "$c" | j 'd["routesAfter"] == d["routes"]')" true
  ok "$label: CONDITION 2: a full index after it lists every route" "$(echo "$c" | j 'd["fullIndexRoutes"] == d["routes"] and d["routes"] > 50')" true
  ok "$label: CONDITION 2: another route after it answers 200" "$(echo "$c" | j 'd["typesStatus"]')" 200
  if [ $label = stack ]; then
    ok "stack: WooCommerce and WPForms Lite routes are registered (the list is large)" "$(echo "$c" | j '"wc/v3" in d["namespaces"] and "wpforms/v1" in d["namespaces"]')" true
    ok "stack: CONDITION 2: a plugin namespace answers 200 after it" "$(echo "$c" | j 'd.get("pluginNamespace", [0, 0])[1]')" 200
  fi
  s=$(run "$D" failsafe); echo "     $s" | cut -c1-300
  ok "$label: _fields with routes: full" "$(echo "$s" | j 'd["routesField"]')" full:fields
  ok "$label: _fields with _links: full" "$(echo "$s" | j 'd["linksField"]')" full:fields
  ok "$label: _fields with routes.x: full" "$(echo "$s" | j 'd["nestedRoutes"]')" full:fields
  ok "$label: no _fields: full" "$(echo "$s" | j 'd["noFields"]')" full:no-fields
  ok "$label: _embed: full" "$(echo "$s" | j 'd["embed"]')" full:embed
  ok "$label: a rest_index callback that is not core's: full" "$(echo "$s" | j 'd["foreignHook"]')" full:hook
  ok "$label: another route carries no X-Rest-Index" "$(echo "$s" | j 'd["otherRoute"]')" null
  ok "$label: no filter left on after the fail-safe cases" "$(echo "$s" | j 'd["filterLeftOn"]')" false
  o=$(cd "$D/wp" && LEAN_OFF=1 php -d memory_limit=1G "$HERE/check.php" "$D/wp" state 2>>"$D/php.err" | tail -1)
  ok "$label: SKYPHUSION_REST_INDEX_LEAN_OFF: not hooked, no X-Rest-Index" "$(echo "$o" | j '[d["hooked"], d["state"]]')" '[false, null]'
  ml=$(run "$D" mem lean | j 'd["peakOverKiB"]'); mf=$(run "$D" mem full | j 'd["peakOverKiB"]')
  echo "     memory of the one preload call (PHP peak over its start): full ${mf} KiB, lean ${ml} KiB"
  ok "$label: the lean call peaks lower than the full one" "$([ "${ml:-0}" -lt "${mf:-0}" ] && echo yes || echo no)" yes
done
echo "$fails failing case(s)"
[ "$fails" = 0 ]
