# shellcheck shell=bash
# render_conf: the Wrangler config deploy.sh deploys, on stdout (#666: moved out of deploy.sh unchanged, so a
# test can render it with a stub out() and no Terraform; deploy/tests/a-render-test.sh). The caller sets NAME,
# VARIANT, LOCATION, SITE_ORIGIN, APP, COMPAT, BUCKET and AI, sources a-settings.sh and observability.sh,
# defines out() (a Terraform output by name), and runs this from $APP.
# shellcheck source=SCRIPTDIR/object-time.sh
. "$(dirname "${BASH_SOURCE[0]}")/object-time.sh"
# shellcheck source=SCRIPTDIR/db-query-timeout.sh
. "$(dirname "${BASH_SOURCE[0]}")/db-query-timeout.sh" # #1364
# shellcheck source=SCRIPTDIR/fault-inject.sh
. "$(dirname "${BASH_SOURCE[0]}")/fault-inject.sh"
# shellcheck source=SCRIPTDIR/page-cache-ttl.sh
. "$(dirname "${BASH_SOURCE[0]}")/page-cache-ttl.sh"
# shellcheck source=SCRIPTDIR/purge-budget/budget.sh
. "$(dirname "${BASH_SOURCE[0]}")/purge-budget/budget.sh"
# shellcheck source=SCRIPTDIR/pdf-invoice.sh
. "$(dirname "${BASH_SOURCE[0]}")/pdf-invoice.sh"
# shellcheck source=SCRIPTDIR/lib/wp-cli-endpoint.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/wp-cli-endpoint.sh"
# a_placement_lines (#1054): the [placement] block of a variant a Worker. PLACEMENT is
#   host                    host = "<MYSQL_HOST>:<MYSQL_PORT or 3306>": Cloudflare probes the database
#                           host and runs the Worker next to it (docs: layer 4 host hint, experimental);
#   <aws|gcp|azure>:<region> region = that cloud region (for example azure:westus2);
#   smart                   mode = "smart" (needs steady traffic from several locations);
#   unset                   MYSQL=vultr: region = "aws:us-east-2" (deploy/mysql's own box is in ord, Chicago,
#                           which that region serves). Any other MySQL: REFUSED, naming PLACEMENT.
# Measured on cf759hw (2026-11-20, same build): aws:us-east-2 put the Worker in ORD and an Azure westus2
# database's admin pages took 2 to 4 s; azure:westus2 put it in SEA at 0.6 to 1.4 s. host = <db>:3306
# placed in ORD too, so the probe does not find an Azure server's region and is not the default.
# placement_check refuses any other value before any step (deploy.sh).
placement_check() {
  case "${PLACEMENT:-}" in
    "")
      [ "${MYSQL:-external}" = vultr ] && return 0
      case "${MYSQL_HOST:-}" in
        *.mysql.database.azure.com) echo "approach A needs PLACEMENT, the database's region, so the Worker runs next to it: set PLACEMENT=azure:<the server's region> (for example azure:westus2 for wpref-mysql). Without it the Worker ran in ORD, 2 to 5 times slower (#1054)." >&2 ;;
        *) echo "approach A needs PLACEMENT for an external MySQL, so the Worker runs next to the database: set PLACEMENT=<aws|gcp|azure>:<the database's region>, host (Cloudflare probes MYSQL_HOST), or smart (#1054)." >&2 ;;
      esac
      return 2 ;;
    host|smart) ;;
    aws:*|gcp:*|azure:*) [[ "$PLACEMENT" =~ ^(aws|gcp|azure):[a-z0-9-]{2,40}$ ]] || { echo "PLACEMENT region must be <aws|gcp|azure>:<region>, not ${PLACEMENT}" >&2; return 2; } ;;
    *) echo "PLACEMENT must be host, smart, <aws|gcp|azure>:<region> or unset, not ${PLACEMENT}" >&2; return 2 ;;
  esac
  if [ "${PLACEMENT:-}" = host ]; then
    [[ "${MYSQL_HOST:-}" =~ ^[A-Za-z0-9.-]{1,253}$ ]] || { echo "PLACEMENT=host needs MYSQL_HOST, a host name (not ${MYSQL_HOST:-unset})" >&2; return 2; }
    [[ "${MYSQL_PORT:-3306}" =~ ^[0-9]{1,5}$ ]] || { echo "PLACEMENT=host: MYSQL_PORT must be a port number" >&2; return 2; }
  fi
}
a_placement_lines() {
  placement_check || return 1
  echo '[placement]'
  case "${PLACEMENT:-}" in
    host) echo "host = \"${MYSQL_HOST}:${MYSQL_PORT:-3306}\"" ;;
    smart) echo 'mode = "smart"' ;;
    "") echo 'region = "aws:us-east-2"' ;;  # MYSQL=vultr only: placement_check refused every other unset case
    *) echo "region = \"${PLACEMENT}\"" ;;
  esac
}
render_conf() {
  # #1258: refuse DEV_LOCAL, the local spike token, and the three seam vars
  # before any line is written. deploy.sh checks the same function first.
  wp_cli_local_seam_check || return 2
  # #1364: the per-query bound is approach A only. A bad value stops the render
  # before any line is written. Unset writes nothing (the engine's 30 s).
  if [ "$VARIANT" = a ]; then
    db_query_timeout_check || return 2
  elif [ -n "${DB_QUERY_TIMEOUT_MS:-}" ]; then
    echo "DB_QUERY_TIMEOUT_MS is for variant a only, not $VARIANT" >&2
    return 2
  fi
  # RENDER_WFP=1 (#1319): deploy/wfp's kind a site, the user Worker RENDER_SCRIPT (site-<name>) in the dispatch
  # namespace. The same lines as deploy.sh renders for variant a, with three differences: no workers_dev (a
  # namespace script has none), no [triggers] (a Cron Trigger never fires on a namespace script, measured on #1310;
  # the cron object re-arms itself with Durable Object alarms instead), and no [observability] block here (deploy/wfp
  # appends its own, lib.sh obs_render). Unset, every line is as before.
  if [ "${RENDER_WFP:-0}" = 1 ]; then
    [ "$VARIANT" = a ] || { echo "RENDER_WFP=1 renders variant a only, not $VARIANT" >&2; return 2; }
    [[ "${RENDER_SCRIPT:-}" =~ ^site-[a-z0-9-]{1,30}$ ]] || { echo "RENDER_WFP=1 needs RENDER_SCRIPT, site-<name>" >&2; return 2; }
    [ -z "${CUSTOM_DOMAIN:-}" ] || { echo "RENDER_WFP=1: a namespace script has no Custom Domain (deploy/wfp routes the site)" >&2; return 2; }
    echo "# Generated by deploy/wfp for site $NAME (approach A in namespace ${NAMESPACE:-?}). Do not edit."
    echo "name = \"$RENDER_SCRIPT\""
  else
  echo "# Generated by deploy/deploy.sh for $NAME ($VARIANT). Do not edit: run deploy.sh again."
  echo "name = \"$NAME\""
  fi
  echo "main = \"$([ "$VARIANT" = a ] && a_main || echo index.js)\""
  echo "compatibility_date = \"$COMPAT\""
  # enable_request_signal (#721): the specific flag, never a compatibility-date bump.
  echo 'compatibility_flags = ["nodejs_compat", "enable_request_signal"]'
  [ "${RENDER_WFP:-0}" = 1 ] || echo 'workers_dev = true'
  echo 'rules = [{ type = "Data", globs = ["**/*.zip"], fallthrough = false }]'
  # #1262: CUSTOM_DOMAIN puts the Worker on that hostname as a Workers Custom Domain. wrangler deploy creates it (its DNS
  # record and certificate) with the version, so it exists only once the Worker does. deploy.sh checked the hostname
  # and its zone (deploy/lib/custom-domain.sh) before any step. Unset: no route, workers.dev only, as before.
  [ -z "${CUSTOM_DOMAIN:-}" ] || echo "routes = [{ pattern = \"$CUSTOM_DOMAIN\", custom_domain = true }]"
  # From address: MAIL_FROM, else wordpress@<site host> when that host can send
  # (spikes/b2-wordpress/mail-from.mjs). A workers.dev host sends nothing.
  # #1056: MAIL_ALLOWED_TO, the destination allowlist (allowed_destination_addresses), as c1 has.
  SITE_ORIGIN="$SITE_ORIGIN" MAIL_FROM="${MAIL_FROM:-}" MAIL_ALLOWED_TO="${MAIL_ALLOWED_TO:-}" node "$APP/mail-from.mjs" --binding
  echo '[assets]'; echo 'directory = "build/public"'; echo 'binding = "ASSETS"'; echo 'not_found_handling = "none"'
  # #563: a remote build serves its packs from the Worker only (a-settings.sh, #412). #598: b-dosql too (on by default,
  # deploy/lib/remote-packs.sh; deploy.sh applies remote_pack_defaults before this render).
  [ "$VARIANT" != a ] && [ "$VARIANT" != b-dosql ] || a_assets_first
  echo '[cache]'; echo 'enabled = true'
  # Only the Pages entrypoint is cached; the default one is the gateway (issue #63).
  echo '[exports.default]'; echo 'type = "worker"'; echo '[exports.default.cache]'; echo 'enabled = false'
  echo '[exports.Pages]'; echo 'type = "worker"'; echo '[exports.Pages.cache]'; echo 'enabled = true'
  # Workers Logs (deploy/observability.sh). Nothing when OBSERVABILITY is unset.
  [ "${RENDER_WFP:-0}" = 1 ] || obs_block
  echo '[vars]'
  echo "PHP_ENV = '{\"USE_ZEND_ALLOC\":\"0\"}'"
  echo "SITE_ORIGIN = \"$SITE_ORIGIN\""
  # #1098: SITE_NAME is the deploy name. /_install uses it when SITE_TITLE is unset.
  # A quote or a backslash would break the line. SITE_TITLE, when set, is the title.
  case "$NAME" in
    ''|*'"'*|*'\'*|*$'\n'*|*$'\r'*) echo "NAME must be one line without a quote or a backslash" >&2; return 1 ;;
  esac
  echo "SITE_NAME = \"$NAME\""
  if [ -n "${SITE_TITLE:-}" ]; then SITE_TITLE="$SITE_TITLE" node "$APP/install-title.mjs" --toml || return 1; fi
  # #1135: MAIL_ALLOWED_TO too, so the runtime pre-check gets the binding's own allowlist (one list, mail-from.mjs).
  SITE_ORIGIN="$SITE_ORIGIN" MAIL_FROM="${MAIL_FROM:-}" MAIL_FROM_NAME="${MAIL_FROM_NAME:-}" MAIL_ALLOWED_TO="${MAIL_ALLOWED_TO:-}" node "$APP/mail-from.mjs" --vars
  # Hosts PHP may call. Unset writes the default. Empty denies. See http-allow.mjs.
  HTTP_ALLOW=$(node "$APP/http-allow.mjs")
  echo "HTTP_ALLOW_HOSTS = \"$HTTP_ALLOW\""
  # CRON_INTERVAL_MS (issue #185): the DO alarm cadence in ms; tune per deploy. index.js defaults to 60000.
  [ -z "${CRON_INTERVAL_MS+x}" ] || echo "CRON_INTERVAL_MS = \"$CRON_INTERVAL_MS\""
  # The Worker writes it into wp-runtime.php as a PHP constant.
  [ -z "${HYPERDRIVE_SQL_MODE+x}" ] || echo "HYPERDRIVE_SQL_MODE = \"$HYPERDRIVE_SQL_MODE\""
  # #666: the measured object cache and lazy nodes, from aVars (the provisioning path's one source).
  if [ "$VARIANT" = a ]; then SITE_ORIGIN="$SITE_ORIGIN" OBJECT_CACHE_VERSIONS="${OBJECT_CACHE_VERSIONS:-1}" WOO_HPOS_CACHE="${WOO_HPOS_CACHE:-on}" node "$ROOT/deploy/provision/a-vars-toml.mjs" vars || return 1; fi
  # #394: OPCACHE_REMOTE, SITE_REMOTE, RECYCLE_WASM_MIB (a-settings.sh). Nothing when unset. #646: PHP_OVERFLOW.
  [ "$VARIANT" != a ] || a_vars
  # #598: b-dosql's two pack vars, from the ONE rule deploy/wfp renders them with (the config hash follows the flags).
  if [ "$VARIANT" = b-dosql ]; then opcache_remote_var || return 1; site_remote_var || return 1; fi
  # #1022: the recycle line and memory reuse on the DO tiers (a-settings.sh). Nothing when unset.
  case "$VARIANT" in b-dosql|b-do) dosql_mem_vars || return 1 ;; esac
  [ "$VARIANT" != a ] || a_overflow_vars
  [ "$VARIANT" != a ] || a_cron_vars
  # #1310 route (b), rollins's engine half (#1325): on a namespace script no Cron Trigger fires, so each isolate kicks the cron
  # object on its first site request and the object re-arms itself by alarm. deploy.sh's site keeps its Cron Trigger
  # and never gets it.
  if [ "${RENDER_WFP:-0}" = 1 ] && a_cron_on; then echo 'CRON_SELF_TICK = "on"'; fi
  # WOO_EXTRAS (#667): off only. Checked above, before any step. Unset writes nothing.
  [ -z "${WOO_EXTRAS:-}" ] || echo 'WOO_EXTRAS = "off"'
  # DEMO_LOCK: on marks a public demo store (PAGEFEATHER_DEMO_STORE + no outbound mail). Unset writes nothing.
  case "${DEMO_LOCK:-}" in
    "") ;;
    on) echo 'DEMO_LOCK = "on"' ;;
    *) echo "DEMO_LOCK must be on or unset, not ${DEMO_LOCK}" >&2; return 1 ;;
  esac
  # FAULT_INJECT (#730): checked before any step (deploy/fault-inject.sh, fault_check). Unset writes nothing.
  fault_line
  # OBJECT_CALL_DEADLINE_S, OBJECT_START_BY_S (#703, #708): deploy/object-time.sh. Unset writes nothing.
  object_time_vars || return 1
  # PAGE_CACHE_PRODUCT_TTL (#706): the same function the one-click paths use. A store renders 30.
  # A non-store renders nothing. deploy.sh refuses a bad value before any step; this refuses it again.
  node "$ROOT/deploy/provision/a-vars-toml.mjs" product-ttl || return 1
  # PAGE_CACHE_TTL (#759): b-dosql only (c1 renders its own). deploy.sh checked it before any step. Unset writes nothing.
  if [ "$VARIANT" = b-dosql ]; then page_cache_ttl_check || return 1; page_cache_ttl_line; fi
  # OPCACHE_MC (#610): a b-dosql store renders 64 (the runtime's OPcache size), every other site nothing (48).
  [ "$VARIANT" != b-dosql ] || node "$ROOT/deploy/provision/a-vars-toml.mjs" opcache-mc || return 1
  # AI alt text (spikes/b2-wordpress/php/ai-alt-text.php): off switch, model, input flavor.
  [ -z "${AI_ALT+x}" ] || echo "AI_ALT = \"$AI_ALT\""
  [ -z "${AI_ALT_MODEL+x}" ] || echo "AI_ALT_MODEL = \"$AI_ALT_MODEL\""
  [ -z "${AI_ALT_INPUT+x}" ] || echo "AI_ALT_INPUT = \"$AI_ALT_INPUT\""
  if [ "$VARIANT" = b-do ] || [ "$VARIANT" = b-dosql ]; then
    echo 'PHP_IN_DO = "on"'
    echo "PHP_LOCATION = \"$LOCATION\""
    echo 'PHP_DO_POOL = "1"'
    # b-dosql: the object's own SQLite is the database (one object).
    [ "$VARIANT" != b-dosql ] || echo 'DB_IN_DO = "on"'
    # REQUEST_FRAMES (#352, #589 part 1): on by default for b-dosql (the object-SQLite undo log), off the escape
    # hatch. deploy.sh refuses a bad value, and the var on another variant, before any step.
    [ "$VARIANT" != b-dosql ] || echo "REQUEST_FRAMES = \"${REQUEST_FRAMES:-on}\""
  fi
  # #1258: WP_CLI_ENDPOINT, ACCESS_AUD, ACCESS_TEAM. Unset prints nothing.
  wp_cli_endpoint_vars
  echo '[images]'; echo 'binding = "IMAGES"'
  # Workers AI binding for auto alt text (AI=1). Unified Billing (Cloudflare credit).
  [ "$AI" != 1 ] || { echo '[ai]'; echo 'binding = "AI"'; }
  # PDF_INVOICE (#765): Browser Rendering for the invoice PDF. deploy.sh checks the value and variant first.
  pdf_invoice_binding
  if [ -n "$BUCKET" ]; then echo '[[r2_buckets]]'; echo 'binding = "MEDIA"'; echo "bucket_name = \"$BUCKET\""; fi
  if [ "$VARIANT" = b-do ] || [ "$VARIANT" = b-dosql ]; then
    [ "$VARIANT" != b-do ] || { echo '[[d1_databases]]'; echo 'binding = "DB"'; echo "database_name = \"$(out d1_name)\""; echo "database_id = \"$(out d1_id)\""; }
    echo '[[durable_objects.bindings]]'; echo 'name = "PHP_RUNTIME"'; echo 'class_name = "PhpRuntime"'
    # #699 part B: the account's purge budget, when deploy.sh found it present (purge_budget_decide). Unset: nothing.
    purge_budget_toml_lines
    echo '[[migrations]]'; echo 'tag = "v1"'; echo 'new_sqlite_classes = ["PhpRuntime"]'
    cron_triggers_none   # #1186: no Cron Trigger on a DO tier; clears one left by an earlier approach A deploy
  else
    echo '[[hyperdrive]]'; echo 'binding = "HYPERDRIVE"'; echo "id = \"$(out hyperdrive_id)\""
    # Workers Paid: 30 s of CPU per request, and the Worker runs near the database (#1054).
    echo '[limits]'; echo 'cpu_ms = 30000'
    a_placement_lines || return 1
    # #666: the L2 object cache's own KV namespace (Terraform), and the overflow pool when PHP_OVERFLOW=1 or always.
    node "$ROOT/deploy/provision/a-vars-toml.mjs" kv "$(out oc_kv_id)" || return 1
    a_overflow_bindings
    a_cron_bindings
    # #1339 (#837): the account's purge budget, as for b-dosql; the cron object sends approach A's purges. Unset: nothing.
    purge_budget_toml_lines
    [ "${RENDER_WFP:-0}" = 1 ] || a_cron_triggers
  fi
}
