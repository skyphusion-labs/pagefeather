#!/usr/bin/env bash
# block-css-keep.py --check (the #1205 guard, the lead's ask): the build FAILS when a stylesheet a plugin or theme
# block.json names ("file:./x.css") is in the static copy (build/public) but missing from the PHP tree, because core
# then registers that block style with an empty src (no link, no inline copy). A file missing from both is the plugin's
# own defect (stock has it too) and is not failed. build.sh runs the check right after prune-php-tree.sh.
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/block-css-keep-test.XXXXXX"); trap 'rm -rf "$T"' EXIT
mk() { mkdir -p "$(dirname "$T/$1")"; echo x > "$T/$1"; }
bj() { mkdir -p "$(dirname "$T/$1")"; printf '%s' "$2" > "$T/$1"; }
for r in wp public; do
  bj "$r/wp-content/plugins/blk/build/block.json" '{ "name": "blk/a", "style": "file:./style-index.css", "viewStyle": [ "file:./view.css" ] }'
  mk "$r/wp-content/plugins/blk/build/style-index.css"
done
mk public/wp-content/plugins/blk/build/view.css
python3 -I "$HERE/block-css-keep.py" --check "$T/wp" "$T/public" > "$T/out" 2>&1; rc=$?
ok "a block.json stylesheet shipped in public/ but missing from the PHP tree fails the check (rc $rc)" "$([ $rc = 1 ] && echo 1 || echo 0)"
ok "  and names the file" "$(grep -q 'wp-content/plugins/blk/build/view.css' "$T/out" && echo 1 || echo 0)"
mk wp/wp-content/plugins/blk/build/view.css
python3 -I "$HERE/block-css-keep.py" --check "$T/wp" "$T/public" > "$T/out" 2>&1; rc=$?
ok "every named stylesheet in the PHP tree: the check passes (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"
bj wp/wp-content/plugins/up/block.json '{ "name": "up/x", "style": "file:./missing.css" }'
bj public/wp-content/plugins/up/block.json '{ "name": "up/x", "style": "file:./missing.css" }'
python3 -I "$HERE/block-css-keep.py" --check "$T/wp" "$T/public" > "$T/out" 2>&1; rc=$?
ok "a stylesheet missing from BOTH (the plugin's own defect) does not fail the build (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"
# #1208: the guard covers every theme stylesheet too (add_editor_style reads them from disk).
mk public/wp-content/themes/tt1/assets/css/style-editor.css
python3 -I "$HERE/block-css-keep.py" --check "$T/wp" "$T/public" > "$T/out" 2>&1; rc=$?
ok "#1208: a theme stylesheet shipped in public/ but missing from the PHP tree fails the check (rc $rc)" "$([ $rc = 1 ] && grep -q 'wp-content/themes/tt1/assets/css/style-editor.css' "$T/out" && echo 1 || echo 0)"
mk wp/wp-content/themes/tt1/assets/css/style-editor.css
python3 -I "$HERE/block-css-keep.py" --check "$T/wp" "$T/public" > "$T/out" 2>&1; rc=$?
ok "#1208: with it in the PHP tree, the check passes (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"
# #1208: a stylesheet a plugin READS from disk by a static path is covered by the guard too.
mkdir -p "$T/wp/wp-content/plugins/rd" "$T/public/wp-content/plugins/rd"
printf '%s\n' '<?php' "echo file_get_contents( __DIR__ . '/inline.css' );" > "$T/wp/wp-content/plugins/rd/r.php"
mk public/wp-content/plugins/rd/inline.css
python3 -I "$HERE/block-css-keep.py" --check "$T/wp" "$T/public" > "$T/out" 2>&1; rc=$?
ok "#1208: a plugin stylesheet read from disk, missing from the PHP tree, fails the check (rc $rc)" "$([ $rc = 1 ] && grep -q 'wp-content/plugins/rd/inline.css' "$T/out" && echo 1 || echo 0)"
mk wp/wp-content/plugins/rd/inline.css
python3 -I "$HERE/block-css-keep.py" --check "$T/wp" "$T/public" > "$T/out" 2>&1; rc=$?
ok "#1208: present in the PHP tree, it passes (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"
# #1221: a stylesheet plugin PHP PROBES (file_exists, is_readable and the like) by a path whose base the build cannot
# follow. WooCommerce 11.2.1 (class-woocommerce.php:1392) checks file_exists( WC()->plugin_path() . '/assets/css/admin.css' )
# and, when it is false, shows "development version, files must be built" on every admin page.
mkdir -p "$T/wp/wp-content/plugins/wc/includes" "$T/public/wp-content/plugins/wc/assets/css"
printf '%s\n' '<?php' "if ( ! file_exists( WC()->plugin_path() . '/assets/css/admin.css' ) ) { echo 'dev'; }" > "$T/wp/wp-content/plugins/wc/includes/class-wc.php"
mk public/wp-content/plugins/wc/assets/css/admin.css
python3 -I "$HERE/block-css-keep.py" --check "$T/wp" "$T/public" > "$T/out" 2>&1; rc=$?
ok "#1221: a stylesheet probed with file_exists by a plugin-root path, missing from the PHP tree, fails the check (rc $rc)" "$([ $rc = 1 ] && grep -q 'wp-content/plugins/wc/assets/css/admin.css' "$T/out" && echo 1 || echo 0)"
ok "#1221:   and says it is probed" "$(grep -q 'probes it' "$T/out" && echo 1 || echo 0)"
mk wp/wp-content/plugins/wc/assets/css/admin.css
python3 -I "$HERE/block-css-keep.py" --check "$T/wp" "$T/public" > "$T/out" 2>&1; rc=$?
ok "#1221: present in the PHP tree, it passes (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"
printf '%s\n' '<?php' "if ( is_readable( __DIR__ . '/probe.css' ) ) { echo 'y'; }" > "$T/wp/wp-content/plugins/rd/p.php"
mk public/wp-content/plugins/rd/probe.css
python3 -I "$HERE/block-css-keep.py" --check "$T/wp" "$T/public" > "$T/out" 2>&1; rc=$?
ok "#1221: is_readable( __DIR__ . '/probe.css' ) is covered too (rc $rc)" "$([ $rc = 1 ] && grep -q 'wp-content/plugins/rd/probe.css' "$T/out" && echo 1 || echo 0)"
mk wp/wp-content/plugins/rd/probe.css
# the KEEP list the prune uses (run before the prune, on the full tree) names a probed stylesheet
( cd "$T/public" && mkdir -p wp-content/plugins/wc/includes && cp "$T/wp/wp-content/plugins/wc/includes/class-wc.php" wp-content/plugins/wc/includes/ && python3 -I "$HERE/block-css-keep.py" ) > "$T/keep" 2>/dev/null
ok "#1221: the KEEP list names the probed stylesheet, so the prune keeps it" "$(grep -qx './wp-content/plugins/wc/assets/css/admin.css' "$T/keep" && echo 1 || echo 0)"
ok "build.sh runs the check right after the prune, and stops on it" "$(grep -A1 -E '^\./prune-php-tree\.sh "\$wp"' "$HERE/build.sh" | grep -qE 'python3 -I block-css-keep\.py --check "\$wp" build/public \|\| exit 1' && echo 1 || echo 0)"
echo "$fails failing case(s)"
[ "$fails" = 0 ]
