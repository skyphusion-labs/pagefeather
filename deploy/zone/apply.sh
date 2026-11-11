#!/bin/bash
# Apply the zone cache lever in front of a WordPress Worker (CR #18, issue #201).
#
# Two modes:
#
#   MODE=dedicated (default): one zone serves ONE site on its own hostname
#     (bring-your-own-domain, #157). apply.sh attaches HOSTNAME to the Worker as
#     a Workers Custom Domain (so the Worker is the origin behind the proxied
#     hostname) and writes a per-hostname cache ruleset.
#
#       CLOUDFLARE_API_TOKEN=... ACCOUNT_ID=... ZONE_ID=... HOSTNAME=wp.example.com \
#         WORKER_SERVICE=my-worker ./deploy/zone/apply.sh
#
#   MODE=multitenant: ONE SaaS home zone (e.g. skyphusionwp.dev) terminates MANY
#     tenant hostnames. apply.sh writes ONE zone-wide cache ruleset for all
#     tenants and does NOT attach a Custom Domain (the provisioning core attaches
#     each tenant hostname). CACHE_EXPR is the Ruleset-engine expression that
#     scopes the cache rule to the tenant hosts; it MUST exclude the control-plane
#     / apex host. Tenants stay isolated by Cloudflare's default Host-inclusive
#     cache key (no custom cache key is set; the custom Host key is Enterprise
#     only and redundant here).
#
#       CLOUDFLARE_API_TOKEN=... ACCOUNT_ID=... ZONE_ID=... MODE=multitenant \
#         CACHE_EXPR='(ends_with(http.host, ".skyphusionwp.dev"))' ./deploy/zone/apply.sh
#
#     The SaaS home zone is managed as ONE ruleset applied ONCE, not per tenant:
#     the entrypoint PUT REPLACES all rules, so a per-tenant apply would wipe the
#     other tenants. Run multitenant mode once for the whole zone.
#
# Both modes are idempotent (safe to re-run). It does NOT create DNS, enable APO,
# or touch anything else on the zone. Reverse it with destroy.sh. The token is
# read from the environment and passed to curl through a -K config on a pipe,
# never in argv (so it is not in `ps`).
#
# APO (Automatic Platform Optimization) is a separate, PAID, mostly-manual step;
# see README.md. This script applies the free, as-code Cache Rules path only.
set -euo pipefail

API="https://api.cloudflare.com/client/v4"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
MODE=${MODE:-dedicated}

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (needs Workers Routes Edit + Cache Rules/Zone Rulesets Edit)}"
ACCOUNT_ID=${ACCOUNT_ID:-${CLOUDFLARE_ACCOUNT_ID:-}}
: "${ACCOUNT_ID:?set ACCOUNT_ID (or CLOUDFLARE_ACCOUNT_ID)}"
: "${ZONE_ID:?set ZONE_ID (the zone that owns the hostname(s))}"

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

# Before ANY change (#282): refuse to overwrite a cache phase another root owns.
# shellcheck source=deploy/zone/owner-guard.sh
. "$SCRIPT_DIR/owner-guard.sh"
echo "== 0. Owner check of the cache phase (zone $ZONE_ID)"
guard_cache_phase

case "$MODE" in
  dedicated)
    : "${HOSTNAME:?set HOSTNAME (e.g. wp.example.com) in MODE=dedicated}"
    : "${WORKER_SERVICE:?set WORKER_SERVICE (the Worker script/service name to serve this host)}"
    [[ "$HOSTNAME" =~ ^[a-z0-9.-]+$ ]] || { echo "HOSTNAME must be a bare hostname, got $HOSTNAME" >&2; exit 2; }

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
    ;;
  multitenant)
    : "${CACHE_EXPR:?set CACHE_EXPR (the tenant-host match expression) in MODE=multitenant}"
    echo "== SaaS home zone: one zone-wide cache ruleset for all tenants (zone $ZONE_ID)"
    echo "   cache rule scope: $CACHE_EXPR"
    echo "   (no Custom Domain attach: the provisioning core attaches tenant hostnames)"
    # Substitute CACHE_EXPR into the multitenant template with python so an
    # expression containing quotes, slashes or ampersands cannot break the JSON.
    RULESET=$(CACHE_EXPR="$CACHE_EXPR" python3 -c '
import json, os, sys
tpl = json.load(open(os.path.join(sys.argv[1], "cache-ruleset.multitenant.json")))
for r in tpl.get("rules", []):
    if r.get("expression") == "@CACHE_EXPR@":
        r["expression"] = os.environ["CACHE_EXPR"]
json.dump(tpl, sys.stdout)' "$SCRIPT_DIR")
    echo "== Cache ruleset on the http_request_cache_settings phase entrypoint"
    ;;
  *)
    echo "MODE must be 'dedicated' or 'multitenant', got '$MODE'" >&2
    exit 2
    ;;
esac

# PUT the phase entrypoint REPLACES its rules, so re-running converges to exactly
# the template's rules (idempotent). The cache rule is first and the bypass rule
# is last on purpose: Cache Rules use last-match-wins for set_cache_settings, so
# the bypass (cache:false) overrides the cache rule for any dynamic/session
# request that matched both.
cf_ok "cache ruleset" PUT "/zones/$ZONE_ID/rulesets/phases/http_request_cache_settings/entrypoint" \
  --data "$RULESET" >/dev/null
echo "  ok (2 rules: cache anon HTML edge_ttl=3600 browser_ttl=0; then bypass dynamic/admin/session)"

echo
if [ "$MODE" = dedicated ]; then
  echo "Applied. Verify a cached anonymous page:"
  echo "  curl -sI https://$HOSTNAME/ | grep -iE 'cf-cache-status|age|cache-control'"
  echo "A growing Age header on repeat GETs = the ZONE edge is serving, the Worker is not invoked."
  echo "Reverse with: ZONE_ID=$ZONE_ID HOSTNAME=$HOSTNAME ACCOUNT_ID=$ACCOUNT_ID ./deploy/zone/destroy.sh"
else
  echo "Applied (one zone-wide ruleset). Verify a cached anonymous tenant page:"
  echo "  curl -sI https://<tenant-host>/ | grep -iE 'cf-cache-status|age|cache-control'"
  echo "Reverse the whole zone with: ZONE_ID=$ZONE_ID MODE=multitenant ./deploy/zone/destroy.sh"
fi
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
