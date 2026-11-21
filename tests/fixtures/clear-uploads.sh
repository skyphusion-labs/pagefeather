#!/bin/bash
# Clear one site's uploads and nothing else (#1284).
#
#   R2_KEY_ID=... R2_SECRET=... clear-uploads.sh <site> <endpoint> <bucket> <prefix>
#   R2_CRED_FILE=<file> [R2_CRED_REFRESH=<command>] clear-uploads.sh <site> <endpoint> <bucket> <prefix>
#
# The bucket must be that site's own media bucket, wp-wfp-<site>-media
# (deploy/wfp/lib.sh media_bucket). The prefix must be uploads/, the key prefix
# the Worker serves (spikes/b2-wordpress/index.js serveUpload). An empty prefix,
# a root prefix, and another site's prefix are refused before any request.
#
# The run lists every object under that prefix, prints the count, deletes each
# key by itself (no prefix wildcard), then lists again and prints the count.
# The read-back must be 0. _snapshots/ and _build/ are outside the prefix, so
# they stay. This is not r2-empty.sh: that script deletes a whole bucket.
#
# load-sample-store.sh calls this only after the fixture pin matches and
# deploy/wfp/site import has replaced the database.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
PY="$HERE/uploads-prefix.py"
s=${1:?usage: clear-uploads.sh <site> <endpoint> <bucket> <prefix>}
EP=${2:?endpoint}
B=${3:?bucket}
prefix=${4-}
python3 -I "$PY" check "$s" "$B" "$prefix"

if [ -n "${R2_CRED_FILE:-}" ]; then
  [ -r "$R2_CRED_FILE" ] || { echo "set R2_KEY_ID and R2_SECRET, or R2_CRED_FILE" >&2; exit 2; }
else
  [ -n "${R2_KEY_ID:-}" ] && [ -n "${R2_SECRET:-}" ] || { echo "set R2_KEY_ID and R2_SECRET, or R2_CRED_FILE" >&2; exit 2; }
fi

W=$(mktemp -d "${TMPDIR:-/tmp}/clear-uploads.XXXXXX")
chmod 700 "$W"
trap 'rm -rf "$W"' EXIT

# The key stays in the curl config file, not in the arguments, as r2-empty.sh does.
r2_cfg_write() {
  if [ -n "${R2_CRED_FILE:-}" ]; then
    # shellcheck disable=SC1090
    . "$R2_CRED_FILE"
  fi
  {
    printf 'user = "%s:%s"\n' "$R2_KEY_ID" "$R2_SECRET"
    if [ -n "${R2_SESSION_TOKEN:-}" ]; then
      printf 'header = "x-amz-security-token: %s"\n' "$R2_SESSION_TOKEN"
    fi
  } > "$W/curl.cfg"
  chmod 600 "$W/curl.cfg"
}
s3() { r2_cfg_write; curl -sS -K "$W/curl.cfg" --aws-sigv4 "aws:amz:auto:s3" "$@"; }
urlenc() { python3 -I -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }
keyenc() { python3 -I -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe="/"))' "$1"; }

RETRY_S=${R2_RETRY_S:-90}
STEP=${R2_RETRY_STEP:-5}
now() { date +%s; }
refreshed=0
try_refresh() {
  [ -n "${R2_CRED_REFRESH:-}" ] || return 0
  [ "$refreshed" = 0 ] || return 0
  refreshed=1
  bash -c "$R2_CRED_REFRESH" || echo "uploads: the credential refresh did not run" >&2
}

# list_into <file>: every key under the prefix, over every page. A missing bucket
# is an empty list. Any other list failure returns 1.
list_into() {
  local out=$1 token="" pages=0 code since="" first left q enc
  : > "$out"
  while :; do
    pages=$((pages + 1))
    [ "$pages" -le 10000 ] || { echo "uploads: the list did not end" >&2; return 1; }
    enc=$(urlenc "$prefix")
    q="list-type=2&prefix=$enc&max-keys=${CLEAR_PAGE_KEYS:-1000}"
    if [ -n "$token" ]; then q="$q&continuation-token=$(urlenc "$token")"; fi
    since=""
    while :; do
      code=$(s3 -o "$W/list.xml" -w '%{http_code}' "$EP/$B?$q") || code=000
      case "$code" in
        200) break ;;
        404)
          if [ "$pages" -eq 1 ]; then : > "$out"; return 0; fi
          echo "uploads: list failed (404)" >&2
          return 1
          ;;
        401|403)
          if [ -z "$since" ]; then since=$(now); first=1; else first=0; fi
          left=$((since + RETRY_S - $(now)))
          if [ "$left" -le 0 ]; then echo "uploads: list refused ($code)" >&2; return 1; fi
          [ "$first" = 1 ] && { echo "uploads: list refused ($code); trying again" >&2; try_refresh; }
          sleep "$STEP"
          ;;
        *) echo "uploads: list failed ($code)" >&2; head -c 200 "$W/list.xml" >&2; return 1 ;;
      esac
    done
    python3 -I "$PY" page "$W/list.xml" "$W/token" >> "$out"
    token=$(cat "$W/token")
    [ -n "$token" ] || break
  done
}

# One request with a 401 or 403 is tried again. code is echoed.
delete_key() {
  local enc=$1 code since="" first left
  since=""
  while :; do
    code=$(s3 -o /dev/null -w '%{http_code}' -X DELETE "$EP/$B/$enc") || code=000
    case "$code" in
      200|204) printf '%s' "$code"; return 0 ;;
      401|403)
        if [ -z "$since" ]; then since=$(now); first=1; else first=0; fi
        left=$((since + RETRY_S - $(now)))
        if [ "$left" -le 0 ]; then printf '%s' "$code"; return 1; fi
        [ "$first" = 1 ] && { echo "uploads: delete refused ($code); trying again" >&2; try_refresh; }
        sleep "$STEP"
        ;;
      *) printf '%s' "$code"; return 1 ;;
    esac
  done
}

rc=0
list_into "$W/keys" || rc=$?
[ "$rc" = 0 ] || exit "$rc"
sort -u "$W/keys" -o "$W/keys"
python3 -I "$PY" vet < "$W/keys" > "$W/vetted"
mv "$W/vetted" "$W/keys"
n=$(grep -c . "$W/keys" || true)
echo "uploads: will delete $n object(s) under $prefix in $B"
cat "$W/keys"
deleted=0
while IFS= read -r k; do
  [ -n "$k" ] || continue
  code=$(delete_key "$(keyenc "$k")") || { echo "uploads: delete $k failed ($code)" >&2; exit 1; }
  deleted=$((deleted + 1))
done < "$W/keys"
echo "uploads: deleted $deleted"
rc=0
list_into "$W/after" || rc=$?
[ "$rc" = 0 ] || exit "$rc"
na=$(grep -c . "$W/after" || true)
echo "uploads: read back $na"
[ "$na" = 0 ] || { echo "uploads: $na object(s) still under $prefix in $B" >&2; cat "$W/after" >&2; exit 1; }
