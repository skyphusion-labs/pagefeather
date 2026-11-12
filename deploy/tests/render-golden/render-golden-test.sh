#!/bin/bash
# The golden render gate (#328 PR 0). It renders every case in cases.json with the emitters on
# this tree (render.mjs) and compares the result byte for byte with goldens/. Any difference
# fails, and the test prints the difference as a unified diff.
#
#   deploy/tests/render-golden/render-golden-test.sh            compare (CI runs this)
#   deploy/tests/render-golden/render-golden-test.sh --update   write the new renders to goldens/
#
# Use --update ONLY in a PR that changes a render on purpose. Commit the goldens/ change in that
# PR, so the reviewer reads the render difference in the diff. No network call is made.
set -u
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
if ! node "$HERE/render.mjs" "$OUT/rendered" > "$OUT/log" 2>&1; then
  cat "$OUT/log"; echo "FAIL golden render: an emitter did not run"; exit 1
fi
if [ "${1:-}" = --update ]; then
  rm -rf "$HERE/goldens"
  cp -R "$OUT/rendered" "$HERE/goldens"
  echo "goldens/ updated. Read git diff deploy/tests/render-golden/goldens before you commit it."
  exit 0
fi
if (cd "$HERE" && diff -ru goldens "$OUT/rendered") > "$OUT/diff"; then
  echo "PASS golden render: $(find "$HERE/goldens" -type f | wc -l | tr -d ' ') files are byte-identical"
  exit 0
fi
sed "s|$OUT/rendered|rendered|g" "$OUT/diff"
echo "FAIL golden render: a render differs from goldens/ (above: - is the golden, + is this tree)."
echo "If the change is on purpose, run deploy/tests/render-golden/render-golden-test.sh --update and commit goldens/."
exit 1
