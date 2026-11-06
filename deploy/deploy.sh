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
#         MYSQL_DATABASE; the server must have SSL)
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
# BENCH=0 (skip the measurements), N (runs per page, default 10), PORT (local
# wrangler dev port for the OPcache step, default 8798), DEPLOY_STATE=r2 (keep
# Terraform state in an R2 bucket; see README.md).
#
# Steps: Terraform makes the data plane -> build -> Wrangler config from the
# Terraform outputs -> deploy -> secrets -> install -> measure -> deploy/results/.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TF="$ROOT/deploy/terraform"
APP="$ROOT/spikes/b2-wordpress"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}" "${ACCOUNT_ID:?set ACCOUNT_ID}" "${NAME:?set NAME}"
export CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID
VARIANT=${VARIANT:-b-do}
LOCATION=${LOCATION:-enam}
MEDIA=${MEDIA:-0}
export PORT=${PORT:-8798}
export WOO_ACTIVE=${WOO_ACTIVE:-0}
log() { printf '\n== %s\n' "$*"; }
case "$VARIANT" in b-do|b-dosql|a|c1) ;; *) echo "VARIANT must be b-do, b-dosql, a or c1"; exit 2 ;; esac
if [ -n "${HYPERDRIVE_SQL_MODE+x}" ]; then
  [ "$VARIANT" = a ] || { echo "HYPERDRIVE_SQL_MODE is for variant a only" >&2; exit 2; }
  [[ "$HYPERDRIVE_SQL_MODE" =~ ^[A-Za-z_,]*$ ]] || { echo "HYPERDRIVE_SQL_MODE: mode names and commas only" >&2; exit 2; }
fi

# Terraform state: local by default; DEPLOY_STATE=r2 writes a backend override
# for the root in $1 (deploy/terraform or deploy/mysql).
backend() {
  [ "${DEPLOY_STATE:-local}" = r2 ] || return 0
  : "${STATE_BUCKET:?set STATE_BUCKET}" "${STATE_ENDPOINT:?set STATE_ENDPOINT (https://<account>.r2.cloudflarestorage.com)}"
  # Each site has its own state key, so the workspace the last site selected
  # is not in this one and init refuses it. Start from default; tf() selects.
  rm -f "$1/.terraform/environment"
  cat > "$1/backend_override.tf" <<EOF
terraform {
  backend "s3" {
    bucket                      = "$STATE_BUCKET"
    key                         = "deploy/$NAME/$(basename "$1").tfstate"
    region                      = "auto"
    endpoints                   = { s3 = "$STATE_ENDPOINT" }
    use_path_style              = true
    use_lockfile                = true
    skip_s3_checksum            = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
  }
}
EOF
}
# One workspace (one state) per site: a second NAME never touches the first.
tf() { local dir=$1; shift; (cd "$dir" && terraform workspace select -or-create "$NAME" >/dev/null && terraform "$@"); }
out() { tf "$TF" output -raw "$1"; }

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
[ -f vendor/php_8_3.js ] || ./prepare.sh
if [ "$VARIANT" = b-do ] || [ "$VARIANT" = b-dosql ]; then
  ./build.sh | tail -1
  DEV_ENV=$([ "$VARIANT" = b-dosql ] && echo dosql-local || echo do-local) opcache
else
  ENGINE=a ./build.sh | tail -1
  # OPcache is primed against a temporary local MariaDB (env a-local); without
  # Docker the site runs, but every new isolate compiles PHP first.
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

