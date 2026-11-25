#!/bin/bash
# Deploy one WordPress site on Cloudflare, then measure it.
#
#   CLOUDFLARE_API_TOKEN=... ACCOUNT_ID=... NAME=my-site ./deploy/deploy.sh
#
# VARIANT (default b-do):
#   b-do    PHP in a Durable Object, database on D1 (Workers Free or Paid)
#   b-dosql PHP in a Durable Object, database in the same object (its SQLite);
#           no network per query, no D1 (Workers Free or Paid)
#   a     PHP in the Worker, MySQL through Hyperdrive (Workers Paid). MySQL is
#         MYSQL=vultr (deploy/mysql makes a box; needs VULTR_API_KEY, MYSQL_ZONE_ID,
#         MYSQL_HOST) or MYSQL=external (MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD,
#         MYSQL_DATABASE; a public server must have SSL, or set
#         MYSQL_ACCESS_CLIENT_ID and MYSQL_ACCESS_CLIENT_SECRET for a
#         Cloudflare Tunnel origin behind Access, CR #141)
#   c1    WordPress and WooCommerce in one Container, SQLite and Litestream to
#         R2 (Workers Paid). Steps in deploy/variants/c1.sh; options
#         INSTANCE_TYPE, PHP_WORKERS, IDLE_SECONDS (see README.md)
# Optional: LOCATION (default enam), MEDIA=1 (R2 media library; R2 must be on),
# WOO_ACTIVE=1 (activate WooCommerce after the install; c1 always has it
# active, so set it on b-do, b-dosql and a to compare like with like),
# HYPERDRIVE_SQL_MODE (variant a on a strict MySQL such as PlanetScale: the
# sql_mode each statement carries, e.g.
# ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION; see
# spikes/b2-wordpress/php/hyperdrive-sql-mode.php. Unset: no change),
# WOO_EXTRAS=off (every variant's Worker config): the b2 mu-plugin forces
# WooCommerce order attribution, usage tracking, marketplace suggestions and
# remote logging off. Unset leaves WooCommerce's defaults. Analytics stays on.
# b-dosql through deploy/wfp records it (site_settings.py). A value other than
# off is refused before any step.
# SITE_TITLE (#1098): the blog title a new install stores. Unset means the site
# name (SITE_NAME, this deploy's name), or the hostname when there is no name.
# Never a product name. Empty, longer than 200 characters, or a control
# character is refused before any step. An installed site keeps the title its
# owner set in WordPress.
# PAGE_CACHE_PRODUCT_TTL (b-do, b-dosql and a, #706): seconds a WooCommerce
# product, shop or category page stays fresh. A store (WOO_ACTIVE=1) renders 30
# when this is unset. A site that is not a store renders nothing, so those pages
# keep 120 s. Set an integer from 5 to 600 to override. Any other value, or a
# WOO_ACTIVE other than 0 or 1, is refused before any step. The line comes from
# deploy/provision/wp-site-config.mjs, the same function the one-click paths use.
# BENCH=0 (skip the measurements), N (runs per page, default 10), PORT (local
# wrangler dev port for the OPcache step; unset picks a free port, #1124;
# OPCACHE_A_PORT pins that port for opcache-a.sh and wins over PORT), DEPLOY_STATE=r2 (keep
# Terraform state in an R2 bucket; see README.md).
# INSTALL_WAIT_S (default 120, at most 600; #811): how long to retry /_install while
# the answer is 403, 5xx, no answer, or not JSON. INSTALL_INTERVAL_S (default 5) is
# the pause. A JSON answer that is not installed fails the deploy.
# Variant a renders the measured site by default (#666, deploy/README.md): the lean client (A_CLIENT), the
# object cache with its L2 KV and lazy nodes; PHP_OVERFLOW=1 adds the overflow pool (PHP_OVERFLOW_POOL, default 32);
# PHP_OVERFLOW=always (#714, a measurement arm) moves every eligible request to it.
# Variant a, the #394 admin fixes (deploy/a-settings.sh): OPCACHE_A=1 primes
# OPcache on the D1 build with no Docker (opcache-a.sh; an empty cache fails), OPCACHE_REMOTE=1 and
# SITE_REMOTE=1 move the bundle's zips to packs under /_pf/ (#563, #569; on variant a they need OPCACHE_A=1). All three
# are ON by default on variant a (#1020) and both packs on b-dosql (#598); 0 opts out (deploy/lib/remote-packs.sh). RECYCLE_WASM_MIB sets the
# runtime recycle line (#602; the engine's own default when unset: 140 lean, 100 npm, #771). Every variant: the PHP
# engine is the pinned LEAN engine by default (#771, spikes/b2-wordpress/engine.lock, fetched by hash);
# PHP_ENGINE=npm builds the @php-wasm/web-8-3 package engine; PF_ENGINE_JS and PF_ENGINE_WASM build with other
# engine files (both or neither).
# OBSERVABILITY (variants b-do, b-dosql and a; deploy/observability.sh): Workers Logs, off unless set.
# 0 an explicit off, 1 events only, full the invocation logs too (a throwaway only). With 1 or full the
# query strings are redacted right after the upload and read back; if not, the logs go off and the
# deploy fails (fail closed).
# AI=1 (Workers AI auto alt text for uploaded images with no alt text; needs
# MEDIA=1 and the b-dosql/b-do variant. AI_ALT=off disables it, AI_ALT_MODEL picks
# the image-to-text model, AI_ALT_INPUT=prompt selects an llava/llama-style model).
#
# Steps: Terraform makes the data plane -> build -> Wrangler config from the
# Terraform outputs -> deploy (secrets in that version) -> redact logs when they
# are on -> read the serving version -> install -> measure -> deploy/results/.
#
# CODE_ONLY=1 (fleet-chezmoi#2620): redeploy the code of a site that already exists, from any clone,
# with no Terraform state. b-dosql only (its config needs one Terraform output, the media bucket,
# which MEDIA_BUCKET gives instead). SITE_ORIGIN must be set, so links stay on the live origin.
# Skipped: Terraform, the secrets (WP_SALT and SPIKE_TOKEN persist across deploys), the install
# (it ran once) and the measurements. DRY_RUN=1 with it builds and renders, then runs
# `wrangler deploy --dry-run` and deploys nothing. .github/workflows/deploy-workers.yml runs it for
# the sites in deploy/live-sites/.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TF="$ROOT/deploy/terraform"
APP="$ROOT/spikes/b2-wordpress"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}" "${ACCOUNT_ID:?set ACCOUNT_ID}" "${NAME:?set NAME}"
export CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID
# #1262: CUSTOM_DOMAIN (opt-in) is checked here, before any step: a hostname in a zone on this account, never
# *.workers.dev. It sets SITE_ORIGIN to https://<host> for every later step; a different explicit SITE_ORIGIN is refused.
# shellcheck source=lib/custom-domain.sh
. "$ROOT/deploy/lib/custom-domain.sh"
custom_domain_prepare || exit 2
# #1258: the WP-CLI operator route. Off unless WP_CLI_ENDPOINT=on, which needs the
# custom domain above and the wp-admin Access AUD (#1260). Checked before any step.
# shellcheck source=lib/wp-cli-endpoint.sh
. "$ROOT/deploy/lib/wp-cli-endpoint.sh"
wp_cli_endpoint_check || exit 2
VARIANT=${VARIANT:-b-do}
LOCATION=${LOCATION:-enam}
MEDIA=${MEDIA:-0}
AI=${AI:-0}
export WOO_ACTIVE=${WOO_ACTIVE:-0}
log() { printf '\n== %s\n' "$*"; }
case "$VARIANT" in b-do|b-dosql|a|c1) ;; *) echo "VARIANT must be b-do, b-dosql, a or c1"; exit 2 ;; esac
CODE_ONLY=${CODE_ONLY:-0}
DRY_RUN=${DRY_RUN:-0}
if [ "$CODE_ONLY" = 1 ]; then
  [ "$VARIANT" = b-dosql ] || { echo "CODE_ONLY=1 is for VARIANT=b-dosql only (other variants read more Terraform outputs)" >&2; exit 2; }
  [ -n "${SITE_ORIGIN:-}" ] || { echo "CODE_ONLY=1 needs SITE_ORIGIN, the live site's origin" >&2; exit 2; }
  if [ "$MEDIA" = 1 ]; then
    [[ "${MEDIA_BUCKET:-}" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || { echo "CODE_ONLY=1 with MEDIA=1 needs MEDIA_BUCKET, the live media bucket" >&2; exit 2; }
  fi
elif [ "$DRY_RUN" = 1 ]; then
  echo "DRY_RUN=1 is for CODE_ONLY=1 only" >&2; exit 2
fi
if [ -n "${HYPERDRIVE_SQL_MODE+x}" ]; then
  [ "$VARIANT" = a ] || { echo "HYPERDRIVE_SQL_MODE is for variant a only" >&2; exit 2; }
  [[ "$HYPERDRIVE_SQL_MODE" =~ ^[A-Za-z_,]*$ ]] || { echo "HYPERDRIVE_SQL_MODE: mode names and commas only" >&2; exit 2; }
fi
# The #394 admin fixes for variant a, and the engine pair (deploy/a-settings.sh): checked here,
# before any Terraform, build or deploy step.
# shellcheck source=SCRIPTDIR/a-settings.sh
. "$ROOT/deploy/a-settings.sh"
a_settings_check "$VARIANT" || exit 2
# #598: b-dosql renders the remote packs by default, as deploy/wfp does (deploy/lib/remote-packs.sh): unset is on,
# OPCACHE_REMOTE=0 opts out. Here, before the build and the render, so both read the same values (the guard below
# refuses a disagreement). #598's live run: 14 of 40 post-new.php lost to memory resets without them, 0 of 40 with.
[ "$VARIANT" != b-dosql ] || remote_pack_defaults
# #1020: variant a too (a_remote_pack_defaults: the packs and the OPCACHE_A priming they follow). cf759hl: 9 of 10
# /wp-json/ exceededMemory and a fresh runtime per request without them; 10 of 10 at 105 MiB, isolates reused, with.
[ "$VARIANT" != a ] || a_remote_pack_defaults
# REQUEST_FRAMES (#352, #589 part 1): on by default for b-dosql (render-conf.sh), off the escape hatch. Only
# b-dosql has the object-SQLite undo log, so the var on another variant is refused, before any step.
case "${REQUEST_FRAMES:-}" in
  ""|on|off) ;;
  *) echo "REQUEST_FRAMES must be on, off or unset, not ${REQUEST_FRAMES}" >&2; exit 2 ;;
