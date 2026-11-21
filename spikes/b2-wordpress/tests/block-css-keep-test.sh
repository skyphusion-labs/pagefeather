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
ok "build.sh runs the check right after the prune, and stops on it" "$(grep -A1 -E '^\./prune-php-tree\.sh "\$wp"' "$HERE/build.sh" | grep -qE 'python3 -I block-css-keep\.py --check "\$wp" build/public \|\| exit 1' && echo 1 || echo 0)"
echo "$fails failing case(s)"
[ "$fails" = 0 ]
