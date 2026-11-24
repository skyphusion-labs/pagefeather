#!/usr/bin/env bash
# #1427: when CONFORMANCE=on, the build installs pf-conformance-throwaway.php from
# tests/conformance/php/, over the copy content.sh --mu brought from IMPORT_CONTENT.
# An older prepare-content.sh leaves a stale marker. A marker fix must reach the
# site without preparing the content again. With CONFORMANCE unset, the imported
# copy stays.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/conformance-marker.XXXXXX")
trap 'rm -rf "$T"' EXIT

MARKER=pf-conformance-throwaway.php
TREE="$ROOT/tests/conformance/php/$MARKER"
[ -f "$TREE" ] || { echo "FAIL the tree has no $TREE"; exit 1; }

install() { # install <dest wp-content> [CONFORMANCE=on]
  env -i PATH="$PATH" ROOT="$ROOT" CONFORMANCE="${1:-}" \
    bash -c ". '$ROOT/deploy/conformance.sh' && conformance_marker_install '$2'" \
    > "$T/out" 2> "$T/err"
}

echo "1. content.sh --mu copies the imported marker, then CONFORMANCE=on replaces it with the tree's"
mkdir -p "$T/src/mu-plugins" "$T/built/mu-plugins"
printf '<?php /* stale marker from an older prepare */\n' > "$T/src/mu-plugins/$MARKER"
IMPORT_MU_PLUGINS="$MARKER" "$ROOT/deploy/import/content.sh" --mu "$T/src" "$T/built" > "$T/mu.out" 2> "$T/mu.err"
rc=$?
ok "content.sh --mu copies the imported marker (rc $rc)" "$([ "$rc" = 0 ] && cmp -s "$T/src/mu-plugins/$MARKER" "$T/built/mu-plugins/$MARKER" && echo 1 || echo 0)"
install on "$T/built"; rc=$?
ok "conformance_marker_install exits 0 (rc $rc)" "$([ "$rc" = 0 ] && echo 1 || echo 0)"
ok "the installed marker matches the build tree, not the import" "$(cmp -s "$TREE" "$T/built/mu-plugins/$MARKER" && ! cmp -s "$T/src/mu-plugins/$MARKER" "$T/built/mu-plugins/$MARKER" && echo 1 || echo 0)"
ok "one line says the tree copy overwrote the imported one" "$([ "$rc" = 0 ] && [ ! -s "$T/out" ] && [ "$(wc -l < "$T/err" | tr -d ' ')" = 1 ] && grep -qxF "conformance: installed $MARKER from the build tree over any copy from IMPORT_CONTENT" "$T/err" && echo 1 || echo 0)"

echo "2. CONFORMANCE=on installs the tree marker even when the import brought none"
mkdir -p "$T/empty"
install on "$T/empty"; rc=$?
ok "a build with no imported marker still gets the tree's (rc $rc)" "$([ "$rc" = 0 ] && cmp -s "$TREE" "$T/empty/mu-plugins/$MARKER" && echo 1 || echo 0)"

echo "3. without CONFORMANCE=on the imported copy stays"
mkdir -p "$T/plain/mu-plugins"
printf '<?php /* stale, and this build is not a conformance run */\n' > "$T/plain/mu-plugins/$MARKER"
cp "$T/plain/mu-plugins/$MARKER" "$T/plain-before.php"
install "" "$T/plain"; rc=$?
ok "unset CONFORMANCE changes nothing (rc $rc)" "$([ "$rc" = 0 ] && cmp -s "$T/plain-before.php" "$T/plain/mu-plugins/$MARKER" && [ ! -s "$T/out" ] && [ ! -s "$T/err" ] && echo 1 || echo 0)"

echo "4. build.sh installs the marker after content.sh --mu, so the import cannot put the stale file back"
# The call is a real invocation, after the --mu line. A comment that names the function does not count.
order=0
if awk '
  /content\.sh --mu / { mu = NR }
  /^[[:space:]]*conformance_marker_install[[:space:]]/ { inst = NR }
  END { exit !(mu && inst && inst > mu) }
' "$ROOT/spikes/b2-wordpress/build.sh"; then
  order=1
fi
ok "spikes/b2-wordpress/build.sh calls conformance_marker_install after content.sh --mu" "$order"

echo "$fails failing"
exit $((fails > 0))