esac
if [ -n "${REQUEST_FRAMES:-}" ] && [ "${VARIANT:-}" != b-dosql ]; then echo "REQUEST_FRAMES is for variant b-dosql (the object-SQLite undo log), not ${VARIANT:-unset}" >&2; exit 2; fi
# MAIL_ALLOWED_TO (#1056): the send_email destination allowlist; a bad list, or one with no sender, is refused
# before any step (spikes/b2-wordpress/mail-from.mjs). c1 checks its own (variants/c1-config.sh).
if [ -n "${MAIL_ALLOWED_TO:-}" ] && [ "$VARIANT" != c1 ]; then
  SITE_ORIGIN="${SITE_ORIGIN:-}" MAIL_FROM="${MAIL_FROM:-}" MAIL_ALLOWED_TO="$MAIL_ALLOWED_TO" node "$APP/mail-from.mjs" --binding > /dev/null || exit 2
fi
# SITE_TITLE (#1098): checked before Terraform records this run's inputs. The same
# rule as render-conf.sh. Unset is the site name, written there as SITE_NAME.
if [ -n "${SITE_TITLE:-}" ]; then
  SITE_TITLE="$SITE_TITLE" node "$APP/install-title.mjs" --toml > /dev/null || exit 2
fi
# WOO_EXTRAS (#667): off or unset, every variant, before any Terraform or build step.
# The same rule as deploy/wfp/lib.sh woo_extras_var. Unset writes no [vars] line.
case "${WOO_EXTRAS:-}" in
  "") ;;
  off) ;;
  *) echo "WOO_EXTRAS must be off or unset, not ${WOO_EXTRAS}" >&2; exit 2 ;;
