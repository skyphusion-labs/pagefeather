#!/bin/bash
# #530 live check on local workerd (b-dosql, wrangler dev --local): a PHP in-place write to a file
# that came from the bundle must still be there in the NEXT request. It builds a local bundle with
# the test mu-plugin in wp-content/ here (inplace-probe.php; never in a real build), starts
# dosql-local on a fresh state, installs, writes with r+ at the same length, reads twice, and stops.
# Arena off, then LAZY_ARENA=on. Exit 0 only when every read after the write is the written bytes.
#   spikes/b2-wordpress/tests/inplace-write/run.sh        (PORT=8853 by default)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
export PORT=${PORT:-8853} DEV_LOCAL=1 DEV_ENV=dosql-local DEV_WAIT_S=${DEV_WAIT_S:-180}
WOO=0 IMPORT_CONTENT="$HERE/wp-content" IMPORT_MU_PLUGINS="inplace-probe.php inplace-probe-data" ./build.sh > /dev/null
want="read $(printf 'B%.0s' $(seq 1 64))"
fail=0
for arm in off on; do
  STATE=$(mktemp -d "${TMPDIR:-/tmp}/inplace-write.XXXXXX")
  export PERSIST_TO=$STATE
  if [ "$arm" = on ]; then export DEV_VARS="LAZY_ARENA:on"; else unset DEV_VARS; fi
  ./run.sh _ping > /dev/null
  T=(-H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}")
  curl "${T[@]}" -sf -m 300 -o /dev/null -X POST -H "x-admin-password: ${ADMIN_PASSWORD:-local-spike-password}" "http://localhost:$PORT/_install"
  w=$(curl -s -m 120 "http://localhost:$PORT/?inplace=write&nc=$RANDOM")
  for k in 1 2; do
    r=$(curl -s -m 120 "http://localhost:$PORT/?inplace=read&nc=$RANDOM")
    if [ "$r" = "$want" ]; then echo "PASS arena $arm read $k after the write: the written bytes"; else echo "FAIL arena $arm read $k: '$r' (write said '$w')"; fail=1; fi
  done
  ./run.sh --stop > /dev/null
  rm -rf "$STATE"
done
# The next build drops the probe: a plain ./build.sh has no IMPORT_CONTENT.
exit $fail
