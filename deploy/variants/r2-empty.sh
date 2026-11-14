#!/bin/bash
# Delete every object in one R2 bucket through the S3 API. R2 refuses to delete
# a bucket that has objects, so destroy.sh empties a bucket before Terraform
# deletes it.
#
#   R2_KEY_ID=... R2_SECRET=... ./r2-empty.sh <endpoint> <bucket>
#   R2_CRED_FILE=<file> [R2_CRED_REFRESH=<command>] ./r2-empty.sh <endpoint> <bucket>
#
# The key must have object read and write on the bucket. The key goes to curl
# in a config file on a pipe, not in the arguments, so it is not in `ps`.
# A key change can take some seconds to work: a 401 or 403, on the list AND on
# a delete, is tried again for up to R2_RETRY_S (90) s, every R2_RETRY_STEP (5)
# s, and each refusal is logged with its UTC time. The delete had no retry:
# destroy.sh widens this key to the media bucket just before it empties it,
# and on 2026-11-06 the list passed and the first delete got 403 (wp-c1-mail2,
# issue #115). Any other answer stops at once. With R2_CRED_REFRESH, the first refusal of a
# streak also mints a fresh credential (a temporary credential expires, deploy/wfp #273).
set -euo pipefail
EP=${1:?endpoint} B=${2:?bucket}
# The key (#273): R2_KEY_ID and R2_SECRET (with R2_SESSION_TOKEN for a temporary credential), or
# R2_CRED_FILE, a file of those three lines that R2_CRED_REFRESH rewrites with a fresh credential.
# Every request reads the file again, so a refresh reaches every request after it. The session
# token goes into the curl config on a pipe, as the key does, never into the arguments.
# shellcheck disable=SC1090 # the file r2_temp.py writes: three shell-quoted assignments
r2_cfg() { ( if [ -n "${R2_CRED_FILE:-}" ]; then . "$R2_CRED_FILE"; fi
  printf 'user = "%s:%s"\n' "$R2_KEY_ID" "$R2_SECRET"
  if [ -n "${R2_SESSION_TOKEN:-}" ]; then printf 'header = "x-amz-security-token: %s"\n' "$R2_SESSION_TOKEN"; fi ); }
r2_key_set() { if [ -n "${R2_CRED_FILE:-}" ]; then [ -r "$R2_CRED_FILE" ]; else [ -n "${R2_KEY_ID:-}" ] && [ -n "${R2_SECRET:-}" ]; fi; }
# r2_refresh: on a refusal, mint a fresh credential with R2_CRED_REFRESH (a temporary one may have
# expired). One at a time (a lock beside the file), and not again within R2_REFRESH_MIN_S (20) s of
# the last one, so parallel requests that are all refused mint once. No R2_CRED_REFRESH: nothing.
r2_refresh() {
  [ -n "${R2_CRED_REFRESH:-}" ] && [ -n "${R2_CRED_FILE:-}" ] || return 0
  mkdir "$R2_CRED_FILE.lock" 2>/dev/null || return 0
  if python3 -I -c 'import os, sys, time; sys.exit(0 if time.time() - os.path.getmtime(sys.argv[1]) >= float(sys.argv[2]) else 1)' "$R2_CRED_FILE" "${R2_REFRESH_MIN_S:-20}"; then
    echo "r2: refused at $(date -u +%TZ): minting a fresh credential" >&2
    bash -c "$R2_CRED_REFRESH" >&2 || echo "r2: the fresh credential was NOT minted" >&2
  fi
  rmdir "$R2_CRED_FILE.lock" 2>/dev/null || true
}
r2_key_set || { echo "set R2_KEY_ID and R2_SECRET, or R2_CRED_FILE" >&2; exit 2; }
s3() { curl -sS -K <(r2_cfg) --aws-sigv4 "aws:amz:auto:s3" "$@"; }
RETRY_S=${R2_RETRY_S:-90}; STEP=${R2_RETRY_STEP:-5}
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
now() { date +%s; }
# refused <what> <code> <since> <first>: log the first refusal, wait one step,
# and return 1 when the time is up.
refused() {
  local left=$(( $3 + RETRY_S - $(now) ))
  if [ "$left" -le 0 ]; then
    echo "$B: $1 refused ($2) for $RETRY_S s: the key cannot do it" >&2
    return 1
  fi
  [ "$4" = 1 ] && { echo "$B: $1 refused ($2) at $(date -u +%TZ); trying again for up to $RETRY_S s (a key change can take some seconds)" >&2; r2_refresh; }
  sleep "$STEP"
}
total=0; list_since=""
while :; do
  code=$(s3 -o "$W/list.xml" -w '%{http_code}' "$EP/$B?list-type=2&max-keys=1000")
  case "$code" in
    200) [ -z "$list_since" ] || echo "$B: list accepted at $(date -u +%TZ), $(( $(now) - list_since )) s after the first refusal" >&2; list_since="" ;;
    404) echo "$B: no such bucket"; exit 0 ;;
    401|403) first=0; [ -n "$list_since" ] || { list_since=$(now); first=1; }; refused list "$code" "$list_since" "$first" || exit 1; continue ;;
    *) echo "$B: list failed ($code)" >&2; head -c 300 "$W/list.xml" >&2; exit 1 ;;
  esac
  # One URL-encoded key per line. No key in the list: the bucket is empty.
  python3 -I -c '
import sys, urllib.parse, xml.etree.ElementTree as ET
for e in ET.parse(sys.argv[1]).getroot().iter():
    if e.tag.rsplit("}", 1)[-1] == "Key":
        print(urllib.parse.quote(e.text, safe="/"))' "$W/list.xml" > "$W/keys"
  [ -s "$W/keys" ] || break
  while read -r k; do
    since=""
    while :; do
      code=$(s3 -o /dev/null -w '%{http_code}' -X DELETE "$EP/$B/$k")
      case "$code" in
        200|204) total=$((total + 1)); [ -z "$since" ] || echo "$B: delete accepted at $(date -u +%TZ), $(( $(now) - since )) s after the first refusal" >&2; break ;;
        401|403) first=0; [ -n "$since" ] || { since=$(now); first=1; }; refused "delete $k" "$code" "$since" "$first" || exit 1 ;;
        *) echo "$B: delete $k failed ($code)" >&2; exit 1 ;;
      esac
    done
  done < "$W/keys"
done
echo "$B: empty ($total objects deleted)"