# 3. Wrangler config from the Terraform outputs. Kept next to wrangler.toml so
# the relative paths (main, assets, zips) are the same.
CONF="$APP/wrangler.deploy.$NAME.toml"
COMPAT=$(sed -n 's/^compatibility_date = "\(.*\)"/\1/p' wrangler.toml | head -1)
{
  echo "# Generated by deploy/deploy.sh for $NAME ($VARIANT). Do not edit: run deploy.sh again."
  echo "name = \"$NAME\""
  echo "main = \"$([ "$VARIANT" = a ] && echo index-a.js || echo index.js)\""
  echo "compatibility_date = \"$COMPAT\""
  echo 'compatibility_flags = ["nodejs_compat"]'
  echo 'workers_dev = true'
  echo 'rules = [{ type = "Data", globs = ["**/*.zip"], fallthrough = false }]'
  echo '[assets]'; echo 'directory = "build/public"'
  echo '[cache]'; echo 'enabled = true'
  echo '[vars]'
  echo "PHP_ENV = '{\"USE_ZEND_ALLOC\":\"0\"}'"
  # The Worker writes it into wp-runtime.php as a PHP constant.
  [ -z "${HYPERDRIVE_SQL_MODE+x}" ] || echo "HYPERDRIVE_SQL_MODE = \"$HYPERDRIVE_SQL_MODE\""
  if [ "$VARIANT" = b-do ] || [ "$VARIANT" = b-dosql ]; then
    echo 'PHP_IN_DO = "on"'
    echo "PHP_LOCATION = \"$LOCATION\""
    echo 'PHP_DO_POOL = "1"'
    # b-dosql: the object's own SQLite is the database (one object).
    [ "$VARIANT" != b-dosql ] || echo 'DB_IN_DO = "on"'
  fi
  echo '[images]'; echo 'binding = "IMAGES"'
  if [ -n "$BUCKET" ]; then echo '[[r2_buckets]]'; echo 'binding = "MEDIA"'; echo "bucket_name = \"$BUCKET\""; fi
  if [ "$VARIANT" = b-do ] || [ "$VARIANT" = b-dosql ]; then
    [ "$VARIANT" != b-do ] || { echo '[[d1_databases]]'; echo 'binding = "DB"'; echo "database_name = \"$(out d1_name)\""; echo "database_id = \"$(out d1_id)\""; }
    echo '[[durable_objects.bindings]]'; echo 'name = "PHP_RUNTIME"'; echo 'class_name = "PhpRuntime"'
    echo '[[migrations]]'; echo 'tag = "v1"'; echo 'new_sqlite_classes = ["PhpRuntime"]'
  else
    echo '[[hyperdrive]]'; echo 'binding = "HYPERDRIVE"'; echo "id = \"$(out hyperdrive_id)\""
    # Workers Paid: 30 s of CPU per request, and the Worker runs near the
    # database (aws:us-east-2 runs in ORD; deploy/mysql defaults to Chicago).
    echo '[limits]'; echo 'cpu_ms = 30000'
    echo '[placement]'; echo "region = \"${PLACEMENT:-aws:us-east-2}\""
  fi
} > "$CONF"

# 4. Deploy and set the secrets.
log "deploy"
DEP=$(npx wrangler deploy --config "$CONF" 2>&1) || { echo "$DEP" | tail -20; exit 1; }
URL=$(echo "$DEP" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
echo "$DEP" | grep -E 'Total Upload|Current Version'
SECRETS=$(mktemp); chmod 600 "$SECRETS"
tf "$TF" output -json | python3 -c '
import json, sys
o = {k: v["value"] for k, v in json.load(sys.stdin).items()}
json.dump({"WP_SALT": o["wp_salt"], "SPIKE_TOKEN": o["spike_token"]}, open(sys.argv[1], "w"))' "$SECRETS"
npx wrangler secret bulk "$SECRETS" --config "$CONF" | tail -1
rm -f "$SECRETS"
SPIKE_TOKEN=$(out spike_token); ADMIN_PASSWORD=$(out admin_password)

# 5. Install WordPress (once). b-do: in the PHP object (on Workers Free too:
# 901 D1 queries, 57 s measured). a: in the Worker (Workers Paid).
log "install"
sleep 5
curl -s -m 300 -X POST -H "x-spike-token: $SPIKE_TOKEN" -H "x-admin-password: $ADMIN_PASSWORD" "$URL/_install" \
  | python3 -c 'import json, sys
try:
    d = json.load(sys.stdin); print(d.get("out", "")[-80:], d.get("ms"), "ms")
except ValueError:
    print("install did not answer JSON (on Workers Free, variant a stops at the CPU limit)")'

if [ "${WOO_ACTIVE:-0}" = 1 ]; then
  log "activate WooCommerce"
  curl -s -m 300 -X POST -H "x-spike-token: $SPIKE_TOKEN" "$URL/_activate?plugin=woocommerce/woocommerce.php" | tee /dev/stderr | grep -q '\\"active\\":true' \
    || { echo "WooCommerce did not activate (a result: record it)"; exit 1; }
fi

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
for i in 1 2 3; do curl -s -H "x-spike-token: $SPIKE_TOKEN" "$URL${PING_PATH}nocache=$RANDOM$i"; echo; done > "$W/ping"
# A failing e2e.sh is a result to record, so it must not stop the script (set -e).
E2E_EXIT=0
SPIKE_TOKEN=$SPIKE_TOKEN ADMIN_PASSWORD=$ADMIN_PASSWORD ./e2e.sh "$URL" > "$W/e2e" 2>&1 || E2E_EXIT=$?
B=$URL ADMIN_PASSWORD=$ADMIN_PASSWORD N=${N:-10} python3 "$ROOT/tests/a/bench.py" > "$W/bench" 2>&1 || true
VARIANT=$VARIANT python3 "$ROOT/deploy/summarize.py" "$RES" "$NAME" "$URL" "$LOCATION" "$E2E_EXIT" "$W"
rm -rf "$W"
echo "$URL $PW_HINT"
