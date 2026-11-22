#!/bin/bash
# One site of the reference deployment (issue #35, deploy/wfp).
#   CLOUDFLARE_API_TOKEN=... deploy/wfp/site.sh up <name>
#   CLOUDFLARE_API_TOKEN=... deploy/wfp/site.sh down <name>
# up.sh and down.sh call it for each site; slice 3 makes it "site add/remove".
# The shared pieces (up.sh) must exist. b-dosql must be built (up.sh builds it).
#
# up, in the order of the #35 design (a KV entry must exist before its
# hostname is ever requested, or the "absent" answer is cached):
#   1. the site's Terraform workspace: media bucket, secrets, site map entry
#   2. the user Worker site-<name> in the namespace (b-dosql), with its secrets
#   3. the dispatcher copy wp-<name> on workers.dev: the site's hostname, and (#533) the daily
#      cron of its scheduled snapshot, with the site's SNAPSHOT_TOKEN
#   4. wait for the site, then install WordPress
# down, the other way round, each step checked against the API before the next:
#   1. the dispatcher copy (the hostname)   2. the user Worker
#   3. the bucket emptied, then the workspace destroyed (bucket, secrets, entry)
set -euo pipefail
. "$(dirname "$0")/lib.sh"
# shellcheck source=../install.sh
. "$ROOT/deploy/install.sh"  # install_wordpress: the one install check, shared with deploy.sh (#605, #811)
need_account
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
cmd=${1:-}; s=${2:-}
valid_site "$s" || { echo "usage: site.sh up|down <name> (lower case, digits, hyphens; 1 to 30; not probe, not auto)" >&2; exit 2; }
# #639, #693: full on a live site is refused before Terraform, the API, or the user Worker upload.
if [ "$cmd" = up ]; then obs_refuse_full "$s" || exit 2; dispatch_perf_log_var "$s" > /dev/null || exit 2; fi
# #736: FAULT_INJECT is refused before any step too (deploy/fault-inject.sh).
if [ "$cmd" = up ]; then fault_inject_var "$s" >/dev/null || exit 2; fi
# #764: conformance content is refused before any step too (deploy/conformance.sh).
if [ "$cmd" = up ]; then conformance_var "$s" || exit 2; fi
umask 077
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
mkdir -p "$GEN"
KV_ID=$(tfr shared output -raw kv_namespace_id)
SUB=$(subdomain)
D=$(dispatcher_name "$s"); U=$(user_script "$s")
HOST="$(site_host "$s" "$SUB")"; ORIGIN="https://$HOST" # phase A workers.dev, phase B the Custom Domain (lib.sh)
# Phase B (#138): true attaches this site's Custom Domain (terraform); false
# (the default) is phase A, workers.dev only.
CD=$([ "${WFP_CUSTOM_DOMAIN:-0}" = 1 ] && echo true || echo false)
VARS=(-var "name=$s" -var "hostname=$HOST" -var "kv_namespace_id=$KV_ID" -var "custom_domain=$CD")
# #1319: a NEW kind a site (site add made its Hyperdrive config first, SITE_HD_ID). An existing site's kind and
# Hyperdrive id come from its state instead (lib.sh site_vars, REC_VARS), on up and on down.
SITE_KIND=${SITE_KIND:-b-dosql}
if [ "$cmd" = up ] && [ "$SITE_KIND" = a ]; then
  [[ "${SITE_HD_ID:-}" =~ ^[0-9a-f]{32}$ ]] || { echo "site.sh up: a kind a site needs SITE_HD_ID (deploy/wfp/site add makes the config)" >&2; exit 2; }
  VARS+=(-var "kind=a" -var "hyperdrive_id=$SITE_HD_ID")
