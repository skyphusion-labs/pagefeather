#!/bin/bash
# Assemble the WordPress tree for spike B2.
#   build/site.zip  files PHP reads, unzipped into PHP's memory at boot
#   build/public/   static files (no .php) served by Workers static assets
set -euo pipefail
cd "$(dirname "$0")"
WP_VERSION=7.1.4
SQLITE_DI_REF=f05c1f9
# WooCommerce. wordpress.org publishes no checksum for plugin zips, so the
# SHA-256 of the 2026-11-04 download is pinned here.
WOO_VERSION=11.2.1
WOO_SHA256=5317434cb381b5fdc7c1dd6ee258324f08c390976aaf8d1199f2a0e9a3ab8586
cache=build/cache
mkdir -p "$cache"

if [ ! -f "$cache/wordpress-$WP_VERSION.zip" ]; then
  curl -sfL "https://wordpress.org/wordpress-$WP_VERSION.zip" -o "$cache/wordpress-$WP_VERSION.zip"
  curl -sfL "https://wordpress.org/wordpress-$WP_VERSION.zip.sha1" -o "$cache/wordpress-$WP_VERSION.zip.sha1"
fi
echo "$(cat "$cache/wordpress-$WP_VERSION.zip.sha1")  $cache/wordpress-$WP_VERSION.zip" | shasum -a 1 -c - >/dev/null
if [ ! -d "$cache/sqlite-database-integration" ]; then
  git clone -q https://github.com/WordPress/sqlite-database-integration "$cache/sqlite-database-integration"
fi
git -C "$cache/sqlite-database-integration" checkout -q "$SQLITE_DI_REF"
if [ ! -f "$cache/woocommerce-$WOO_VERSION.zip" ]; then
  curl -sfL "https://downloads.wordpress.org/plugin/woocommerce.$WOO_VERSION.zip" -o "$cache/woocommerce-$WOO_VERSION.zip"
fi
echo "$WOO_SHA256  $cache/woocommerce-$WOO_VERSION.zip" | shasum -a 256 -c - >/dev/null

rm -rf build/wordpress build/public build/site.zip
unzip -q "$cache/wordpress-$WP_VERSION.zip" -d build
wp=build/wordpress
rm -rf "$wp/wp-content/themes/twentytwentythree" "$wp/wp-content/themes/twentytwentyfour" "$wp/wp-content/plugins/akismet" "$wp/wp-config-sample.php"
# ENGINE=a: approach A, MySQL through Hyperdrive (php/hyperdrive-db.php). Default: D1.
[ "${ENGINE:-d1}" = a ] || cp -RL "$cache/sqlite-database-integration/packages/plugin-sqlite-database-integration" "$wp/wp-content/plugins/sqlite-database-integration"
# WOO=0 leaves WooCommerce out (the plugin suite does: the Worker size limit).
[ "${WOO:-1}" = 0 ] || unzip -q "$cache/woocommerce-$WOO_VERSION.zip" -d "$wp/wp-content/plugins"
# PLUGINS="slug ..." adds plugins from tests/plugins/suite.txt (checked by SHA-256).
[ -z "${PLUGINS:-}" ] || ../../tests/plugins/fetch.sh "$wp/wp-content/plugins" $PLUGINS
mkdir -p "$wp/wp-content/mu-plugins"
cp php/r2-uploads.php php/edge-cache.php php/woo-edge.php php/rest-route-cache.php php/http-bridge.php php/real-transactions.php "$wp/wp-content/mu-plugins/"
mkdir -p "$wp/wp-content/mu-plugins/r2-uploads"
cp php/cf-images-editor.php "$wp/wp-content/mu-plugins/r2-uploads/"
if [ "${ENGINE:-d1}" = a ]; then
  cp php/hyperdrive-db.php "$wp/wp-content/db.php"
  cp php/hyperdrive-sql-mode.php "$wp/wp-content/hyperdrive-sql-mode.php"
else
cp php/db.php php/d1-pdo.php php/d1-dialect.php "$wp/wp-content/"
# Object cache across requests; on only with DB_IN_DO (php/object-cache.php).
cp php/object-cache.php php/object-cache-js.php "$wp/wp-content/"
# The plugin's installer opens its own connection to DB_PATH. Make it use the
# D1-backed connection that wp-content/db.php already made.
python3 - "$wp/wp-content/plugins/sqlite-database-integration/wp-includes/sqlite/install-functions.php" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
s, n = re.subn(r"\$translator = new WP_MySQL_On_SQLite\(.*?\);\s*\$translator->setAttribute\([^;]*;[^\n]*", "$translator = $wpdb->dbh;", s, count=1, flags=re.S)
assert n == 1, "install-functions.php patch did not apply"
open(p, "w").write(s)
PY
fi
cp php/wp-config.php "$wp/"

# Static files: everything except PHP. wp-config.php never reaches public/.
mkdir -p build/public
(cd "$wp" && find . -type f ! -name '*.php' -print0 | cpio -0pdm --quiet ../public)

# PHP's files: drop what PHP never reads. With SCRIPT_DEBUG off WordPress reads
# only .min.css files (some by a path built at runtime), so those stay and the
# unminified ones go. A theme's style.css stays: WordPress reads its header.
# Plugins keep their .js and .svg on the PHP side: WooCommerce registers a block
# only if its script file exists, and reads card icons (SVG) at runtime
# (measured 2026-11-04: no product grid on the shop page; checkout fatal error).
(cd "$wp" && find . -type f \( -name '*.js' -o -name '*.map' -o -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.gif' -o -name '*.svg' -o -name '*.webp' -o -name '*.woff' -o -name '*.woff2' -o -name '*.ttf' -o -name '*.eot' -o -name '*.mo' -o -name '*.po' -o -name '*.zip' -o \( -name '*.css' ! -name '*.min.css' \) -o -name '*.txt' -o -name '*.scss' -o -name '*.md' \) ! -path './wp-content/themes/*/style.css' ! \( -path './wp-content/plugins/*' \( -name '*.js' -o -name '*.svg' \) \) -delete)
# Deflated: the Worker inflates each file on its first read only. The Worker
# size limit is 64 MiB uncompressed, so both zips are deflated.
(cd build && zip -qr -9 site.zip wordpress)
echo "site.zip $(wc -c < build/site.zip) bytes, $(cd build && unzip -l site.zip | tail -1)"
# Precompiled OPcache files come from ./opcache.sh. Until then, an empty zip:
# the Worker compiles as before. Always a new empty zip: OPcache files from an
# earlier build are compiled from other sources (measured 2026-11-05: an A build
# ran B's compiled wp-content/db.php from the zip a B build had left).
python3 -c "import zipfile; zipfile.ZipFile('build/opcache.zip', 'w').close()"
echo "public/ $(find build/public -type f | wc -l | tr -d ' ') files"
