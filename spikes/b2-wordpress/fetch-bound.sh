#!/bin/bash
# #1316: a bounded curl for the build's local requests (file-trace.sh). Each request gives up after
# FILE_TRACE_CURL_MAX_S seconds (default 180: a cold local boot plus WooCommerce admin pages fit well inside it).
# On any transport failure, a timeout included (curl exit 28), it prints one STOP line naming the URL and returns
# curl's exit code, so a caller under `set -e` stops with a reason instead of waiting forever. HTTP status is
# unchanged: pass -f where a 4xx or 5xx should fail, as before.
bcurl() {
  local max=${FILE_TRACE_CURL_MAX_S:-180} rc url
  url=${!#}
  curl --max-time "$max" "$@"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    if [ "$rc" = 28 ]; then
      echo "file-trace: STOP: no answer from $url within $max s (curl exit 28)" >&2
    else
      echo "file-trace: STOP: a request to $url failed (curl exit $rc)" >&2
    fi
  fi
  return "$rc"
}
