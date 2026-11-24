#!/bin/bash
# Redirect pagefeather.com (and www) to www.pagefeather.dev (CR #1460).
#
# Adds proxied originless A/AAAA at the apex and at www so HTTP enters Cloudflare.
# Puts one Single Redirect rule on the zone. Mail records stay.
#
#   CLOUDFLARE_API_TOKEN=... \
#     ZONE_ID=19cd63f2dec4d27a65eb003d6ba183c1 \
#     ./deploy/product-site/redirect-com.sh
#
# Idempotent. Token goes to curl through a -K config on a pipe, never in argv.
set -euo pipefail

API="https://api.cloudflare.com/client/v4"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (Zone DNS Edit + Zone Rulesets Edit)}"
: "${ZONE_ID:?set ZONE_ID (pagefeather.com zone id)}"

ZONE_NAME=${ZONE_NAME:-pagefeather.com}
WWW_NAME="www.${ZONE_NAME}"

cf() {
  local m=$1 p=$2; shift 2
  curl -s -m 60 -X "$m" -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") \
    -H 'content-type: application/json' -w '\n%{http_code}' "$API$p" "$@"
}
cf_ok() {
  local label=$1; shift
  local out code body
  out=$(cf "$@") || { echo "  $label: curl failed" >&2; exit 1; }
  code=$(printf '%s' "$out" | tail -1)
  body=$(printf '%s' "$out" | sed '$d')
  case "$code" in
    2*) printf '%s' "$body" ;;
    *)  echo "  $label: HTTP $code" >&2; echo "$body" | head -5 >&2; exit 1 ;;
  esac
}

# Ensure one proxied originless record exists for name+type.
# Grey-cloud or wrong content is not success: Single Redirect only runs on proxied hosts.
ensure_originless() {
  local name=$1 type=$2 content=$3
  local list decision id
  list=$(cf_ok "list $type $name" GET "/zones/$ZONE_ID/dns_records?type=$type&name=$name&per_page=5")
  decision=$(printf '%s' "$list" | WANT_CONTENT="$content" python3 "$SCRIPT_DIR/originless-decide.py")
  case "$decision" in
    ok)
      echo "  $type $name already proxied originless ($content)"
      return 0
      ;;
    create)
      cf_ok "create $type $name" POST "/zones/$ZONE_ID/dns_records" \
        --data "$(printf '{"type":"%s","name":"%s","content":"%s","proxied":true,"ttl":1}' "$type" "$name" "$content")" \
        >/dev/null
      echo "  created $type $name -> $content (proxied)"
      return 0
      ;;
    patch\ *)
      id=${decision#patch }
      cf_ok "patch $type $name" PUT "/zones/$ZONE_ID/dns_records/$id" \
        --data "$(printf '{"type":"%s","name":"%s","content":"%s","proxied":true,"ttl":1}' "$type" "$name" "$content")" \
        >/dev/null
      echo "  updated $type $name -> $content (proxied) id=$id"
      return 0
      ;;
    fail\ *)
      echo "  $type $name: multiple DNS records, none proxied originless ($content); refuse" >&2
      echo "  ids: ${decision#fail }" >&2
      exit 1
      ;;
    *)
      echo "  $type $name: unexpected decide '$decision'" >&2
      exit 1
      ;;
  esac
}

echo "== 1. Originless DNS for HTTP on $ZONE_NAME and $WWW_NAME (zone $ZONE_ID)"
ensure_originless "$ZONE_NAME" A "192.0.2.1"
ensure_originless "$ZONE_NAME" AAAA "100::"
ensure_originless "$WWW_NAME" A "192.0.2.1"
ensure_originless "$WWW_NAME" AAAA "100::"

echo "== 2. Single Redirect ruleset (http_request_dynamic_redirect)"
RULESET=$(cat "$SCRIPT_DIR/redirect-com-ruleset.json")
cf_ok "redirect ruleset" PUT "/zones/$ZONE_ID/rulesets/phases/http_request_dynamic_redirect/entrypoint" \
  --data "$RULESET" >/dev/null
echo "  ok (301 to https://www.pagefeather.dev + path; query preserved)"

echo
echo "Applied. Verify:"
echo "  curl -sI https://pagefeather.com/ | grep -iE 'HTTP/|location:'"
echo "  curl -sI https://www.pagefeather.com/about/ | grep -iE 'HTTP/|location:'"
echo "Expect 301 Location: https://www.pagefeather.dev/ and .../about/"
echo "Mail records are untouched."
