#!/bin/bash
# Drop from the PHP tree (what goes into site.zip) the files PHP never reads (build.sh, after the
# static copy to build/public, which keeps everything). prune-php-tree.sh <wordpress dir>
# With SCRIPT_DEBUG off WordPress reads only .min.css files (some by a path built at runtime), so those
# stay and the unminified ones go. EVERY .css under a theme stays (#1208): WordPress reads style.css's header, and
# add_editor_style files are read from disk and inlined into the editor (get_block_editor_theme_styles).
# Plugins keep their .js and .svg on the PHP side: WooCommerce registers a block only if its script file
# exists, and reads card icons (SVG) at runtime (measured 2026-11-04: no product grid on the shop page;
# checkout fatal error).
# Core reads three scripts with file_get_contents and prints them inline: the emoji loader (every public
# page) and the two embed scripts (oEmbed and the embed page). They stay (#578).
# wp-admin's scripts load as static files (CONCATENATE_SCRIPTS in php/wp-config.php).
# WooCommerce's installer copies its placeholder image from the plugin tree into uploads at activation
# (WC_Install::create_placeholder_image); without it activation warns and the store has no placeholder (#679).
# WordPress 7.0's icon library (WP_Icons_Registry) reads wp-includes/images/icon-library/*.svg with
# file_get_contents at runtime (/wp/v2/icons, the Icon block): without them each icon has no content and
# PHP prints "Icon file is missing or unreadable" (#759's route runner). 88 files, 28,381 bytes (18,523 in site.zip).
# #1205: the stylesheets a plugin or theme block.json names (style, editorStyle, viewStyle: "file:./x.css") and their
# -rtl siblings stay: core registers each with realpath() on the PHP side, so a pruned file gave the handle an EMPTY src
# (no link, no inline copy: router-styles 9 of 9; 41 WooCommerce block stylesheets). block-css-keep.py lists them.
# Test: tests/prune-php-tree-test.sh.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "${1:?usage: prune-php-tree.sh <wordpress dir>}"
KEEP=$(mktemp); LIST=$(mktemp); trap 'rm -f "$KEEP" "$LIST"' EXIT
python3 -I "$HERE/block-css-keep.py" > "$KEEP"
find . -type f \( -name '*.js' -o -name '*.map' -o -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.gif' -o -name '*.svg' -o -name '*.webp' -o -name '*.woff' -o -name '*.woff2' -o -name '*.ttf' -o -name '*.eot' -o -name '*.mo' -o -name '*.po' -o -name '*.zip' -o \( -name '*.css' ! -name '*.min.css' \) -o -name '*.txt' -o -name '*.scss' -o -name '*.md' \) \
  ! \( -path './wp-content/themes/*' -name '*.css' \) ! \( -path './wp-content/plugins/*' \( -name '*.js' -o -name '*.svg' \) \) \
  ! -path './wp-includes/js/wp-emoji-loader.min.js' ! -path './wp-includes/js/wp-embed.min.js' ! -path './wp-includes/js/wp-embed-template.min.js' \
  ! -path './wp-content/plugins/woocommerce/assets/images/placeholder-attachment.webp' \
  ! -path './wp-includes/images/icon-library/*.svg' \
  -print0 > "$LIST"
# Delete what find matched, except the block.json stylesheets (#1205).
python3 -I -c 'import os, sys
keep = set(l.rstrip("\n") for l in open(sys.argv[2], encoding="utf-8") if l.strip())
for p in open(sys.argv[1], "rb").read().split(b"\0"):
    if p and os.fsdecode(p) not in keep:
        os.remove(p)' "$LIST" "$KEEP"