esac
# OBJECT_CALL_DEADLINE_S, OBJECT_START_BY_S (#703, #708): checked before any step; render_conf renders them.
# shellcheck source=SCRIPTDIR/object-time.sh
. "$ROOT/deploy/object-time.sh"
# shellcheck source=SCRIPTDIR/deploy-url.sh
. "$ROOT/deploy/deploy-url.sh"
# FAULT_INJECT (#730): the post-INSERT fault injector, a throwaway-only measurement. One rule with deploy/wfp.
# shellcheck source=SCRIPTDIR/fault-inject.sh
. "$ROOT/deploy/fault-inject.sh"
fault_check "$VARIANT" "${NAME:-}" || exit 2
# PAGE_CACHE_TTL (#759): the edge page cache seconds on b-dosql (0 = off); checked before any step.
# shellcheck source=SCRIPTDIR/page-cache-ttl.sh
. "$ROOT/deploy/page-cache-ttl.sh"
page_cache_ttl_check "$VARIANT" || exit 2
# #764: the conformance content (#759: it wipes the store) is for a throwaway only. One rule with deploy/wfp.
# shellcheck source=SCRIPTDIR/conformance.sh
. "$ROOT/deploy/conformance.sh"
conformance_check "${NAME:-}" || exit 2
# PDF_INVOICE (#765): PDF order invoices, b-dosql only, the same switch as deploy/wfp and one-click.
# shellcheck source=SCRIPTDIR/pdf-invoice.sh
. "$ROOT/deploy/pdf-invoice.sh"
pdf_invoice_check "$VARIANT" || exit 2
# #811: /_install retries while the PHP object is still on the previous version.
# shellcheck source=SCRIPTDIR/install.sh
. "$ROOT/deploy/install.sh"
# shellcheck source=SCRIPTDIR/deploy-upload.sh
. "$ROOT/deploy/deploy-upload.sh"
object_time_vars >/dev/null || exit 2
# WOO_ACTIVE is 0 or 1 (#706). Unset was set to 0 above. Anything else is refused
# before any step, the same as deploy/wfp woo_active_for_build.
case "$WOO_ACTIVE" in
  0|1) ;;
  *) echo "WOO_ACTIVE must be 0 or 1, not ${WOO_ACTIVE}" >&2; exit 2 ;;
