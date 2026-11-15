#!/bin/bash
# Drop from the PHP tree (what goes into site.zip) the files PHP never reads (build.sh, after the
# static copy to build/public, which keeps everything). prune-php-tree.sh <wordpress dir>
# With SCRIPT_DEBUG off WordPress reads only .min.css files (some by a path built at runtime), so those
# stay and the unminified ones go. A theme's style.css stays: WordPress reads its header.
# Plugins keep their .js and .svg on the PHP side: WooCommerce registers a block only if its script file
# exists, and reads card icons (SVG) at runtime (measured 2026-11-04: no product grid on the shop page;
# checkout fatal error).
# Core reads three scripts with file_get_contents and prints them inline: the emoji loader (every public
# page) and the two embed scripts (oEmbed and the embed page). They stay (#578).
# wp-admin's scripts load as static files (CONCATENATE_SCRIPTS in php/wp-config.php).
# Test: tests/prune-php-tree-test.sh.
set -euo pipefail
cd "${1:?usage: prune-php-tree.sh <wordpress dir>}"
find . -type f \( -name '*.js' -o -name '*.map' -o -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.gif' -o -name '*.svg' -o -name '*.webp' -o -name '*.woff' -o -name '*.woff2' -o -name '*.ttf' -o -name '*.eot' -o -name '*.mo' -o -name '*.po' -o -name '*.zip' -o \( -name '*.css' ! -name '*.min.css' \) -o -name '*.txt' -o -name '*.scss' -o -name '*.md' \) \
  ! -path './wp-content/themes/*/style.css' ! \( -path './wp-content/plugins/*' \( -name '*.js' -o -name '*.svg' \) \) \
  ! -path './wp-includes/js/wp-emoji-loader.min.js' ! -path './wp-includes/js/wp-embed.min.js' ! -path './wp-includes/js/wp-embed-template.min.js' \
  -delete
