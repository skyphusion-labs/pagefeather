#!/usr/bin/env bash
# Copy the engine notices into a release directory (#584).
#
#   package-notices.sh <release-dir> [prefix] [engine]
#
# engine is playground (default) or lean.
# prefix is empty for the b-dosql bundle and "a." for the approach-A bundle.
# Both of those product bundles ship the npm Playground engine, so they omit
# engine. The lean engine prerelease is unprefixed:
#
#   package-notices.sh <release-dir> "" lean
#
# That call requires pagefeather-engine-lean.wasm in the release dir. It
# refuses when that file's sha256 does not agree with SOURCE's differs/equals
# sentence. SOURCE names the sentence and points at SHA256SUMS; it does not
# contain the shipped digest.
#
# Offline: reads engine/notices. Writes NOTICE, SOURCE and LICENSES.tar.gz
# (the notices directory) next to the wasm, never inside the Worker module set.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
REL=${1:?usage: package-notices.sh <release-dir> [prefix] [engine]}
prefix=${2:-}
engine=${3:-playground}
case "$engine" in
  playground|lean) ;;
  *) echo "package-notices: engine must be playground or lean, not '$engine'" >&2; exit 2 ;;
esac
if [ "$engine" = "lean" ] && [ -n "$prefix" ]; then
  echo "package-notices: the lean engine release is unprefixed" >&2
  exit 2
fi
[ -d "$REL" ] || { echo "package-notices: $REL is not a directory" >&2; exit 2; }

notes="$ROOT/engine/notices"
licdir="$notes/LICENSES"
wasm=""
if [ "$engine" = "lean" ]; then
  notes="$ROOT/engine/notices/lean"
  wasm="$REL/${prefix}pagefeather-engine-lean.wasm"
  if [ ! -s "$wasm" ]; then
    echo "package-notices: lean engine requires ${prefix}pagefeather-engine-lean.wasm in the release dir" >&2
    exit 1
  fi
fi
[ -f "$notes/NOTICE" ] || { echo "package-notices: missing $notes/NOTICE" >&2; exit 1; }
[ -f "$notes/SOURCE" ] || { echo "package-notices: missing $notes/SOURCE" >&2; exit 1; }
[ -d "$licdir" ] || { echo "package-notices: missing $licdir" >&2; exit 1; }
n=$(find "$licdir" -type f | wc -l | tr -d ' ')
[ "$n" -gt 0 ] || { echo "package-notices: $licdir is empty" >&2; exit 1; }
cp "$notes/NOTICE" "$REL/${prefix}NOTICE"
cp "$notes/SOURCE" "$REL/${prefix}SOURCE"
# BSD tar (macOS) and GNU tar both accept -C. The archive unpacks to LICENSES/.
# Both engines share engine/notices/LICENSES (one text per licenses.tsv row).
tar -czf "$REL/${prefix}LICENSES.tar.gz" -C "$ROOT/engine/notices" LICENSES

if [ "$engine" = "lean" ]; then
  pin=$(. "$ROOT/engine/UPSTREAM" && printf '%s' "$SHIPPED_WASM_SHA256")
  hash=$( { sha256sum "$wasm" 2>/dev/null || shasum -a 256 "$wasm"; } | awk 'NR==1 {print $1}')
  srcf="$REL/${prefix}SOURCE"
  differs='That sha256 differs from the pinned Playground wasm sha256 above.'
  equals='That sha256 equals the pinned Playground wasm sha256 above.'
  has_d=0
  has_e=0
  grep -F -q "$differs" "$srcf" && has_d=1 || true
  grep -F -q "$equals" "$srcf" && has_e=1 || true
  drop() {
    rm -f "$REL/${prefix}NOTICE" "$REL/${prefix}SOURCE" "$REL/${prefix}LICENSES.tar.gz"
  }
  if [ "$hash" = "$pin" ]; then
    if [ "$has_e" != 1 ] || [ "$has_d" != 0 ]; then
      echo "package-notices: SOURCE does not agree with the wasm: ${prefix}pagefeather-engine-lean.wasm equals the pinned Playground wasm sha256" >&2
      drop
      exit 1
    fi
  else
    if [ "$has_d" != 1 ] || [ "$has_e" != 0 ]; then
      echo "package-notices: SOURCE does not agree with the wasm: ${prefix}pagefeather-engine-lean.wasm differs from the pinned Playground wasm sha256" >&2
      drop
      exit 1
    fi
    if grep -F -q "$hash" "$srcf"; then
      echo "package-notices: SOURCE hard-codes the shipped lean wasm sha256" >&2
      drop
      exit 1
    fi
  fi
fi
echo "package-notices: ${prefix}NOTICE ${prefix}SOURCE ${prefix}LICENSES.tar.gz ($n licence files, engine $engine)"
