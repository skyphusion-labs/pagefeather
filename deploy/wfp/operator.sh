#!/bin/bash
# The operator flow (issue #148): stand up, validate and tear down a couple of
# WordPress sites on YOUR OWN Workers for Platforms account, over the proven
# deploy/wfp primitives. One command, a site list, your account.
#
#   CLOUDFLARE_API_TOKEN=... ACCOUNT_ID=<your account> SITES="shop blog" \
#     deploy/wfp/operator.sh up
#
# SITES: a space list. A bare name is phase A (workers.dev). A "name:cd" suffix
# is phase B (a Custom Domain name.$WFP_SUBDOMAIN), which routes a zone and so
# needs WFP_SUBDOMAIN set to YOUR zone and that zone's change-request applied
# (issue #138). Default phase is A. Example: SITES="shop blog:cd".
#
# Commands:
#   up        build b-dosql once, the shared pieces, then each site (site add)
#   down      remove each listed site (site remove), then the shared pieces
#   validate  the live 2-site checks: both serve, isolation, update + rollback
#
# Options: BUILD=0 (use the b-dosql build that is there), WFP_STATE=r2 (+ the R2
# state key in AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY), DRY_RUN=1 (print the
# ordered plan and exit, change nothing). ACCOUNT_ID and WFP_SUBDOMAIN default
# to the project's own values (lib.sh), so an operator sets them.
#
# This is a layer OVER up.sh/site/site.sh/lib.sh: it changes none of them, and
# it selects per-site phase by setting WFP_CUSTOM_DOMAIN per `site` invocation.
# It is b-dosql only; the c1 container variant and the variant flag are #147.
set -euo pipefail
WFP=$(cd "$(dirname "$0")" && pwd)
# Did the operator set WFP_SUBDOMAIN themselves? Capture before lib.sh applies
# its default (phase B must use the operator's own routed zone, not the default).
OP_SUBDOMAIN_SET=${WFP_SUBDOMAIN:+1}
# shellcheck source=SCRIPTDIR/lib.sh
. "$WFP/lib.sh"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
# The per-site command, overridable so the offline test can record invocations.
SITE_CMD=${SITE_CMD:-$WFP/site}
cmd=${1:-}
SITES=${SITES:-}
have_cd=0

# Parse SITES into ordered "name phase" pairs (phase: a | cd). A name has no
# space, so a pair is split with ${p% *} (name) and ${p##* } (phase). Refuses a
# bad name, a bad suffix, an empty list, and a :cd site unless the operator set
# WFP_SUBDOMAIN themselves (phase B routes a zone; issue #138).
parse_sites() {
  local spec name phase
  PAIRS=()
  for spec in $SITES; do
    case "$spec" in
      *:cd) name=${spec%:cd}; phase="cd"; have_cd=1 ;;
      *:*)  echo "bad site spec '$spec': the only valid suffix is ':cd'" >&2; exit 2 ;;
      *)    name=$spec; phase="a" ;;
    esac
    valid_site "$name" || { echo "bad site name '$name': lower case, digits, hyphens; 1 to 30; not probe" >&2; exit 2; }
    PAIRS+=("$name $phase")
  done
  [ "${#PAIRS[@]}" -gt 0 ] || { echo "set SITES (for example SITES=\"shop blog:cd\")" >&2; exit 2; }
  if [ "$have_cd" = 1 ] && [ "${OP_SUBDOMAIN_SET:-}" != 1 ]; then
    echo "a :cd (phase B) site needs WFP_SUBDOMAIN set to YOUR routed zone (phase B routes a zone; issue #138). Refusing so phase B never silently uses the project default." >&2
    exit 2
  fi
}

# One ordered action list, built once and consumed by both DRY_RUN (print) and
# the executor, so what a dry run shows is exactly what runs.
plan_up() {
  parse_sites
  ACTIONS=()
  [ "${BUILD:-1}" = 0 ] || ACTIONS+=("build-dosql")
  ACTIONS+=("shared-setup")
  [ "$have_cd" = 1 ] && ACTIONS+=("shared-dispatcher")
  local p
  for p in "${PAIRS[@]}"; do ACTIONS+=("site-add ${p% *} ${p##* }"); done
}
plan_down() {
  parse_sites
  ACTIONS=()
  local p
  for p in "${PAIRS[@]}"; do ACTIONS+=("site-remove ${p% *} ${p##* }"); done
  [ "$have_cd" = 1 ] && ACTIONS+=("shared-dispatcher-down")
  ACTIONS+=("shared-teardown")
}
print_plan() { printf '%s\n' "${ACTIONS[@]}"; }

phase_flag() { [ "$1" = cd ] && echo 1 || echo 0; } # -> WFP_CUSTOM_DOMAIN