esac
# PAGE_CACHE_PRODUCT_TTL (#706): unset, or an integer from 5 to 600. The rendered
# line is render-conf.sh (a store gets 30 when this is unset). A bad value is
# refused here, before Terraform, the build or a deploy. The same bounds as
# pageCacheProductTtl; this copy exists so the refusal does not call node (the
# refusal tests stub node).
if [ -n "${PAGE_CACHE_PRODUCT_TTL:-}" ]; then
  page_cache_ttl=$PAGE_CACHE_PRODUCT_TTL
  if ! [[ "$page_cache_ttl" =~ ^[0-9]{1,3}$ ]] || [ "$((10#$page_cache_ttl))" -lt 5 ] || [ "$((10#$page_cache_ttl))" -gt 600 ]; then
    echo "PAGE_CACHE_PRODUCT_TTL must be an integer from 5 to 600, not ${page_cache_ttl}" >&2
    exit 2
  fi
fi
# shellcheck source=SCRIPTDIR/observability.sh
. "$ROOT/deploy/observability.sh"
obs_check "$VARIANT" || exit 2
# #1054: PLACEMENT (variant a's [placement]): checked after the other checks (each refuses first, as its tests pin) and before any step (render-conf.sh placement_check).
if [ "$VARIANT" = a ]; then
  # shellcheck source=SCRIPTDIR/render-conf.sh
  ( . "$ROOT/deploy/render-conf.sh"; placement_check ) || exit 2
elif [ -n "${PLACEMENT:-}" ]; then
  echo "PLACEMENT is for variant a only" >&2; exit 2
fi
# #771: the PHP engine, resolved ONCE here and exported (spikes/b2-wordpress/engine.sh): prepare.sh, build.sh and
# everything after see the same pair. The default is the pinned lean engine for every variant, including a
# (#1027 lifted the #788 hold that forced npm here). PHP_ENGINE=npm, or PF_ENGINE_JS and
# PF_ENGINE_WASM, choose another. After every other check (each refuses first, as
# its tests pin), and before any Terraform, build or deploy step: a fetch that fails leaves nothing half-applied.
# shellcheck source=../spikes/b2-wordpress/engine.sh
. "$ROOT/spikes/b2-wordpress/engine.sh"
engine_resolve || exit 2

# Terraform state: local by default; DEPLOY_STATE=r2 writes a backend override
# for the root in $1 (deploy/terraform or deploy/mysql). backend() is in tf-backend.sh.
# shellcheck source=SCRIPTDIR/tf-backend.sh
. "$ROOT/deploy/tf-backend.sh"
# One workspace (one state) per site: a second NAME never touches the first.
tf() { local dir=$1; shift; (cd "$dir" && terraform workspace select -or-create "$NAME" >/dev/null && terraform "$@"); }
out() { tf "$TF" output -raw "$1"; }

