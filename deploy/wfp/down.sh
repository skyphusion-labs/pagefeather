#!/bin/bash
# Remove the reference deployment (issue #35): each site (site.sh down), the
# probe, the outbound Worker, then the shared pieces. Each removal is checked
# against the API (404) before the next step, like deploy/destroy.sh.
#
#   CLOUDFLARE_API_TOKEN=... ./deploy/wfp/down.sh        # SITES as for up.sh
set -euo pipefail
. "$(dirname "$0")/lib.sh"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
SITES=${SITES:-one two}
for s in $SITES; do valid_site "$s" || { echo "bad site name: $s" >&2; exit 2; }; done
gone() {
  local c; c=$(api_code GET "$2")
  case "$c" in 404) echo "  $1 is gone (API 404)" ;; *) echo "  $1 is NOT gone (API $c): stopping" >&2; exit 1 ;; esac
}
tfr shared init -input=false >/dev/null
KV_ID=$(tfr shared output -raw kv_namespace_id)
SUB=$(subdomain)

for s in $SITES; do "$WFP/site.sh" down "$s"; done

log "probe wp-probe"
(cd "$ROOT/deploy" && npx wrangler delete --name wp-probe --force) > /dev/null 2>&1 || true
gone "dispatcher wp-probe" "/workers/scripts/wp-probe"
api DELETE "/storage/kv/namespaces/$KV_ID/values/wp-probe.$SUB.workers.dev" > /dev/null || true
gone "probe entry" "/storage/kv/namespaces/$KV_ID/values/wp-probe.$SUB.workers.dev"

log "outbound Worker wp-wfp-outbound"
(cd "$ROOT/deploy" && npx wrangler delete --name wp-wfp-outbound --force) > /dev/null 2>&1 || true
gone "outbound Worker" "/workers/scripts/wp-wfp-outbound"

log "shared: the site map and namespace $NAMESPACE"
tfr shared destroy -input=false -auto-approve -var "namespace=$NAMESPACE" >/dev/null
gone "namespace $NAMESPACE" "/workers/dispatch/namespaces/$NAMESPACE"
gone "site map $KV_ID" "/storage/kv/namespaces/$KV_ID"
rm -f "$GEN"/*.toml
echo "down: every name above is gone"