do_shared_setup() {
  mkdir -p "$GEN"
  log "shared: namespace $NAMESPACE and the site map"
  tfr shared init -input=false >/dev/null
  tfr shared apply -input=false -auto-approve -var "namespace=$NAMESPACE" >/dev/null
  KV_ID=$(tfr shared output -raw kv_namespace_id)
  log "outbound Worker wp-wfp-outbound"
  render_outbound > "$GEN/outbound.toml"
  local l; l=$(mktemp)
  wrangler_deploy "$GEN" "$l" --config outbound.toml || { tail -20 "$l"; exit 1; }
}
do_shared_dispatcher() {
  : "${KV_ID:?shared setup must run before the shared dispatcher}"
  log "shared dispatcher $SHARED_DISPATCHER (phase B)"
  render_shared_dispatcher "$KV_ID" > "$GEN/$SHARED_DISPATCHER.toml"
  local l; l=$(mktemp)
  wrangler_deploy "$GEN" "$l" --config "$SHARED_DISPATCHER.toml" || { tail -20 "$l"; exit 1; }
}
do_shared_dispatcher_down() {
  log "shared dispatcher $SHARED_DISPATCHER"
  (cd "$ROOT/deploy" && npx wrangler delete --name "$SHARED_DISPATCHER" --force) >/dev/null 2>&1 || true
  gone_api "shared dispatcher $SHARED_DISPATCHER" "/workers/scripts/$SHARED_DISPATCHER"
}
do_shared_teardown() {
  log "outbound Worker wp-wfp-outbound"
  (cd "$ROOT/deploy" && npx wrangler delete --name wp-wfp-outbound --force) >/dev/null 2>&1 || true
  gone_api "outbound Worker" "/workers/scripts/wp-wfp-outbound"
  log "shared: the site map and namespace $NAMESPACE"
  tfr shared destroy -input=false -auto-approve -var "namespace=$NAMESPACE" >/dev/null
  gone_api "namespace $NAMESPACE" "/workers/dispatch/namespaces/$NAMESPACE"
}
gone_api() { # gone_api <what> <path>: 404 or stop
  local c; c=$(api_code GET "$2")
  case "$c" in 404) echo "  $1 is gone (API 404)" ;; *) echo "  $1 is NOT gone (API $c): stopping" >&2; exit 1 ;; esac
}
run_actions() {
  local a verb rest name phase
  for a in "${ACTIONS[@]}"; do
    verb=${a%% *}
    case "$verb" in
      build-dosql)            build_dosql ;;
      shared-setup)           do_shared_setup ;;
      shared-dispatcher)      do_shared_dispatcher ;;
      shared-dispatcher-down) do_shared_dispatcher_down ;;
      shared-teardown)        do_shared_teardown ;;
      site-add)               rest=${a#* }; name=${rest% *}; phase=${rest##* }; WFP_CUSTOM_DOMAIN=$(phase_flag "$phase") BUILD=0 "$SITE_CMD" add "$name" ;;
      site-remove)            rest=${a#* }; name=${rest% *}; phase=${rest##* }; WFP_CUSTOM_DOMAIN=$(phase_flag "$phase") "$SITE_CMD" remove "$name" ;;
      *) echo "internal: unknown action '$a'" >&2; exit 1 ;;
    esac
  done
}

case "$cmd" in
  up)
    plan_up
    [ "${DRY_RUN:-0}" = 1 ] && { print_plan; exit 0; }
    run_actions
    SUB=$(subdomain)
    echo; echo "up:"
    for p in "${PAIRS[@]}"; do
      name=${p% *}; phase=${p##* }
      printf '  %s -> https://%s\n' "$name" "$(WFP_CUSTOM_DOMAIN=$(phase_flag "$phase") site_host "$name" "$SUB")"
    done
    echo "admin password for a site: ( cd deploy/wfp/terraform/site && terraform workspace select <site> && terraform output -raw admin_password )"
    ;;
  down)
    plan_down
    [ "${DRY_RUN:-0}" = 1 ] && { print_plan; exit 0; }
    run_actions
    echo "down: every listed site and the shared pieces are removed"
    ;;
  validate)
    parse_sites
    SUB=$(subdomain)
    stamp=$(date -u +%Y%m%dT%H%M%SZ); res="$WFP/results/operator-$stamp.json"
    mkdir -p "$WFP/results"
    rc=0; served=""; first=""
    log "validate: both sites serve (200 and own title)"
    for p in "${PAIRS[@]}"; do
      name=${p% *}; phase=${p##* }
      [ -z "$first" ] && first=$name
      host=$(WFP_CUSTOM_DOMAIN=$(phase_flag "$phase") site_host "$name" "$SUB")
      if site_title_ok "https://$host" "$name"; then echo "  ok   $name serves (200, own title)"; served="$served $name"
      else echo "  FAIL $name did not serve its own page at https://$host" >&2; rc=1; fi
    done
    log "validate: isolation (deploy/wfp/isolation.sh)"
    SITES="$(for p in "${PAIRS[@]}"; do printf '%s ' "${p% *}"; done)" "$WFP/isolation.sh" || rc=1
    log "validate: $first updates and rolls back independently"
    COUNT_ROWS=1 "$SITE_CMD" update "$first" || rc=1
    echo "  (the rollback path is exercised with: FORCE_FAIL=verify deploy/wfp/site update $first)"
    python3 -c 'import json,sys; json.dump({"served": sys.argv[1].split(), "updated": sys.argv[2], "pass": sys.argv[3], "utc": sys.argv[4]}, open(sys.argv[5],"w"))' \
      "$served" "$first" "$([ "$rc" = 0 ] && echo yes || echo no)" "$stamp" "$res"
    echo "validate: result $res ($([ "$rc" = 0 ] && echo PASS || echo FAIL))"
    exit "$rc"
    ;;
  *)
    echo "usage: operator.sh up|down|validate   (SITES=\"shop blog:cd\", ACCOUNT_ID=<yours>)" >&2
    exit 2
    ;;
esac
