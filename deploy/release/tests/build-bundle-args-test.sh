#!/bin/bash
# deploy/release/build-bundle.sh refuses what it should before any build (#431). Offline, fast.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: got '$2', want '$3'"; fails=$((fails + 1)); fi; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
out=$(BUNDLE_ENGINE=bogus bash "$HERE/build-bundle.sh" "$T/o1" 2>&1); rc=$?
check "an unknown BUNDLE_ENGINE exits 2" "$rc" 2
check "  and names the two engines" "$(echo "$out" | grep -c 'BUNDLE_ENGINE must be dosql or a')" 1
check "  and builds nothing (no output dir made)" "$([ -e "$T/o1" ] && echo made || echo none)" none
mkdir -p "$T/o2"; echo x > "$T/o2/f"
out=$(BUNDLE_ENGINE=a bash "$HERE/build-bundle.sh" "$T/o2" 2>&1); rc=$?
check "BUNDLE_ENGINE=a into a non-empty dir exits 2" "$rc" 2
# The engine and id rules are in the script; a full build exercises them in CI (release-bundle.yml).
check "an a build id must carry -a" "$(grep -c 'a:\*) echo "build-bundle: build $build_id is not an ENGINE=a build"' "$HERE/build-bundle.sh")" 1
check "a b-dosql bundle refuses an -a id" "$(grep -c 'is an ENGINE=a build, not b-dosql' "$HERE/build-bundle.sh")" 1
check "the a main module is index-a-lean.js and its assets are prefixed a." "$(grep -c 'a) main=index-a-lean.js; prefix="a." ;;' "$HERE/build-bundle.sh")" 1
echo "$fails failing case(s)"
[ "$fails" = 0 ]
