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
# PAGE_CACHE_PRODUCT_TTL (b-do, b-dosql and a, #706): seconds a WooCommerce
# product, shop or category page stays fresh. A store (WOO_ACTIVE=1) renders 30
# when this is unset. A site that is not a store renders nothing, so those pages
# keep 120 s. Set an integer from 5 to 600 to override. Any other value, or a
# WOO_ACTIVE other than 0 or 1, is refused before any step. The line comes from
# deploy/provision/wp-site-config.mjs, the same function the one-click paths use.
# BENCH=0 (skip the measurements), N (runs per page, default 10), PORT (local
# wrangler dev port for the OPcache step, default 8798), DEPLOY_STATE=r2 (keep
# Terraform state in an R2 bucket; see README.md).
# INSTALL_WAIT_S (default 120, at most 600; #811): how long to retry /_install while
# the answer is 403, 5xx, no answer, or not JSON. INSTALL_INTERVAL_S (default 5) is
# the pause. A JSON answer that is not installed fails the deploy.
# Variant a renders the measured site by default (#666, deploy/README.md): the lean client (A_CLIENT), the
# object cache with its L2 KV and lazy nodes; PHP_OVERFLOW=1 adds the overflow pool (PHP_OVERFLOW_POOL, default 32);
# PHP_OVERFLOW=always (#714, a measurement arm) moves every eligible request to it.
# Variant a, the #394 admin fixes (deploy/a-settings.sh; all off unless set): OPCACHE_A=1 primes
# OPcache on the D1 build with no Docker (opcache-a.sh; an empty cache fails), OPCACHE_REMOTE=1 and
# SITE_REMOTE=1 move the bundle's zips to packs under /_pf/ (#563, #569; they need OPCACHE_A=1), RECYCLE_WASM_MIB sets the
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
VARIANT=${VARIANT:-b-do}
LOCATION=${LOCATION:-enam}
MEDIA=${MEDIA:-0}
AI=${AI:-0}
export PORT=${PORT:-8798}
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
# REQUEST_FRAMES (#352, #589 part 1): on by default for b-dosql (render-conf.sh), off the escape hatch. Only
# b-dosql has the object-SQLite undo log, so the var on another variant is refused, before any step.
case "${REQUEST_FRAMES:-}" in
  ""|on|off) ;;
  *) echo "REQUEST_FRAMES must be on, off or unset, not ${REQUEST_FRAMES}" >&2; exit 2 ;;
esac
if [ -n "${REQUEST_FRAMES:-}" ] && [ "${VARIANT:-}" != b-dosql ]; then echo "REQUEST_FRAMES is for variant b-dosql (the object-SQLite undo log), not ${VARIANT:-unset}" >&2; exit 2; fi
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
# #788: approach A stays on the npm engine until lean is measured there (the lead's ruling, #771). An explicit
# PHP_ENGINE, or PF_ENGINE_JS and PF_ENGINE_WASM, still wins.
if [ "$VARIANT" = a ] && [ -z "${PHP_ENGINE:-}" ] && [ -z "${PF_ENGINE_JS:-}${PF_ENGINE_WASM:-}" ]; then export PHP_ENGINE=npm; fi
# #771: the PHP engine, resolved ONCE here and exported (spikes/b2-wordpress/engine.sh): prepare.sh, build.sh and
# everything after see the same pair. The default is the pinned lean engine; PHP_ENGINE=npm, or PF_ENGINE_JS and
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
log "terraform: $VARIANT data plane for $NAME ($LOCATION)"
backend "$TF"; mkdir -p "$TF/sites"
{
  echo "account_id = \"$ACCOUNT_ID\""
  echo "name       = \"$NAME\""
  echo "variant    = \"$VARIANT\""
  echo "location   = \"$LOCATION\""
  echo "media      = $([ "$MEDIA" = 1 ] && echo true || echo false)"
  if [ "$VARIANT" = a ]; then
    echo "mysql_host     = \"$MYSQL_HOST\""
    echo "mysql_user     = \"$MYSQL_USER\""
    echo "mysql_database = \"$MYSQL_DATABASE\""
  fi
} > "$TF/sites/$NAME.tfvars"
(cd "$TF" && terraform init -input=false -reconfigure >/dev/null)
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
# Variant c1 (Container) has its own build, deploy and measure steps.
if [ "$VARIANT" = c1 ]; then
  . "$ROOT/deploy/variants/c1.sh"
  c1_main
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
  ./build.sh | tail -1
  DEV_ENV=$([ "$VARIANT" = b-dosql ] && echo dosql-local || echo do-local) opcache
