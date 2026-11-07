#!/bin/bash
# Day one of the reference deployment (issue #35, slice 2): from an account
# with Workers for Platforms on, the shared pieces and two b-dosql sites, every
# resource from this directory (Terraform for the data, the Wrangler configs
# rendered from the templates here for the Workers).
#
#   CLOUDFLARE_API_TOKEN=... ./deploy/wfp/up.sh
#
# Options: SITES (default "one two"), BUILD=0 (use the b-dosql build that is
# there), WFP_STATE=r2 (Terraform state in the R2 state bucket; needs
# AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for it), CHECK=0 (skip check.py),
# CACHE_PROBE=0 (skip the Workers Cache probe).
# The token needs Workers Scripts, Workers KV, Workers for Platforms and R2
# edit, and API token edit (the teardown key in down.sh).
#
# Order: the namespace and the site map, the outbound Worker (the dispatchers
# bind it), then each site (site.sh up), then the stale-entry probe and
# check.py. Remove it all with down.sh.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
SITES=${SITES:-one two}
for s in $SITES; do valid_site "$s" || { echo "bad site name: $s" >&2; exit 2; }; done
umask 077
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
mkdir -p "$GEN"

[ "${BUILD:-1}" = 0 ] || build_dosql

log "shared: namespace $NAMESPACE and the site map"
tfr shared init -input=false >/dev/null
tfr shared apply -input=false -auto-approve -var "namespace=$NAMESPACE" >/dev/null
KV_ID=$(tfr shared output -raw kv_namespace_id)
SUB=$(subdomain)

log "outbound Worker wp-wfp-outbound"
render_outbound > "$GEN/outbound.toml"
wrangler_deploy "$GEN" "$W/outbound.log" --config outbound.toml || { tail -20 "$W/outbound.log"; exit 1; }

# Phase B (#138): the ONE shared dispatcher wp-dispatch, deployed once before
# any site, because each site's Custom Domain attaches to it (the service must
# exist at attach time). Phase A deploys a per-site dispatcher in site.sh
# instead, so this is skipped. Nothing here routes a zone; the Custom Domains
# are the CR #138 live-apply step.
if [ "${WFP_CUSTOM_DOMAIN:-0}" = 1 ]; then
  log "shared dispatcher $SHARED_DISPATCHER (phase B)"
  render_shared_dispatcher "$KV_ID" > "$GEN/$SHARED_DISPATCHER.toml"
  wrangler_deploy "$GEN" "$W/dispatch.log" --config "$SHARED_DISPATCHER.toml" || { tail -20 "$W/dispatch.log"; exit 1; }
fi

for s in $SITES; do "$WFP/site.sh" up "$s"; done

# The stale-entry probe (#35 condition b): a dispatcher copy whose entry names
# a script that is not in the namespace must answer 404 not-deployed. The entry
# is written before the hostname exists, as for a site.
log "probe wp-probe: an entry for a script that does not exist"
PROBE_HOST="wp-probe.$SUB.workers.dev"
c=$(api_code PUT "/storage/kv/namespaces/$KV_ID/values/$PROBE_HOST" -H 'content-type: text/plain' --data '{"script": "site-probe", "outbound": true}')
[ "$c" = 200 ] || { echo "the probe entry was not written (HTTP $c)" >&2; exit 1; }
render_dispatcher probe "$KV_ID" > "$GEN/wp-probe.toml"
wrangler_deploy "$GEN" "$W/probe.log" --config wp-probe.toml || { tail -20 "$W/probe.log"; exit 1; }

# The Workers Cache probe (docs/wfp.md open (b)): the same tiny cached Worker in
# the namespace (behind wp-cacheprobe) and as a normal Worker (the control).
if [ "${CACHE_PROBE:-1}" = 1 ]; then
  log "cache probe: site-cacheprobe in $NAMESPACE, behind wp-cacheprobe; control wp-cacheprobe-direct"
  render_cacheprobe site-cacheprobe false > "$GEN/site-cacheprobe.toml"
  (cd "$GEN" && npx wrangler deploy --config site-cacheprobe.toml --dispatch-namespace "$NAMESPACE") > "$W/cp1.log" 2>&1 || { tail -20 "$W/cp1.log"; exit 1; }
  c=$(api_code PUT "/storage/kv/namespaces/$KV_ID/values/wp-cacheprobe.$SUB.workers.dev" -H 'content-type: text/plain' --data '{"script": "site-cacheprobe", "outbound": true}')
  [ "$c" = 200 ] || { echo "the cache probe entry was not written (HTTP $c)" >&2; exit 1; }
  render_dispatcher cacheprobe "$KV_ID" > "$GEN/wp-cacheprobe.toml"
  wrangler_deploy "$GEN" "$W/cp2.log" --config wp-cacheprobe.toml || { tail -20 "$W/cp2.log"; exit 1; }
  render_cacheprobe wp-cacheprobe-direct true > "$GEN/wp-cacheprobe-direct.toml"
  wrangler_deploy "$GEN" "$W/cp3.log" --config wp-cacheprobe-direct.toml || { tail -20 "$W/cp3.log"; exit 1; }
fi

if [ "${CHECK:-1}" = 1 ]; then
  log "check.py"
  # The site secrets go to check.py in a file of this run (0600), not in argv.
  for s in $SITES; do
    (cd "$WFP/terraform/site" && terraform workspace select "$s" >/dev/null && terraform output -json) \
      | python3 -c 'import json, sys; o = {k: v["value"] for k, v in json.load(sys.stdin).items()}; print(json.dumps({"site": sys.argv[1], "admin_password": o["admin_password"], "spike_token": o["spike_token"]}))' "$s"
  done > "$W/sites.jsonl"
  (cd "$WFP/terraform/site" && terraform workspace select default >/dev/null)
  CACHE_PROBE=${CACHE_PROBE:-1} SUB=$SUB NAMESPACE=$NAMESPACE KV_ID=$KV_ID SITES_FILE="$W/sites.jsonl" WFP_CUSTOM_DOMAIN=${WFP_CUSTOM_DOMAIN:-0} WFP_SUBDOMAIN="$WFP_SUBDOMAIN" python3 -I "$WFP/check.py"
fi
echo
echo "up: $(for s in $SITES; do printf '%s ' "https://$(site_host "$s" "$SUB")"; done)"