if [ "$CODE_ONLY" != 1 ]; then
# 1a. Variant a with MYSQL=vultr: the database box, its own Terraform root.
if [ "$VARIANT" = a ]; then
  if [ "${MYSQL:-external}" = vultr ]; then
    : "${VULTR_API_KEY:?set VULTR_API_KEY}" "${MYSQL_ZONE_ID:?set MYSQL_ZONE_ID}" "${MYSQL_HOST:?set MYSQL_HOST}"
    log "terraform: MySQL box for $NAME ($MYSQL_HOST)"
    M="$ROOT/deploy/mysql"; backend "$M"; mkdir -p "$M/sites"
    printf 'name = "%s"\nzone_id = "%s"\nhostname = "%s"\n' "$NAME" "$MYSQL_ZONE_ID" "$MYSQL_HOST" > "$M/sites/$NAME.tfvars"
    (cd "$M" && terraform init -input=false -reconfigure >/dev/null)
    tf "$M" apply -input=false -auto-approve -var-file="sites/$NAME.tfvars" >/dev/null
    MYSQL_USER=$(tf "$M" output -raw user); MYSQL_DATABASE=$(tf "$M" output -raw database)
    MYSQL_PASSWORD=$(tf "$M" output -raw password)
  fi
  : "${MYSQL_HOST:?set MYSQL_HOST}" "${MYSQL_PASSWORD:?set MYSQL_PASSWORD}"
  MYSQL_USER=${MYSQL_USER:-wp}; MYSQL_DATABASE=${MYSQL_DATABASE:-wordpress}
  export TF_VAR_mysql_password=$MYSQL_PASSWORD
  # Access-tunnel origin (CR #141): Hyperdrive reaches the box through its
  # Cloudflare Tunnel behind Access, so no inbound port and no SSL is needed.
  if [ -n "${MYSQL_ACCESS_CLIENT_ID:-}${MYSQL_ACCESS_CLIENT_SECRET:-}" ]; then
    : "${MYSQL_ACCESS_CLIENT_ID:?set MYSQL_ACCESS_CLIENT_ID}" "${MYSQL_ACCESS_CLIENT_SECRET:?set MYSQL_ACCESS_CLIENT_SECRET}"
    export TF_VAR_mysql_access_client_id=$MYSQL_ACCESS_CLIENT_ID
    export TF_VAR_mysql_access_client_secret=$MYSQL_ACCESS_CLIENT_SECRET
  fi
fi

# 1b. Data plane.
# shellcheck source=lib/recorded-inputs.sh
. "$ROOT/deploy/lib/recorded-inputs.sh"
# shellcheck source=lib/cron-version.sh
. "$ROOT/deploy/lib/cron-version.sh"
log "terraform: $VARIANT data plane for $NAME ($LOCATION)"
backend "$TF"; mkdir -p "$TF/sites"
(cd "$TF" && terraform init -input=false -reconfigure >/dev/null)
# #1428: the data-plane apply keeps the inputs already recorded. this_inputs is the value inputs_check
# compares (before the build, and before SITE_ORIGIN is derived). It is written only after the upload.
if ! kept=$(recorded_deploy_inputs "$TF" "$NAME"); then
  inputs_check "$TF" "$NAME" || exit 2
  exit 2
fi
this_inputs=$(deploy_inputs_value)
{
  echo "account_id = \"$ACCOUNT_ID\""
  echo "name       = \"$NAME\""
  echo "variant    = \"$VARIANT\""
  echo "location   = \"$LOCATION\""
  echo "media      = $([ "$MEDIA" = 1 ] && echo true || echo false)"
  # #1108: the recorded inputs, kept until the upload succeeds (record_deploy_inputs, #1428).
  echo "deploy_inputs  = \"${kept}\""
  if [ "$VARIANT" = a ]; then
    echo "mysql_host     = \"$MYSQL_HOST\""
    echo "mysql_user     = \"$MYSQL_USER\""
    echo "mysql_database = \"$MYSQL_DATABASE\""
  fi
} > "$TF/sites/$NAME.tfvars"
# #1108: never delete an existing media bucket by default (deploy/lib/media-guard.sh). DESTROY_MEDIA=1 does it on purpose.
# #1108: a rebuild whose inputs differ from the recorded ones is refused (REPLACE_INPUTS=1 replaces them on purpose).
# This stays before any build. A failure here changes nothing in state.
inputs_check "$TF" "$NAME" || exit 2
# shellcheck source=lib/media-guard.sh
. "$ROOT/deploy/lib/media-guard.sh"
media_guard "$TF" "$NAME" "sites/$NAME.tfvars" || exit 2
# Hyperdrive checks the database when it makes its config, and a new MySQL box
# needs a few minutes (packages, MariaDB, SSL): retry for up to 10 minutes.
for try in $(seq 1 20); do
  tf "$TF" apply -input=false -auto-approve -var-file="sites/$NAME.tfvars" > "$TF/sites/$NAME.apply.log" 2>&1 && break
  [ "$VARIANT" = a ] && [ "$try" -lt 20 ] || { tail -20 "$TF/sites/$NAME.apply.log"; exit 1; }
  echo "  database not ready yet (try $try); waiting 30 s"; sleep 30