elif [ "${OPCACHE_A:-0}" = 1 ]; then
  # #394: prime on the D1 build, the way opcache-a.sh does (#218): the same WordPress, WooCommerce
  # and mu-plugins, no Docker and no local MySQL. TRACE=1 also records the file trace the remote
  # packs follow, cut to the files A's zips hold (trace-filter.py). No pipe: a pipe would take
  # tail's status and ship a half-built tree.
  ALOG=$(mktemp)
  TRACE=${OPCACHE_REMOTE:-0} WOO_ACTIVE=$WOO_ACTIVE ./opcache-a.sh > "$ALOG" 2>&1 || { echo "opcache-a.sh failed:"; tail -25 "$ALOG"; rm -f "$ALOG"; exit 1; }
  grep -E 'approach-A opcache.zip|trace-filter:' "$ALOG" || true
  rm -f "$ALOG"
  a_opcache_count build/opcache.zip || exit 1
  # #563, #569: after the last build.sh (it clears build/public), as deploy/wfp's build_dosql does.
  if [ "${OPCACHE_REMOTE:-0}" = 1 ]; then
    python3 -I opcache-remote.py build/opcache.zip build/file-trace.json build/build-id.js || exit 1
  fi
  if [ "${SITE_REMOTE:-0}" = 1 ]; then
    python3 -I site-remote.py build/site.zip build/file-trace.json build/build-id.js || exit 1
  fi
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
render_conf > "$CONF"

# #569, #563: a remote build is never uploaded without its ASSETS binding and /_pf/ first, and a
# build and its config agree on SITE_REMOTE (deploy/wfp/remote_assets_check.py, the same guard
# deploy/wfp runs). A plain build passes it.
if [ "$VARIANT" = a ]; then
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
# Logs on: redact the query strings now, before anything else runs on the site, or turn the logs off.
# That PATCH can publish a new Worker version. Nothing between here and the install publishes another.
obs_redact "$NAME" || exit 1
# The line is the deployments API's answer (newest deployment, version at 100 percent), not wrangler's
# Current Version ID. CODE_ONLY runs obs_redact too, so it is printed here, before that exit. A failed read stops the deploy.
pf_print_serving_version || exit 1
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
  # A just-deployed cold b-dosql isolate can hit "isolate exceeded its memory limit
  # and was reset" on the first activation (#198); a retry lands on a warm isolate and
  # succeeds. Bounded retry with backoff so activation self-heals deterministically
  # instead of relying on the first attempt's luck.
  ACT_TRIES=${ACT_TRIES:-4}
  act_ok=0
  for act_n in $(seq 1 "$ACT_TRIES"); do
    if curl -s -m 300 -X POST -K <(printf 'header = "x-spike-token: %s"\n' "$SPIKE_TOKEN") "$URL/_activate?plugin=woocommerce/woocommerce.php" | tee /dev/stderr | grep -q '\\"active\\":true'; then
      act_ok=1; break
    fi
    echo "WooCommerce activation attempt $act_n/$ACT_TRIES did not report active; retrying" >&2
    sleep "$((act_n * 3))"
  done
  [ "$act_ok" = 1 ] || { echo "WooCommerce did not activate after $ACT_TRIES attempts (a result: record it)"; exit 1; }
fi

# #734: OBJECT_CACHE_VERSIONS is on by default for variant a; its versions table is installed here and read back.
if [ "$VARIANT" = a ] && [ "${OBJECT_CACHE_VERSIONS:-1}" != 0 ]; then a_ocv_install "$URL" "$SPIKE_TOKEN" || exit 1; fi

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
