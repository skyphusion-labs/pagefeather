#!/bin/bash
# Apply the zone cache lever in front of a WordPress Worker (CR #18).
#
#   CLOUDFLARE_API_TOKEN=... ACCOUNT_ID=... ZONE_ID=... HOSTNAME=wp.example.com \
#     WORKER_SERVICE=my-worker ./deploy/zone/apply.sh
#
# What it does, idempotently (safe to re-run):
#   1. Attaches HOSTNAME to the Worker WORKER_SERVICE as a Workers Custom Domain,
#      so the Worker is the ORIGIN behind the proxied hostname (a Worker on a
#      route runs BEFORE the zone cache; a Custom Domain lets the zone cache sit
#      in front, issue #18).
#   2. Writes the two-rule cache ruleset (cache-ruleset.json, HOSTNAME
#      substituted) to the zone's http_request_cache_settings phase entrypoint:
#      bypass dynamic/admin/session, cache anonymous HTML at the edge.
#
# It does NOT create DNS, enable APO, or touch anything else on the zone.
# Reverse it with destroy.sh. The token is read from the environment and passed
# to curl through a -K config on a pipe, never in argv (so it is not in `ps`).
#
# APO (Automatic Platform Optimization) is a separate, PAID, mostly-manual step;
# see README.md. This script applies the free, as-code Cache Rules path only.
set -euo pipefail

API="https://api.cloudflare.com/client/v4"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (needs Workers Routes Edit + Cache Rules/Zone Rulesets Edit)}"
ACCOUNT_ID=${ACCOUNT_ID:-${CLOUDFLARE_ACCOUNT_ID:-}}
: "${ACCOUNT_ID:?set ACCOUNT_ID (or CLOUDFLARE_ACCOUNT_ID)}"
: "${ZONE_ID:?set ZONE_ID (the zone that owns HOSTNAME)}"
: "${HOSTNAME:?set HOSTNAME (e.g. wp.example.com)}"
: "${WORKER_SERVICE:?set WORKER_SERVICE (the Worker script/service name to serve this host)}"
[[ "$HOSTNAME" =~ ^[a-z0-9.-]+$ ]] || { echo "HOSTNAME must be a bare hostname, got $HOSTNAME" >&2; exit 2; }

# One Cloudflare API call. Prints the body, then a final line with the HTTP code.
# The token goes to curl in a -K config on a pipe, never in argv.
cf() { # cf <METHOD> <PATH> [curl args...]
  local m=$1 p=$2; shift 2
  curl -s -m 60 -X "$m" -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") \
    -H 'content-type: application/json' -w '\n%{http_code}' "$API$p" "$@"
}
# Run cf, split the trailing code, fail on a non-2xx with the body shown.
cf_ok() { # cf_ok <label> <METHOD> <PATH> [curl args...]
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

echo "== 1. Workers Custom Domain: $HOSTNAME -> $WORKER_SERVICE (zone $ZONE_ID)"
# PUT /accounts/{acc}/workers/domains is an UPSERT: attaching an already-attached
# host to the same service is success, so this is idempotent.
cf_ok "custom domain" PUT "/accounts/$ACCOUNT_ID/workers/domains" \
  --data "$(printf '{"zone_id":"%s","hostname":"%s","service":"%s","environment":"production"}' "$ZONE_ID" "$HOSTNAME" "$WORKER_SERVICE")" \
  >/dev/null
echo "  ok (worker is the origin behind $HOSTNAME)"

echo "== 2. Cache ruleset on the http_request_cache_settings phase entrypoint"
# PUT the phase entrypoint REPLACES its rules, so re-running converges to exactly
# these two rules (idempotent). HOSTNAME is substituted into the template.
RULESET=$(sed "s/@HOSTNAME@/$HOSTNAME/g" "$SCRIPT_DIR/cache-ruleset.json")
cf_ok "cache ruleset" PUT "/zones/$ZONE_ID/rulesets/phases/http_request_cache_settings/entrypoint" \
  --data "$RULESET" >/dev/null
echo "  ok (2 rules: bypass dynamic/admin/session; cache anon HTML edge_ttl=3600 browser_ttl=0)"

echo
echo "Applied. Verify a cached anonymous page:"
echo "  curl -sI https://$HOSTNAME/ | grep -iE 'cf-cache-status|age|cache-control'"
echo "A growing Age header on repeat GETs = the ZONE edge is serving, the Worker is not invoked."
echo "Reverse with: ZONE_ID=$ZONE_ID HOSTNAME=$HOSTNAME ACCOUNT_ID=$ACCOUNT_ID ./deploy/zone/destroy.sh"
echo "NOTE (#205): edge_ttl=3600 means up to 1h stale without purge-on-publish. See README.md."

# ---------------------------------------------------------------------------
# Optional levers, NOT applied by this script. They are paid, manual, or opt-in.
# Documented here as scaffolds; see README.md for the full cost/caveat.
#
# APO (Automatic Platform Optimization). PAID: the setting is editable=false on
# Free; it needs the $5/mo APO add-on or a Pro+ plan. For a Worker-ORIGIN it
# overlaps the free Cache Rule above, so the opinionated default is Cache Rules.
# To enable APO manually on a paid zone (exact call, left commented on purpose):
#
#   cf_ok "apo" PATCH "/zones/$ZONE_ID/settings/automatic_platform_optimization" \
#     --data "$(printf '{"value":{"enabled":true,"cf":true,"wordpress":true,"wp_plugin":false,"hostnames":["%s"],"cache_by_device_type":false}}' "$HOSTNAME")"
#
# Zaraz. OPT-IN, not a default. Zaraz offloads third-party browser scripts
# (analytics, tag managers) to the edge, but a headless b-dosql WordPress ships
# NO trackers by default (privacy is the point), so there is nothing to offload
# unless a tenant adds one. If a tenant opts in, configure tools via:
#
#   cf_ok "zaraz" PUT "/zones/$ZONE_ID/settings/zaraz/v2/config" --data '{ ... }'
#
# This script does not build a Zaraz config; it is a scaffold only.
# ---------------------------------------------------------------------------