done
BUCKET=$(out media_bucket)
else
  log "code only: no Terraform for $NAME; media bucket ${MEDIA_BUCKET:-none}"
  BUCKET=$([ "$MEDIA" = 1 ] && echo "$MEDIA_BUCKET" || true)
fi
# Cron readback below runs for CODE_ONLY too. Source outside the Terraform branch.
# shellcheck source=lib/cron-schedules.sh
. "$ROOT/deploy/lib/cron-schedules.sh"
# record_deploy_inputs <base64>: write this run's inputs into the site's state. Only after the upload
# (c1: after its deploy) has succeeded. The data-plane apply above kept the previous record, so a failure
# at fetch, or anywhere before the upload, leaves that record byte for byte (#1428). The value is the one
# inputs_check compared, not a fresh read: the build may set SITE_ORIGIN after the check.
record_deploy_inputs() {
  local val=$1 file="$TF/sites/$NAME.tfvars" tmp
  tmp=$(mktemp "${TMPDIR:-/tmp}/deploy-inputs.XXXXXX")
  awk -v v="$val" 'BEGIN { done = 0 }
    /^deploy_inputs  = / { print "deploy_inputs  = \"" v "\""; done = 1; next }
    { print }
    END { if (!done) print "deploy_inputs  = \"" v "\"" }' "$file" > "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$file" || return 1
  tf "$TF" apply -input=false -auto-approve -var-file="sites/$NAME.tfvars" >> "$TF/sites/$NAME.apply.log" 2>&1 || {
    echo "deployed, but the inputs were NOT recorded (#1428). The site's record is unchanged. Run the deploy again with the same inputs." >&2
    return 1
  }
  echo "inputs recorded"
}
# Variant c1 (Container) has its own build, deploy and measure steps.
if [ "$VARIANT" = c1 ]; then
  . "$ROOT/deploy/variants/c1.sh"
  c1_main
  record_deploy_inputs "$this_inputs" || exit 1
  exit 0
fi

# 2. Build: PHP WebAssembly, WordPress, precompiled OPcache (local wrangler dev).
# opcache.sh's whole output goes to build/opcache.log. On a failure the last
# lines are printed: "| tail -1" hid an e2e.sh failure behind a passing row (#50).
opcache() {
  ./opcache.sh > build/opcache.log 2>&1 || { echo "opcache.sh failed; last lines of build/opcache.log:"; tail -25 build/opcache.log; return 1; }
  tail -1 build/opcache.log
}
log "build"
cd "$APP"
[ -d node_modules ] || npm ci --silent
# Every build regenerates the loader (#394, #446): a stale vendor/ never picks up a new patch.
# No pipe: a pipe would hide a failed patch assert and ship the old loader.
./prepare.sh || { echo "prepare.sh failed: the loader was not rebuilt"; exit 1; }
echo "engine: $PHP_ENGINE_RESOLVED (${PF_ENGINE_WASM:-the pinned @php-wasm/web-8-3}), recycle line $(engine_recycle_mib) MiB unless RECYCLE_WASM_MIB"
if [ "$VARIANT" = b-do ] || [ "$VARIANT" = b-dosql ]; then
  # No pipe (#464): a pipe takes tail's status, so a failed build.sh went on with a half-built tree.
  BLOG=$(mktemp)
  ./build.sh > "$BLOG" || { echo "build.sh failed:"; tail -25 "$BLOG"; rm -f "$BLOG"; exit 1; }
  tail -1 "$BLOG"; rm -f "$BLOG"
  DEV_ENV=$([ "$VARIANT" = b-dosql ] && echo dosql-local || echo do-local) opcache || exit 1
  # #598: the pack step deploy/wfp's build_dosql runs (deploy/lib/remote-packs.sh). Nothing with OPCACHE_REMOTE=0.
  [ "$VARIANT" != b-dosql ] || remote_pack_build "$WOO_ACTIVE" || exit 1
elif [ "${OPCACHE_A:-0}" = 1 ]; then
  # #1319: the one primed approach A build, shared with deploy/wfp kind a (a-settings.sh a_build_primed).
  a_build_primed || exit 1
