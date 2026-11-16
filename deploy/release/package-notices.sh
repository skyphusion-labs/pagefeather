#!/usr/bin/env bash
# Copy the engine notices into a release directory (#584).
#
#   package-notices.sh <release-dir> [prefix]
#
# prefix is empty for the b-dosql bundle and "a." for the approach-A bundle.
# Offline: reads engine/notices/{NOTICE,SOURCE,LICENSES/}. Writes NOTICE, SOURCE
# and LICENSES.tar.gz (the notices directory) next to the wasm, never inside
# the Worker module set.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
REL=${1:?usage: package-notices.sh <release-dir> [prefix]}
prefix=${2:-}
src="$ROOT/engine/notices"
[ -d "$REL" ] || { echo "package-notices: $REL is not a directory" >&2; exit 2; }
[ -f "$src/NOTICE" ] || { echo "package-notices: missing $src/NOTICE" >&2; exit 1; }
[ -f "$src/SOURCE" ] || { echo "package-notices: missing $src/SOURCE" >&2; exit 1; }
[ -d "$src/LICENSES" ] || { echo "package-notices: missing $src/LICENSES" >&2; exit 1; }
n=$(find "$src/LICENSES" -type f | wc -l | tr -d ' ')
[ "$n" -gt 0 ] || { echo "package-notices: $src/LICENSES is empty" >&2; exit 1; }
cp "$src/NOTICE" "$REL/${prefix}NOTICE"
cp "$src/SOURCE" "$REL/${prefix}SOURCE"
# BSD tar (macOS) and GNU tar both accept -C. The archive unpacks to LICENSES/.
tar -czf "$REL/${prefix}LICENSES.tar.gz" -C "$src" LICENSES
echo "package-notices: ${prefix}NOTICE ${prefix}SOURCE ${prefix}LICENSES.tar.gz ($n licence files)"
