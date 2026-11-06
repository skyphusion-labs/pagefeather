#!/bin/bash
# Spike C1: stock WordPress + WooCommerce in a Container, SQLite on local disk,
# Litestream to R2. Assembles build/wordpress (image) and build/public (static
# files served by the Worker).
set -euo pipefail
cd "$(dirname "$0")"
WP_VERSION=7.1.4
SQLITE_DI_REF=f05c1f9
WOO_VERSION=11.2.1
WOO_SHA256=5317434cb381b5fdc7c1dd6ee258324f08c390976aaf8d1199f2a0e9a3ab8586
# APCu object cache drop-in by Scott Cariss (GPL-2.0-or-later), release 2.0.1
# (docs/prior-art.md).
OC_REF=f611f5bff7c02c3808320250631591012df3912a
OC_SHA256=afa6d39aa2e664706136825f574c68ba267c1f96581b433255739aeaff319c01
cache=../b2-wordpress/build/cache   # shared download cache with spike B2
mkdir -p "$cache"
[ -f "$cache/wordpress-$WP_VERSION.zip" ] || curl -sfL "https://wordpress.org/wordpress-$WP_VERSION.zip" -o "$cache/wordpress-$WP_VERSION.zip"
[ -f "$cache/wordpress-$WP_VERSION.zip.sha1" ] || curl -sfL "https://wordpress.org/wordpress-$WP_VERSION.zip.sha1" -o "$cache/wordpress-$WP_VERSION.zip.sha1"
echo "$(cat "$cache/wordpress-$WP_VERSION.zip.sha1")  $cache/wordpress-$WP_VERSION.zip" | shasum -a 1 -c - >/dev/null
[ -d "$cache/sqlite-database-integration" ] || git clone -q https://github.com/WordPress/sqlite-database-integration "$cache/sqlite-database-integration"
git -C "$cache/sqlite-database-integration" checkout -q "$SQLITE_DI_REF"
[ -f "$cache/woocommerce-$WOO_VERSION.zip" ] || curl -sfL "https://downloads.wordpress.org/plugin/woocommerce.$WOO_VERSION.zip" -o "$cache/woocommerce-$WOO_VERSION.zip"
echo "$WOO_SHA256  $cache/woocommerce-$WOO_VERSION.zip" | shasum -a 256 -c - >/dev/null
[ -f "$cache/object-cache-apcu-$OC_REF.php" ] || curl -sfL "https://raw.githubusercontent.com/l3rady/object-cache-apcu/$OC_REF/object-cache.php" -o "$cache/object-cache-apcu-$OC_REF.php"
echo "$OC_SHA256  $cache/object-cache-apcu-$OC_REF.php" | shasum -a 256 -c - >/dev/null

rm -rf build && mkdir -p build
unzip -q "$cache/wordpress-$WP_VERSION.zip" -d build
wp=build/wordpress
rm -rf "$wp/wp-content/themes/twentytwentythree" "$wp/wp-content/themes/twentytwentyfour" "$wp/wp-content/plugins/akismet" "$wp/wp-config-sample.php"
cp -RL "$cache/sqlite-database-integration/packages/plugin-sqlite-database-integration" "$wp/wp-content/plugins/sqlite-database-integration"
# The SQLite plugin's drop-in, unmodified: a real SQLite file on the container disk.
cp "$wp/wp-content/plugins/sqlite-database-integration/db.copy" "$wp/wp-content/db.php"
sed -i.bak "s#{SQLITE_IMPLEMENTATION_FOLDER_PATH}#/var/www/html/wp-content/plugins/sqlite-database-integration#; s#{SQLITE_PLUGIN}#sqlite-database-integration/load.php#" "$wp/wp-content/db.php" && rm "$wp/wp-content/db.php.bak"
unzip -q "$cache/woocommerce-$WOO_VERSION.zip" -d "$wp/wp-content/plugins"
# The plugin suite (tests/plugins/suite.txt), all 18 in the image; none active by default.
../../tests/plugins/fetch.sh "$wp/wp-content/plugins"
mkdir -p "$wp/wp-content/mu-plugins/r2-uploads"
cp php/00-worker-call.php php/query-count.php php/c1-queue.php "$wp/wp-content/mu-plugins/"
cp ../b2-wordpress/php/r2-uploads.php ../b2-wordpress/php/edge-cache.php ../b2-wordpress/php/woo-edge.php "$wp/wp-content/mu-plugins/"
cp ../b2-wordpress/php/cf-images-editor.php "$wp/wp-content/mu-plugins/r2-uploads/"
cp php/wp-config.php "$wp/"
cp php/install.php container/router.php "$wp/"
# Not in wp-content: container/entrypoint.sh copies it there when the Worker
# sets OBJECT_CACHE=apcu, so one image runs with and without the cache.
mkdir -p build/opt
cp "$cache/object-cache-apcu-$OC_REF.php" build/opt/object-cache.php
echo ok > "$wp/ping"
# Static files for the Worker (Workers static assets). PHP files stay in the image.
mkdir -p build/public
(cd "$wp" && find . -type f ! -name '*.php' ! -name 'ping' -print0 | cpio -0 -pdm --quiet ../public)
echo "wordpress $(find "$wp" -type f | wc -l | tr -d ' ') files, public $(find build/public -type f | wc -l | tr -d ' ') files"
