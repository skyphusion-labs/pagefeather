#!/usr/bin/env bash
# prune-php-tree.sh (build.sh's PHP-tree prune): what PHP never reads is dropped from the PHP tree
# (site.zip); the static copy in build/public keeps everything. #679: WooCommerce's installer copies
# wp-content/plugins/woocommerce/assets/images/placeholder-attachment.webp at activation, so that ONE
# image stays readable by PHP; every other image still goes. The #578 and plugin exceptions still hold.
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/prune-test.XXXXXX"); trap 'rm -rf "$T"' EXIT
W="$T/wordpress"
mk() { mkdir -p "$(dirname "$W/$1")"; echo x > "$W/$1"; }
for f in index.php wp-includes/js/wp-emoji-loader.min.js wp-includes/js/wp-embed.min.js wp-includes/js/jquery.js \
         wp-includes/images/w-logo-blue.png wp-content/themes/tt5/style.css wp-content/themes/tt5/other.css \
         wp-content/themes/tt5/screenshot.webp wp-content/plugins/woocommerce/woocommerce.php \
         wp-content/plugins/woocommerce/assets/images/placeholder-attachment.webp \
         wp-content/plugins/woocommerce/assets/images/placeholder.webp wp-content/plugins/woocommerce/assets/images/icon.png \
         wp-content/plugins/woocommerce/assets/js/frontend.js wp-content/plugins/woocommerce/assets/images/card.svg \
         wp-content/plugins/woocommerce/readme.txt wp-admin/css/common.css wp-admin/css/common.min.css \
         wp-includes/images/icon-library/arrow-down.svg wp-includes/images/wpicons.svg; do mk "$f"; done
# #1205: a plugin or theme block names its stylesheets in block.json ("file:./view.css"); core registers the handle
# with realpath() of that file on the PHP side (register_block_style_handle), so a pruned file gave an EMPTY src: no
# link, no inline copy (router-styles 9 of 9; 41 WooCommerce block stylesheets).
for f in wp-content/plugins/blk/build/view.css wp-content/plugins/blk/build/view-rtl.css wp-content/plugins/blk/build/style-index.css \
         wp-content/plugins/blk/build/style-index-rtl.css wp-content/plugins/blk/build/index.css wp-content/plugins/blk/build/unused.css \
         wp-content/plugins/blk/shared/base.css wp-content/themes/tt5/blocks/hero/hero.css wp-content/plugins/bad/block.json; do mk "$f"; done