fi
# down: an existing site's workspace records its hostname, Custom Domain and
# zone (lib.sh site_vars); those win, so a remove of a site on its own apex
# detaches and deletes exactly what it has.
if [ "$cmd" = down ]; then
  tfr site init -input=false >/dev/null
  if tfr site workspace select "$s" >/dev/null 2>&1; then
    site_vars "$s" "$SUB" "$KV_ID" || exit 1
    HOST=$REC_HOST; ORIGIN="https://$HOST"; CD=$REC_CD; VARS=("${REC_VARS[@]}"); [ "$REC_KIND" != a ] || SITE_KIND=a
    [ "$CD" = true ] && WFP_CUSTOM_DOMAIN=1
    tfr site workspace select default >/dev/null
  fi
fi
# The id of the built bundle (build.sh writes build/build-id.js), recorded in
# the entry so "site update" has a rollback target (issue #35 slice 5). The
# config hash is recorded after the upload, once the rendered config and the
# secret key names exist (#421).
BUILD_ID=$(sed -n 's/export default "\(.*\)";/\1/p' "$APP/build/build-id.js" 2>/dev/null || true); BUILD_ID=${BUILD_ID:-unknown}
out() { tfr site output -raw "$1"; }
ws() { tfr site init -input=false >/dev/null && tfr site workspace select -or-create "$s" >/dev/null; }

