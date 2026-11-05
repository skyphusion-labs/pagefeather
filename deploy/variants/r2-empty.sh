#!/bin/bash
# Delete every object in one R2 bucket through the S3 API. R2 refuses to delete
# a bucket that has objects, so destroy.sh empties a bucket before Terraform
# deletes it.
#
#   R2_KEY_ID=... R2_SECRET=... ./r2-empty.sh <endpoint> <bucket>
#
# The key must have object read and write on the bucket. The key goes to curl
# in a config file on a pipe, not in the arguments, so it is not in `ps`.
# A key change can take some seconds to work: a 401 or 403 is tried again for
# up to 90 s.
set -euo pipefail
EP=${1:?endpoint} B=${2:?bucket}
: "${R2_KEY_ID:?set R2_KEY_ID}" "${R2_SECRET:?set R2_SECRET}"
s3() { curl -sS -K <(printf 'user = "%s:%s"\n' "$R2_KEY_ID" "$R2_SECRET") --aws-sigv4 "aws:amz:auto:s3" "$@"; }
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
total=0; tries=0
while :; do
  code=$(s3 -o "$W/list.xml" -w '%{http_code}' "$EP/$B?list-type=2&max-keys=1000")
  case "$code" in
    200) ;;
    404) echo "$B: no such bucket"; exit 0 ;;
    401|403) tries=$((tries + 1)); [ "$tries" -le 18 ] || { echo "$B: list refused ($code)" >&2; exit 1; }; sleep 5; continue ;;
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
    code=$(s3 -o /dev/null -w '%{http_code}' -X DELETE "$EP/$B/$k")
    case "$code" in 200|204) total=$((total + 1)) ;; *) echo "$B: delete $k failed ($code)" >&2; exit 1 ;; esac
  done < "$W/keys"
done
echo "$B: empty ($total objects deleted)"
