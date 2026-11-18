#!/usr/bin/env bash
# #605: Workers static assets default to max-age=0, must-revalidate.
# The block editor then revalidates each script, and the canvas misses the 10s wait.
# assets/_headers sets a long browser cache on code assets. Uploads stay fresh.
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
H="$HERE/assets/_headers"
B="$HERE/build.sh"
line_of() { grep -n "$1" "$2" 2>/dev/null | head -1 | cut -d: -f1; }
next_is() { grep -A1 "$1" "$H" 2>/dev/null | grep -qx "$2" && echo 1 || echo 0; }
ok "assets/_headers exists" "$([ -f "$H" ] && echo 1 || echo 0)"
ok "wp-includes code assets cache for one year" "$(next_is '^/wp-includes/\*' '  Cache-Control: public, max-age=31536000, immutable')"
ok "wp-admin code assets cache for one year" "$(next_is '^/wp-admin/\*' '  Cache-Control: public, max-age=31536000, immutable')"
ok "wp-content code assets cache for one year" "$(next_is '^/wp-content/\*' '  Cache-Control: public, max-age=31536000, immutable')"
con=$(line_of '^/wp-content/\*' "$H")
up=$(line_of '^/wp-content/uploads/\*' "$H")
ok "the uploads rule comes after the wp-content rule" "$([ -n "$con" ] && [ -n "$up" ] && [ "$up" -gt "$con" ] && echo 1 || echo 0)"
ok "uploads detach the long cache" "$(next_is '^/wp-content/uploads/\*' '  ! Cache-Control')"
ok "uploads stay must-revalidate" "$(grep -A2 '^/wp-content/uploads/\*' "$H" 2>/dev/null | grep -qx '  Cache-Control: public, max-age=0, must-revalidate' && echo 1 || echo 0)"
rml=$(line_of 'rm -rf build/wordpress build/public' "$B")
cpio=$(line_of 'cpio -0pdm' "$B")
cpl=$(line_of 'cp assets/_headers build/public/_headers' "$B")
ok "build.sh copies _headers after it clears public and after the static copy" "$([ -n "$rml" ] && [ -n "$cpio" ] && [ -n "$cpl" ] && [ "$cpl" -gt "$rml" ] && [ "$cpl" -gt "$cpio" ] && echo 1 || echo 0)"
echo "$fails failing case(s)"
exit $((fails > 0))