else
  ENGINE=a ./build.sh | tail -1
  # OPcache is primed against a temporary local MariaDB (env a-local); without
  # Docker the site runs, but every new isolate compiles PHP first (OPCACHE_A=1 primes without it).
  if docker info >/dev/null 2>&1; then
    LP=$(openssl rand -hex 16); C="deploy-prime-$NAME"
    docker rm -f "$C" >/dev/null 2>&1 || true
    # Remove the container however this script ends (a failed step exits early).
    trap 'docker rm -f "$C" >/dev/null 2>&1 || true' EXIT
    docker run -d --name "$C" -p 127.0.0.1:3399:3306 -e MARIADB_ROOT_PASSWORD="$LP" -e MARIADB_DATABASE=wordpress -e MARIADB_USER=wp -e MARIADB_PASSWORD="$LP" mariadb:11.4 >/dev/null
    for i in $(seq 1 30); do docker exec "$C" mariadb -uwp -p"$LP" -e 'select 1' wordpress >/dev/null 2>&1 && break; sleep 2; done
    WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="mysql://wp:$LP@127.0.0.1:3399/wordpress" DEV_ENV=a-local opcache
    docker rm -f "$C" >/dev/null
  else
    echo "  no Docker: OPcache not primed (the site works; cold starts are slower)"
  fi
fi

