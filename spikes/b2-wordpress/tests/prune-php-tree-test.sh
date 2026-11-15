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
         wp-content/plugins/woocommerce/readme.txt wp-admin/css/common.css wp-admin/css/common.min.css; do mk "$f"; done
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
ok "plugins keep their .js and .svg" "$([ "$(has wp-content/plugins/woocommerce/assets/js/frontend.js)$(has wp-content/plugins/woocommerce/assets/images/card.svg)" = 11 ] && echo 1 || echo 0)"
ok "a theme's style.css stays, its other .css goes" "$([ "$(has wp-content/themes/tt5/style.css)$(gone wp-content/themes/tt5/other.css)" = 11 ] && echo 1 || echo 0)"
ok ".min.css stays, an unminified .css goes" "$([ "$(has wp-admin/css/common.min.css)$(gone wp-admin/css/common.css)" = 11 ] && echo 1 || echo 0)"
ok "PHP and a plugin readme: the php stays, the .txt goes" "$([ "$(has index.php)$(has wp-content/plugins/woocommerce/woocommerce.php)$(gone wp-content/plugins/woocommerce/readme.txt)" = 111 ] && echo 1 || echo 0)"
ok "build.sh prunes through prune-php-tree.sh (one rule, not two)" "$(grep -qE '^\./prune-php-tree\.sh "\$wp"' "$HERE/build.sh" && ! grep -q -- "-name '\*\.webp'.*-delete" "$HERE/build.sh" && echo 1 || echo 0)"
echo "$fails failing case(s)"
[ "$fails" = 0 ]