if [ "$cmd" = up ]; then
  log "site $s: data plane and site map entry (workspace $s)"
  kv_wait_writable "$KV_ID"
  ws
  tfr site apply -input=false -auto-approve "${VARS[@]}" -var "build=$BUILD_ID" >/dev/null

  log "site $s: user Worker $U in $NAMESPACE"
  CONF="$APP/wrangler.deploy.wfp-$s.toml"
  purge_budget_decide "site $s" # #699 part B
  render_user "$s" "$ORIGIN" > "$CONF"
  tfr site output -json | site_secrets_json "$W/secrets.json"
  # WP_VECTORIZE_SEARCH (#330): the binding needs its index to exist at deploy.
  if search_on; then ensure_search_index "$s" || { rm -f "$W/secrets.json"; exit 1; }; fi
  # #569: a remote build is never uploaded without its ASSETS binding and /_pf/ first.
  remote_assets_check "$CONF" "$APP" || { rm -f "$W/secrets.json"; exit 2; }
  bundle_size_check || exit 1
  (cd "$APP" && "$ROOT/deploy/wr" deploy --config "$CONF" --dispatch-namespace "$NAMESPACE" --secrets-file "$W/secrets.json") > "$W/user.log" 2>&1 \
    || { rm -f "$W/secrets.json"; tail -20 "$W/user.log"; exit 1; }
  # #639: logs on (OBSERVABILITY 1 or full): redact the query strings now, before the dispatcher routes
  # the site, or turn the logs off and stop the add (fail closed, lib.sh obs_redact_site).
  obs_redact_site "$NAMESPACE" "$U" "$CONF" || { rm -f "$W/secrets.json"; echo "site $s: the user Worker is UPLOADED but not routed, and its query-string redaction did NOT read back, so its logs are now OFF (or could not be turned off: read the line above); the add stops" >&2; exit 1; }
  # The salts exist only after the workspace apply above, so the hash is a second
  # apply. It records the hash next to the build id. If this apply fails, the
  # entry has no hash and the next site update uploads once.
  CH=$(config_hash "$CONF" "$W/secrets.json") || { rm -f "$W/secrets.json"; exit 1; }
  rm -f "$W/secrets.json"
  tfr site apply -input=false -auto-approve "${VARS[@]}" -var "build=$BUILD_ID" -var "config_hash=$CH" >/dev/null
  grep -E 'Total Upload|Current Version' "$W/user.log" || true

  if [ "${WFP_CUSTOM_DOMAIN:-0}" = 1 ]; then
    log "site $s: phase B, routed by the shared $SHARED_DISPATCHER and this site's Custom Domain $HOST (attached by the workspace apply above)"
    log "site $s: its cron-only copy $D (no route, no workers.dev), for the scheduled snapshot (#533)"
    render_site_dispatcher "$s" "$KV_ID" cron-only > "$GEN/$D.toml" || exit 1
    tfr site output -json | dispatcher_secrets_json "$W/disp-secrets.json"
    wrangler_deploy "$GEN" "$W/disp.log" --config "$D.toml" --secrets-file "$W/disp-secrets.json" || { rm -f "$W/disp-secrets.json"; tail -20 "$W/disp.log"; exit 1; }
    rm -f "$W/disp-secrets.json"
    # #783: a retried wrangler deploy is not proof the script exists. Do not wait without it.
    dispatcher_script_present "$D" || exit 1
    obs_redact_site - "$D" "$GEN/$D.toml" || { echo "site $s: the cron-only copy $D is DEPLOYED, but its query-string redaction did NOT read back, so its logs are now OFF (or could not be turned off: check). Run site schedule $s to retry." >&2; exit 1; }
    cron_copy_check "$D" || exit 1
    echo "  $D: workers.dev and previews off, no Custom Domain (read back)"
  else
    if [ "$SITE_KIND" = a ]; then
      # #1319: no scheduled snapshot: /_dbsnapshot dumps a b-dosql site's own SQLite, and a kind a site's data is the
      # owner's MySQL (the owner backs it up). The empty list also clears a cron.
      log "site $s: dispatcher $D (kind a: no scheduled snapshot)"
      SNAPSHOT_CRON=off render_site_dispatcher "$s" "$KV_ID" > "$GEN/$D.toml" || exit 1
    else
    log "site $s: dispatcher $D, with the scheduled snapshot of this site (#533)"
    render_site_dispatcher "$s" "$KV_ID" > "$GEN/$D.toml" || exit 1
    fi
    tfr site output -json | dispatcher_secrets_json "$W/disp-secrets.json"
    wrangler_deploy "$GEN" "$W/disp.log" --config "$D.toml" --secrets-file "$W/disp-secrets.json" || { rm -f "$W/disp-secrets.json"; tail -20 "$W/disp.log"; exit 1; }
    rm -f "$W/disp-secrets.json"
    # #783: a retried wrangler deploy is not proof the script exists. Do not wait without it.
    dispatcher_script_present "$D" || exit 1
    grep -q "$ORIGIN" "$W/disp.log" || { echo "the dispatcher did not deploy to $ORIGIN:" >&2; tail -5 "$W/disp.log" >&2; exit 1; }
    # #767: logs on (OBSERVABILITY 1 or full): the dispatcher's query strings are redacted too, or its logs go off.
    obs_redact_site - "$D" "$GEN/$D.toml" || { echo "site $s: the dispatcher $D is DEPLOYED, but its query-string redaction did NOT read back, so its logs are now OFF (or could not be turned off: check). Run site schedule $s to retry." >&2; exit 1; }
  fi

  log "site $s: wait for $ORIGIN (the site itself, lib.sh wait_site), then install"
  wait_site "$ORIGIN"
  # #605: the SAME install check as deploy.sh (deploy/install.sh install_wordpress, #811), so the two cannot drift.
  # The one-read check here stopped a site add whose install had worked (an answer cut off in transit, TAG
  # 11162233) and passed an answer that said installed false. install_wordpress posts until the envelope's out
  # says installed true or "already" (a repeated /_install on an installed site answers "already"), retries 403,
  # 5xx, no answer and a body that is not one JSON value within INSTALL_WAIT_S, and fails at once on a JSON
  # answer that did not install. The secrets reach curl through -K, never argv; its messages never print them.
  if [ "${WOO_ACTIVE:-0}" = 1 ]; then
    log "site $s: install WordPress, then activate WooCommerce (deploy/install.sh; same as deploy.sh #661)"
  fi
  ( SPIKE_TOKEN=$(out spike_token); ADMIN_PASSWORD=$(out admin_password); export SPIKE_TOKEN ADMIN_PASSWORD
    install_wordpress "$ORIGIN" || exit 1
    if [ "${WOO_ACTIVE:-0}" = 1 ]; then
      activate_woocommerce "$ORIGIN" || exit 1
    fi
    # #1319: kind a's options versions table (#734), as deploy.sh installs it for variant a.
    if [ "$SITE_KIND" = a ] && [ "${OBJECT_CACHE_VERSIONS:-1}" != 0 ]; then
      ( . "$ROOT/deploy/a-settings.sh" && a_ocv_install "$ORIGIN" "$SPIKE_TOKEN" ) || exit 1
    fi ) || { echo "site $s: WordPress install or WooCommerce activation failed at $ORIGIN (deploy/install.sh); stopping" >&2; exit 1; }
  echo "site $s: up at $ORIGIN"