# The site's own origin (issue #33): WP_HOME and every link come from it, not
# from whichever request boots PHP. SITE_ORIGIN (for example a custom domain)
# or the workers.dev address, from the account's subdomain. The token goes to
# curl in a config on a pipe, not in the arguments.
if [ -z "${SITE_ORIGIN:-}" ]; then
  SUB=$(curl -sf -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") \
    "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/subdomain" \
    | python3 -c 'import json, sys; print(json.load(sys.stdin)["result"]["subdomain"])')
  SITE_ORIGIN="https://$NAME.$SUB.workers.dev"
fi
[[ "$SITE_ORIGIN" =~ ^https?://[a-z0-9.-]+(:[0-9]{1,5})?$ ]] || { echo "SITE_ORIGIN must be scheme://host[:port], got $SITE_ORIGIN" >&2; exit 2; }
echo "site origin: $SITE_ORIGIN"

# 3. Wrangler config from the Terraform outputs. Kept next to wrangler.toml so
# the relative paths (main, assets, zips) are the same.
CONF="$APP/wrangler.deploy.$NAME.toml"
COMPAT=$(sed -n 's/^compatibility_date = "\(.*\)"/\1/p' wrangler.toml | head -1)
# shellcheck source=SCRIPTDIR/render-conf.sh
. "$ROOT/deploy/render-conf.sh"
# #699 part B: a b-dosql site binds the account's purge budget when it is present, and says which (budget.sh).
# #1339 (#837): approach A too, so its purges share the account budget instead of failing open to its own rules.
case "$VARIANT" in a|b-dosql) purge_budget_decide "deploy.sh $NAME" ;; *) PURGE_BUDGET_BIND=0 ;; esac
render_conf > "$CONF"

# #569, #563: a remote build is never uploaded without its ASSETS binding and /_pf/ first, and a
# build and its config agree on SITE_REMOTE (deploy/wfp/remote_assets_check.py, the same guard
# deploy/wfp runs). A plain build passes it. Variant a and, since #598, b-dosql (its packs are on by default).
if [ "$VARIANT" = a ] || [ "$VARIANT" = b-dosql ]; then
  python3 -I "$ROOT/deploy/wfp/remote_assets_check.py" "$CONF" "$APP" || { echo "the remote assets check refused $CONF" >&2; exit 2; }
fi

# #827: the build is for the engine vendor/ holds (build/engine-tag against vendor/engine.mjs), so the upload cannot
# ship an engine its build id does not name.
engine_build_check "$APP" || exit 2

if [ "$DRY_RUN" = 1 ]; then
  log "dry run: $CONF"
  "$ROOT/deploy/wr" deploy --dry-run --outdir "${DRY_OUT:-$(mktemp -d)}" --config "$CONF" 2>&1 | grep -E 'Total Upload|dry-run|Your Worker has access'
  exit "${PIPESTATUS[0]}"
fi

# 4. Deploy, with the secrets in the same version (#751).
log "deploy"
# #754: the URL on wrangler's trigger line, never the first workers.dev URL in the output (a var such as
# a var holding a workers.dev URL prints one in the bindings). deploy/deploy-url.sh. The origin check runs below, after the redaction.
deploy_code_and_secrets || exit 1
# #1428: the upload succeeded, and the data-plane apply already did. Record this run's inputs now.
# CODE_ONLY never touches Terraform state, so it does not record.
if [ "$CODE_ONLY" != 1 ]; then
  record_deploy_inputs "$this_inputs" || exit 1
fi
# Logs on: redact the query strings now, before anything else runs on the site, or turn the logs off.
# That PATCH can publish a new Worker version. Nothing between here and the install publishes another.
obs_redact "$NAME" || exit 1
# The line is the deployments API's answer (newest deployment, version at 100 percent), not wrangler's
# Current Version ID. CODE_ONLY runs obs_redact too, so it is printed here, before that exit. A failed read stops the deploy.
pf_print_serving_version || exit 1
# #1186: the Cron Triggers read back from the API must match the render: the approach A cron on (its schedule), or none at all.
# Before CODE_ONLY's exit, so a code-only redeploy is checked too. A mismatch or a failed read stops the deploy loudly.
if [ "$VARIANT" = a ] && a_cron_on; then cron_schedules_readback "$NAME" on "${A_CRON_CRON:-* * * * *}" || exit 1
else cron_schedules_readback "$NAME" off || exit 1; fi
if [ "$CODE_ONLY" = 1 ]; then
  log "code only: secrets, install and measurements skipped (they persist or ran once)"
  origin_check "$URL" "$SITE_ORIGIN" || exit 1
  echo "$URL"
  exit 0
fi
# #754: AFTER the redaction (secrets are already in the uploaded version): a wrong origin fails the deploy, but it never strands a site without its
# secrets or with its logs unredacted. (The URL is known only after the upload, so the check cannot move before it.)
origin_check "$URL" "$SITE_ORIGIN" || exit 1
SPIKE_TOKEN=$(out spike_token); ADMIN_PASSWORD=$(out admin_password)

# 5. Install WordPress. b-do: in the PHP object (on Workers Free too:
# 901 D1 queries, 57 s measured). a: in the Worker (Workers Paid).
# #811: the object can still be on the previous version and answer 403. Retry
# until it is installed, and fail the deploy if it never is (deploy/install.sh).
# The failure prints the last status and the body's first bytes. When the retries
# run out it also names the current deployment, read with the deploy token.
log "install"
install_wordpress "$URL" || exit 1

if [ "${WOO_ACTIVE:-0}" = 1 ]; then
  log "activate WooCommerce"
  activate_woocommerce "$URL" || exit 1
fi

# #734: OBJECT_CACHE_VERSIONS is on by default for variant a; its versions table is installed here and read back.
if [ "$VARIANT" = a ] && [ "${OBJECT_CACHE_VERSIONS:-1}" != 0 ]; then a_ocv_install "$URL" "$SPIKE_TOKEN" || exit 1; fi
# #1152: did the cron object (A_CRON=1) move to this build? A WARNING if not within CRON_VERSION_WAIT_S; never a failure.
# #1360: that readback wakes the cron alarm once first (/_cron-wake). A failed wake never fails the deploy.
cron_version_readback "$URL" "$SPIKE_TOKEN"

PW_HINT="(admin; password: cd deploy/terraform && terraform workspace select $NAME && terraform output -raw admin_password)"
[ "${BENCH:-1}" = 0 ] && { echo "$URL $PW_HINT"; exit 0; }

# 6. Measure: database time per statement from where PHP runs, e2e.sh, pages.
log "measure"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RES="$ROOT/deploy/results/$NAME-$STAMP.json"
W=$(mktemp -d)
# Database time per statement: D1 or Hyperdrive (/_d1ping), or the object's
# own SQLite for b-dosql (/_dbping?db=object).
PING_PATH=$([ "$VARIANT" = b-dosql ] && echo "/_dbping?db=object&n=200&" || echo "/_d1ping?")
for i in 1 2 3; do curl -s -K <(printf 'header = "x-spike-token: %s"\n' "$SPIKE_TOKEN") "$URL${PING_PATH}nocache=$RANDOM$i"; echo; done > "$W/ping"
# A failing e2e.sh is a result to record, so it must not stop the script (set -e).
E2E_EXIT=0
SPIKE_TOKEN=$SPIKE_TOKEN ADMIN_PASSWORD=$ADMIN_PASSWORD ./e2e.sh "$URL" > "$W/e2e" 2>&1 || E2E_EXIT=$?
B=$URL ADMIN_PASSWORD=$ADMIN_PASSWORD N=${N:-10} python3 "$ROOT/tests/a/bench.py" > "$W/bench" 2>&1 || true
VARIANT=$VARIANT python3 "$ROOT/deploy/summarize.py" "$RES" "$NAME" "$URL" "$LOCATION" "$E2E_EXIT" "$W"
rm -rf "$W"
echo "$URL $PW_HINT"
