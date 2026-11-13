#!/usr/bin/env bash
# The site manager bundles the front-door code as TEXT (#416). If the wrangler.toml
# rule glob stops matching vendor/wfp-dispatcher/worker.js, Wrangler bundles it as
# code instead: the Worker still builds, but every site's front door would upload
# the wrong thing. This builds with the pinned Wrangler (--dry-run, no account) and
# checks the text module is there and equals the vendored file. A CONTROL build with
# a glob that does not match must NOT have it, so the check can go red.
set -euo pipefail
DIR=$(cd "$(dirname "$0")/.." && pwd)
WR="$DIR/../wr"
T=$(mktemp -d); trap 'rm -rf "$T" "$DIR/wrangler.control-test.toml"' EXIT
fails=0
text_module() { # text_module <outdir>: the hash-named worker.js text module, or nothing
  find "$1" -maxdepth 1 -type f -name '*-worker.js' | head -1
}
( cd "$DIR" && "$WR" deploy --dry-run --outdir "$T/real" > "$T/real.log" 2>&1 ) || { echo "  FAIL the dry-run build failed"; tail -20 "$T/real.log"; exit 1; }
m=$(text_module "$T/real")
if [ -n "$m" ] && cmp -s "$m" "$DIR/vendor/wfp-dispatcher/worker.js" && grep -q "from \"./$(basename "$m")\"" "$T/real/worker.js"; then
  echo "  ok   the front-door code is a text module equal to vendor/wfp-dispatcher/worker.js"
else
  echo "  FAIL the front-door code is not a text module equal to the vendored file"; fails=$((fails+1))
fi
sed 's|globs = \["\*\*/wfp-dispatcher/worker.js"\]|globs = ["no-such-file.js"]|' "$DIR/wrangler.toml" > "$DIR/wrangler.control-test.toml"
grep -q 'no-such-file.js' "$DIR/wrangler.control-test.toml" || { echo "  FAIL control: the glob was not replaced"; exit 1; }
( cd "$DIR" && "$WR" deploy --dry-run --config wrangler.control-test.toml --outdir "$T/control" > "$T/control.log" 2>&1 ) || true
if [ -z "$(text_module "$T/control")" ]; then echo "  ok   control: with a glob that does not match, there is no text module"; else echo "  FAIL control: a text module without the rule"; fails=$((fails+1)); fi
rm -rf "$DIR/.wrangler"
echo "dryrun-test: $fails failing"
exit $((fails > 0))