elif [ "$cmd" = down ]; then
  if [ "${WFP_CUSTOM_DOMAIN:-0}" = 1 ]; then
    log "site $s: phase B, detach the Custom Domain $HOST first (CR #138 remove order: the hostname before the entry)"
    tfr site init -input=false >/dev/null
    if tfr site workspace select "$s" >/dev/null 2>&1; then
      tfr site destroy -input=false -auto-approve "${VARS[@]}" -target=cloudflare_workers_custom_domain.site >/dev/null || true
    fi
    log "site $s: its cron-only copy $D (#533)"
    case "$(api_code GET "/workers/scripts/$D")" in
      200) (cd "$ROOT/deploy" && "$ROOT/deploy/wr" delete --name "$D" --force) > "$W/del.log" 2>&1 || tail -5 "$W/del.log"
           gone "cron-only copy $D" "/workers/scripts/$D" ;;
      404) echo "  no cron-only copy $D (a phase B site made before #533 has none)" ;;
      *) echo "  the cron-only copy $D cannot be read: stopping" >&2; exit 1 ;;
    esac
  else
    log "site $s: dispatcher $D (the hostname first)"
    (cd "$ROOT/deploy" && "$ROOT/deploy/wr" delete --name "$D" --force) > "$W/del.log" 2>&1 || tail -5 "$W/del.log"
    gone "dispatcher $D" "/workers/scripts/$D"
  fi

  log "site $s: user Worker $U"
  api DELETE "/workers/dispatch/namespaces/$NAMESPACE/scripts/$U?force=true" > /dev/null || true
  # Not by the single GET's status (a deleted script can read 200 there): lib.sh ns_script_state, polled (#789).
  ns_gone "user Worker $U" "$U"

  log "site $s: search index (after the user Worker that binds it)"
  remove_search_index "$s" || exit 1

  log "site $s: media bucket emptied, then the workspace destroyed"
  # A down never creates: no workspace means no data plane to remove.
  tfr site init -input=false >/dev/null
  if tfr site workspace select "$s" >/dev/null 2>&1; then
    # Empty the bucket with a temporary credential that can reach only that
    # bucket (lib.sh down_empty_bucket, #273).
    down_empty_bucket "$s"
    tfr site destroy -input=false -auto-approve "${VARS[@]}" >/dev/null
    tfr site workspace select default >/dev/null && tfr site workspace delete "$s" >/dev/null
  else
    echo "  no workspace $s: no data plane to remove (checked below)"
  fi
  gone "site map entry $HOST" "/storage/kv/namespaces/$KV_ID/values/$HOST"
  gone "bucket $(media_bucket "$s")" "/r2/buckets/$(media_bucket "$s")"
  # #1319: a kind a site's Hyperdrive config, after the user Worker that binds it and the workspace (by its name, so a
  # config left by a failed add goes too). Its object cache namespace went with the workspace; read back by its title.
  if [ "$SITE_KIND" = a ]; then
    log "site $s: Hyperdrive config $(hd_name "$s") and object cache namespace $(oc_kv_title "$s")"
    hd_delete "$s" || exit 1
    case "$(oc_kv_state "$s")" in
      no) echo "  object cache namespace $(oc_kv_title "$s"): none (read back)" ;;
      *) echo "  object cache namespace $(oc_kv_title "$s") is NOT known to be gone: stopping" >&2; exit 1 ;;
    esac
  fi
  rm -f "$APP/wrangler.deploy.wfp-$s.toml" "$GEN/$D.toml"
  echo "site $s: down"
else
  echo "usage: site.sh up|down <name>" >&2; exit 2
fi
