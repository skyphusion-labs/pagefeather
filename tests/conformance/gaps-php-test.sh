#!/bin/bash
# php/pf-conformance-gaps.php (#759): it fires the fatal ONLY with the trigger AND beside the throwaway marker.
#   bash tests/conformance/gaps-php-test.sh
set -u
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d "${TMPDIR:-/tmp}/pf-gaps.XXXXXX"); trap 'rm -rf "$t"' EXIT
fails=0
case_() { # case_ <label> <want: fatal|quiet> <marker: yes|no> <query value or "">
  local d="$t/$RANDOM$RANDOM"; mkdir -p "$d"; cp "$here/php/pf-conformance-gaps.php" "$d/"
  [ "$3" = yes ] && echo '<?php' > "$d/pf-conformance-throwaway.php"
  local got
  got=$(php -r '$_GET = $argv[2] === "" ? array() : array( "pf_conformance" => $argv[2] ); try { require $argv[1]; echo "quiet"; } catch ( Error $e ) { echo ( false !== strpos( $e->getMessage(), "NonExistentClass" ) ) ? "fatal" : "other: " . $e->getMessage(); }' "$d/pf-conformance-gaps.php" "$4" 2>&1)
  if [ "$got" = "$2" ]; then echo "PASS $1"; else echo "FAIL $1 (got $got)"; fails=$((fails+1)); fi
}
case_ "the trigger beside the marker: the fatal runs" fatal yes fatal
case_ "no trigger: nothing happens" quiet yes ""
case_ "another value: nothing happens" quiet yes fatalx
case_ "the trigger with NO marker (a real site): nothing happens" quiet no fatal
php -l "$here/php/pf-conformance-gaps.php" >/dev/null || { echo "FAIL php -l"; fails=$((fails+1)); }
echo "$fails failing"
[ "$fails" = 0 ]
