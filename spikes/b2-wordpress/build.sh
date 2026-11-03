#!/bin/bash
# Assemble the WordPress tree for spike B2.
#   build/site.zip  files PHP reads, unzipped into PHP's memory at boot
#   build/public/   static files (no .php) served by Workers static assets
set -euo pipefail
cd "$(dirname "$0")"
WP_VERSION=7.1.4
SQLITE_DI_REF=f05c1f9
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

rm -rf build/wordpress build/public build/site.zip
unzip -q "$cache/wordpress-$WP_VERSION.zip" -d build
wp=build/wordpress
rm -rf "$wp/wp-content/themes/twentytwentythree" "$wp/wp-content/themes/twentytwentyfour" "$wp/wp-content/plugins/akismet" "$wp/wp-config-sample.php"
cp -RL "$cache/sqlite-database-integration/packages/plugin-sqlite-database-integration" "$wp/wp-content/plugins/sqlite-database-integration"
cp php/db.php php/d1-pdo.php "$wp/wp-content/"
# The plugin's installer opens its own connection to DB_PATH. Make it use the
# D1-backed connection that wp-content/db.php already made.
python3 - "$wp/wp-content/plugins/sqlite-database-integration/wp-includes/sqlite/install-functions.php" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
s, n = re.subn(r"\$translator = new WP_MySQL_On_SQLite\(.*?\);\s*\$translator->setAttribute\([^;]*;[^\n]*", "$translator = $wpdb->dbh;", s, count=1, flags=re.S)
assert n == 1, "install-functions.php patch did not apply"
open(p, "w").write(s)
PY
cp php/wp-config.php "$wp/"

# Static files: everything except PHP. wp-config.php never reaches public/.
mkdir -p build/public
(cd "$wp" && find . -type f ! -name '*.php' -print0 | cpio -0pdm --quiet ../public)

# PHP's files: drop what PHP never reads.
(cd "$wp" && find . -type f \( -name '*.js' -o -name '*.map' -o -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.gif' -o -name '*.svg' -o -name '*.webp' -o -name '*.woff' -o -name '*.woff2' -o -name '*.ttf' -o -name '*.eot' -o -name '*.mo' -o -name '*.po' -o -name '*.zip' \) -delete)
(cd build && zip -qr -9 site.zip wordpress)
echo "site.zip $(wc -c < build/site.zip) bytes, $(cd build && unzip -l site.zip | tail -1)"
echo "public/ $(find build/public -type f | wc -l | tr -d ' ') files"