cat > "$W/wp-content/plugins/blk/build/block.json" <<'JSON'
{ "name": "blk/router", "style": "file:./style-index.css", "viewStyle": [ "file:./view.css", "blk-handle" ], "editorStyle": "file:./index.css", "viewScriptModule": "file:./view.js" }
JSON
cat > "$W/wp-content/plugins/blk/build/second/block.json" 2>/dev/null || { mkdir -p "$W/wp-content/plugins/blk/build/second"; }
cat > "$W/wp-content/plugins/blk/build/second/block.json" <<'JSON'
{ "name": "blk/second", "style": "file:../../shared/base.css" }
JSON
cat > "$W/wp-content/themes/tt5/blocks/hero/block.json" <<'JSON'
{ "name": "tt5/hero", "style": "file:./hero.css" }
JSON
printf 'not json {' > "$W/wp-content/plugins/bad/block.json"
mk wp-content/themes/tt1/assets/css/style-editor.css
# #1208 (the lead's ruling, the uncovered case): a plugin that reads its OWN stylesheet from disk. WooCommerce 11.2.1's
# email editor does: file_get_contents( __DIR__ . '/content-shared.css' ), and __DIR__ . '/' . self::CONTENT_STYLES_FILE
# ('content.css') when it RENDERS an email. A read the build can resolve statically keeps its file.
mkdir -p "$W/wp-content/plugins/wc/eng/r"
cat > "$W/wp-content/plugins/wc/eng/r/renderer.php" <<'PHP'
<?php
class R {
	const CONTENT_STYLES_FILE = 'content.css';
	function s() {
		$a  = (string) file_get_contents( __DIR__ . '/' . self::CONTENT_STYLES_FILE );
		$a .= (string) file_get_contents( __DIR__ . '/../shared.css' );
		$a .= file_get_contents( dirname( __FILE__ ) . "/dq.css" );
		$a .= file_get_contents( $this->path . 'dynamic.css' );
		return $a;
	}
}
PHP
for f in wp-content/plugins/wc/eng/r/content.css wp-content/plugins/wc/eng/shared.css wp-content/plugins/wc/eng/r/dq.css wp-content/plugins/wc/eng/r/dynamic.css wp-content/plugins/wc/eng/r/unread.css; do mk "$f"; done
bash "$HERE/prune-php-tree.sh" "$W" > "$T/out" 2>&1; rc=$?
ok "prune-php-tree.sh runs (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"
has() { [ -e "$W/$1" ] && echo 1 || echo 0; }
gone() { [ -e "$W/$1" ] && echo 0 || echo 1; }
ok "#679: WooCommerce's placeholder-attachment.webp stays (the installer copies it)" "$(has wp-content/plugins/woocommerce/assets/images/placeholder-attachment.webp)"
ok "  another WooCommerce image still goes (placeholder.webp)" "$(gone wp-content/plugins/woocommerce/assets/images/placeholder.webp)"
ok "  a WooCommerce png still goes" "$(gone wp-content/plugins/woocommerce/assets/images/icon.png)"
ok "  a theme screenshot still goes" "$(gone wp-content/themes/tt5/screenshot.webp)"
ok "  a core image still goes" "$(gone wp-includes/images/w-logo-blue.png)"
ok "#578: the emoji loader and the embed script stay" "$([ "$(has wp-includes/js/wp-emoji-loader.min.js)$(has wp-includes/js/wp-embed.min.js)" = 11 ] && echo 1 || echo 0)"
ok "  a core script still goes" "$(gone wp-includes/js/jquery.js)"
ok "the icon library SVGs stay (WP_Icons_Registry reads them at runtime, /wp/v2/icons)" "$(has wp-includes/images/icon-library/arrow-down.svg)"
ok "  another core svg still goes" "$(gone wp-includes/images/wpicons.svg)"
ok "plugins keep their .js and .svg" "$([ "$(has wp-content/plugins/woocommerce/assets/js/frontend.js)$(has wp-content/plugins/woocommerce/assets/images/card.svg)" = 11 ] && echo 1 || echo 0)"
# #1208: a theme's other stylesheets are read by PHP too (add_editor_style: get_block_editor_theme_styles reads the
# file from disk and inlines it into the editor; twentytwentyone's assets/css/style-editor.css was pruned, so its
# editor styles were missing). Every .css under a theme stays.
ok "#1208: a theme's style.css and its other .css both stay" "$([ "$(has wp-content/themes/tt5/style.css)$(has wp-content/themes/tt5/other.css)" = 11 ] && echo 1 || echo 0)"
ok "#1208: a theme editor stylesheet in a subfolder stays (twentytwentyone assets/css/style-editor.css)" "$(has wp-content/themes/tt1/assets/css/style-editor.css)"
ok "#1205: a plugin block.json style, viewStyle (array form) and editorStyle stay" "$([ "$(has wp-content/plugins/blk/build/style-index.css)$(has wp-content/plugins/blk/build/view.css)$(has wp-content/plugins/blk/build/index.css)" = 111 ] && echo 1 || echo 0)"
ok "#1205: and their -rtl siblings (core loads them on an RTL site)" "$([ "$(has wp-content/plugins/blk/build/view-rtl.css)$(has wp-content/plugins/blk/build/style-index-rtl.css)" = 11 ] && echo 1 || echo 0)"
ok "#1205: a path that climbs out of the block's folder (file:../../shared/base.css) stays" "$(has wp-content/plugins/blk/shared/base.css)"
ok "#1205: a theme block's stylesheet stays" "$(has wp-content/themes/tt5/blocks/hero/hero.css)"
ok "#1205: a plugin .css no block.json names still goes" "$(gone wp-content/plugins/blk/build/unused.css)"
ok "#1205: a block.json that is not JSON does not stop the prune" "$([ $rc = 0 ] && echo 1 || echo 0)"
ok "#1208: a plugin stylesheet read from disk by a static path stays (__DIR__ with a class constant, with ../, dirname(__FILE__))" "$([ "$(has wp-content/plugins/wc/eng/r/content.css)$(has wp-content/plugins/wc/eng/shared.css)$(has wp-content/plugins/wc/eng/r/dq.css)" = 111 ] && echo 1 || echo 0)"
ok "#1208: a plugin stylesheet no PHP reads still goes" "$(gone wp-content/plugins/wc/eng/r/unread.css)"
ok "#1208: a read the build cannot resolve is NOTED (file and line), not guessed" "$(grep -q 'renderer.php:8' "$T/out" && grep -qi 'note' "$T/out" && echo 1 || echo 0)"
ok ".min.css stays, an unminified .css goes" "$([ "$(has wp-admin/css/common.min.css)$(gone wp-admin/css/common.css)" = 11 ] && echo 1 || echo 0)"
ok "PHP and a plugin readme: the php stays, the .txt goes" "$([ "$(has index.php)$(has wp-content/plugins/woocommerce/woocommerce.php)$(gone wp-content/plugins/woocommerce/readme.txt)" = 111 ] && echo 1 || echo 0)"
ok "build.sh prunes through prune-php-tree.sh (one rule, not two)" "$(grep -qE '^\./prune-php-tree\.sh "\$wp"' "$HERE/build.sh" && ! grep -q -- "-name '\*\.webp'.*-delete" "$HERE/build.sh" && echo 1 || echo 0)"
echo "$fails failing case(s)"
[ "$fails" = 0 ]
