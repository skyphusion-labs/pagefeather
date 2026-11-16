#!/usr/bin/env bash
# Assemble the lean engine prerelease (#771) from a pagefeather-engine-s1-lean artifact directory.
#
#   engine/tools/publish-lean.sh <artifact dir> <out dir>
#
# Reads the pin from spikes/b2-wordpress/engine.lock (ENGINE_LOCK overrides it, for tests). Refuses (exit 2) unless
# the artifact's 8_3_36/php_8_3.wasm and php_8_3.js are exactly the pinned sha256 values. Then writes into <out dir>:
# the two files under their published names (LEAN_WASM_ASSET, LEAN_JS_ASSET; no published name says PHP), SHA256SUMS
# of the two, the notices from #742's packager (deploy/release/package-notices.sh <out> "" lean: NOTICE, SOURCE,
# LICENSES.tar.gz, which itself refuses a SOURCE that disagrees with the wasm), and release-body.md. It publishes
# nothing: .github/workflows/pagefeather-engine.yml (input publish) creates the release from <out dir>.
# Test: engine/tools/tests/publish-lean-test.sh.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
ART=${1:?usage: publish-lean.sh <artifact dir> <out dir>}
OUT=${2:?usage: publish-lean.sh <artifact dir> <out dir>}
LOCK=${ENGINE_LOCK:-$ROOT/spikes/b2-wordpress/engine.lock}
sha() { { sha256sum "$1" 2>/dev/null || shasum -a 256 "$1"; } | cut -d' ' -f1; }
val() { sed -n "s/^$1=//p" "$LOCK"; }
[ -s "$LOCK" ] || { echo "publish-lean: no lock at $LOCK" >&2; exit 2; }
TAG=$(val LEAN_TAG); WA=$(val LEAN_WASM_ASSET); JA=$(val LEAN_JS_ASSET); WS=$(val LEAN_WASM_SHA256); JS=$(val LEAN_JS_SHA256)
for v in TAG WA JA WS JS; do [ -n "${!v}" ] || { echo "publish-lean: $LOCK has no value for $v" >&2; exit 2; }; done
case "$WA$JA$TAG" in *[Pp][Hh][Pp]*) echo "publish-lean: a published name says PHP ($TAG, $WA, $JA); refused (Conrad, 2026-11-14)" >&2; exit 2 ;; esac
w=$(find "$ART" -path '*8_3_36/php_8_3.wasm' -type f | head -1); j="$ART/php_8_3.js"
[ -n "$w" ] && [ -s "$w" ] && [ -s "$j" ] || { echo "publish-lean: $ART has no 8_3_36/php_8_3.wasm and php_8_3.js (a pagefeather-engine-s1-lean artifact)" >&2; exit 2; }
gw=$(sha "$w"); gj=$(sha "$j")
[ "$gw" = "$WS" ] || { echo "publish-lean: the artifact's wasm is $gw, not the pin $WS; refused" >&2; exit 2; }
[ "$gj" = "$JS" ] || { echo "publish-lean: the artifact's loader is $gj, not the pin $JS; refused" >&2; exit 2; }
mkdir -p "$OUT"
[ -z "$(ls -A "$OUT")" ] || { echo "publish-lean: $OUT is not empty" >&2; exit 2; }
cp "$w" "$OUT/$WA"; cp "$j" "$OUT/$JA"
( cd "$OUT" && { sha256sum "$WA" "$JA" 2>/dev/null || shasum -a 256 "$WA" "$JA"; } > SHA256SUMS )
"$ROOT/deploy/release/package-notices.sh" "$OUT" "" lean
for f in NOTICE SOURCE LICENSES.tar.gz; do [ -s "$OUT/$f" ] || { echo "publish-lean: the packager wrote no $f" >&2; exit 2; }; done
cat > "$OUT/release-body.md" <<BODY
The pagefeather engine, lean build (s1-lean), the default engine of pagefeather b-dosql sites (#771).

This is a WebAssembly build of the pagefeather engine, made by engine/build.sh in this repository at this tag. It includes PHP (see NOTICE). It is the exact build that #724 measured (pagefeather-engine run ${FROM_RUN:-unknown}; build id tag -e${TAG##*-}).

| file | sha256 |
| --- | --- |
| $WA | $WS |
| $JA | $JS |

The two files are verified against spikes/b2-wordpress/engine.lock before this release is made; SHA256SUMS lists them. A build fetches them by these hashes and refuses any other bytes (spikes/b2-wordpress/engine.sh).

It ships with its notices (#584): NOTICE, SOURCE (the corresponding source: the build inputs at this tag, and the pinned upstream sources with their URLs) and LICENSES.tar.gz (the licence text of each component), from deploy/release/package-notices.sh.

A prerelease: it is an engine artifact, not a product release.
BODY
echo "publish-lean: $TAG ready in $OUT ($WA $gw, $JA $gj)"
