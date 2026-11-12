#!/bin/bash
# Reverse the zone cache lever (CR #18). Removes the Workers Custom Domain and
# clears the cache ruleset. Nothing else on the zone is touched.
#
#   MODE=dedicated (default):
#     CLOUDFLARE_API_TOKEN=... ACCOUNT_ID=... ZONE_ID=... HOSTNAME=wp.example.com \
#       ./deploy/zone/destroy.sh
#
#   MODE=multitenant (SaaS home zone): clears the one zone-wide ruleset only; it
#     does NOT detach tenant hostnames (the provisioning core owns those).
#     CLOUDFLARE_API_TOKEN=... ACCOUNT_ID=... ZONE_ID=... MODE=multitenant \
#       ./deploy/zone/destroy.sh
#
# Idempotent: a domain that is already gone is success, and clearing an already
# empty ruleset is success. The token is read from the environment and passed to
# curl through a -K config on a pipe, never in argv.
set -euo pipefail

API="https://api.cloudflare.com/client/v4"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
MODE=${MODE:-dedicated}

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
ACCOUNT_ID=${ACCOUNT_ID:-${CLOUDFLARE_ACCOUNT_ID:-}}
: "${ACCOUNT_ID:?set ACCOUNT_ID (or CLOUDFLARE_ACCOUNT_ID)}"
: "${ZONE_ID:?set ZONE_ID}"

cf() { # cf <METHOD> <PATH> [curl args...]
  local m=$1 p=$2; shift 2
  curl -s -m 60 -X "$m" -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") \
    -H 'content-type: application/json' -w '\n%{http_code}' "$API$p" "$@"
}
cf_ok() { # cf_ok <label> <METHOD> <PATH> [curl args...]
  local label=$1; shift
  local out code body
  out=$(cf "$@") || { echo "  $label: curl failed" >&2; exit 1; }
  code=$(printf '%s' "$out" | tail -1)
  body=$(printf '%s' "$out" | sed '$d')
  case "$code" in
    2*) printf '%s' "$body" ;;
    404) printf '%s' "$body" ;;  # already gone: idempotent success
    *)  echo "  $label: HTTP $code" >&2; echo "$body" | head -5 >&2; exit 1 ;;
  esac
}

# Before ANY change (#282): clearing the phase is the same PUT, so it would wipe
# another owner's rules too.
# shellcheck source=deploy/zone/owner-guard.sh
. "$SCRIPT_DIR/owner-guard.sh"
echo "== 0. Owner check of the cache phase (zone $ZONE_ID)"
guard_cache_phase

if [ "$MODE" = dedicated ]; then
  : "${HOSTNAME:?set HOSTNAME in MODE=dedicated}"
  echo "== 1. Remove the Workers Custom Domain for $HOSTNAME (zone $ZONE_ID)"
  LIST=$(cf_ok "list domains" GET "/accounts/$ACCOUNT_ID/workers/domains")
  DOMAIN_ID=$(printf '%s' "$LIST" | HOSTNAME="$HOSTNAME" ZONE_ID="$ZONE_ID" python3 -c '
import json, sys, os
host, zone = os.environ["HOSTNAME"], os.environ["ZONE_ID"]
try:
    rows = json.load(sys.stdin).get("result") or []
except ValueError:
    rows = []
m = [r for r in rows if r.get("hostname") == host and r.get("zone_id") == zone]
print(m[0]["id"] if m else "")')
  if [ -n "$DOMAIN_ID" ]; then
    cf_ok "delete domain" DELETE "/accounts/$ACCOUNT_ID/workers/domains/$DOMAIN_ID" >/dev/null
    echo "  removed custom domain $DOMAIN_ID"
  else
    echo "  no custom domain for $HOSTNAME (already gone)"
  fi
else
  echo "== MODE=multitenant: not detaching tenant hostnames (the provisioning core owns those)"
fi

echo "== Clear the cache ruleset (http_request_cache_settings entrypoint)"
# PUT the entrypoint with no rules: this removes the rules this lever added.
# The phase entrypoint itself is not deletable; an empty rules list is the clear.
cf_ok "clear ruleset" PUT "/zones/$ZONE_ID/rulesets/phases/http_request_cache_settings/entrypoint" \
  --data '{"rules":[]}' >/dev/null
echo "  cleared (0 rules)"

echo
if [ "$MODE" = dedicated ]; then
  echo "Reversed. The zone no longer caches in front of the Worker, and $HOSTNAME no"
  echo "longer resolves to the Worker. Re-apply with ./deploy/zone/apply.sh."
else
  echo "Reversed. The zone no longer caches tenant HTML at the edge. Tenant hostnames"
  echo "are untouched. Re-apply with MODE=multitenant ./deploy/zone/apply.sh."
fi
