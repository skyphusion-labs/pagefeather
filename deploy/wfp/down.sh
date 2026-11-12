#!/bin/bash
# Remove the reference deployment (issue #35): each site (site.sh down), the
# probe, the outbound Worker, then the shared pieces. Each removal is checked
# against the API (404) before the next step, like deploy/destroy.sh.
#
#   CLOUDFLARE_API_TOKEN=... ./deploy/wfp/down.sh
# SITES defaults to every site there is (deploy/wfp/site list: the Terraform
# workspaces), so the sites that site add and site remove left are removed too.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
need_account
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
SITES=${SITES-$(list_sites | tr '\n' ' ')}
echo "sites: ${SITES:-none}"
for s in $SITES; do valid_site "$s" || { echo "bad site name: $s" >&2; exit 2; }; done
gone() {
  local c; c=$(api_code GET "$2")
  case "$c" in 404) echo "  $1 is gone (API 404)" ;; *) echo "  $1 is NOT gone (API $c): stopping" >&2; exit 1 ;; esac
}
tfr shared init -input=false >/dev/null
KV_ID=$(tfr shared output -raw kv_namespace_id)
SUB=$(subdomain)

for s in $SITES; do "$WFP/site.sh" down "$s"; done

# Phase B (#138): the ONE shared dispatcher wp-dispatch, after every site is
# down, because each site.sh down has detached its Custom Domain first (the CR
# #138 remove order: the hostname before the entry, and the dispatcher last).
# Phase A never deploys it, so this runs only with the flag.
if [ "${WFP_CUSTOM_DOMAIN:-0}" = 1 ]; then
  log "shared dispatcher $SHARED_DISPATCHER (phase B)"
  (cd "$ROOT/deploy" && "$ROOT/deploy/wr" delete --name "$SHARED_DISPATCHER" --force) > /dev/null 2>&1 || true
  gone "shared dispatcher $SHARED_DISPATCHER" "/workers/scripts/$SHARED_DISPATCHER"
fi

log "probe wp-probe"
(cd "$ROOT/deploy" && "$ROOT/deploy/wr" delete --name wp-probe --force) > /dev/null 2>&1 || true
gone "dispatcher wp-probe" "/workers/scripts/wp-probe"
api DELETE "/storage/kv/namespaces/$KV_ID/values/wp-probe.$SUB.workers.dev" > /dev/null || true
gone "probe entry" "/storage/kv/namespaces/$KV_ID/values/wp-probe.$SUB.workers.dev"

log "cache probe (if any)"
for w in wp-cacheprobe wp-cacheprobe-direct; do
  (cd "$ROOT/deploy" && "$ROOT/deploy/wr" delete --name "$w" --force) > /dev/null 2>&1 || true
  gone "Worker $w" "/workers/scripts/$w"
done
api DELETE "/workers/dispatch/namespaces/$NAMESPACE/scripts/site-cacheprobe?force=true" > /dev/null || true
st=$(ns_script_state site-cacheprobe)
[ "$st" = gone ] || { echo "  site-cacheprobe is NOT known to be gone ($st): stopping" >&2; exit 1; }
echo "  site-cacheprobe is gone"
api DELETE "/storage/kv/namespaces/$KV_ID/values/wp-cacheprobe.$SUB.workers.dev" > /dev/null || true
gone "cache probe entry" "/storage/kv/namespaces/$KV_ID/values/wp-cacheprobe.$SUB.workers.dev"

log "outbound Worker wp-wfp-outbound"
(cd "$ROOT/deploy" && "$ROOT/deploy/wr" delete --name wp-wfp-outbound --force) > /dev/null 2>&1 || true
gone "outbound Worker" "/workers/scripts/wp-wfp-outbound"

log "shared: the site map and namespace $NAMESPACE"
tfr shared destroy -input=false -auto-approve -var "namespace=$NAMESPACE" >/dev/null
gone "namespace $NAMESPACE" "/workers/dispatch/namespaces/$NAMESPACE"
gone "site map $KV_ID" "/storage/kv/namespaces/$KV_ID"
rm -f "$GEN"/*.toml
echo "down: every name above is gone"
