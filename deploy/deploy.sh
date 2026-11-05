#!/bin/bash
# Deploy one WordPress site on Cloudflare, then measure it.
#
#   CLOUDFLARE_API_TOKEN=... ACCOUNT_ID=... NAME=my-site ./deploy/deploy.sh
#
# VARIANT (default b-do):
#   b-do  PHP in a Durable Object, database on D1 (Workers Free or Paid)
#   a     PHP in the Worker, MySQL through Hyperdrive (Workers Paid). MySQL is
#         MYSQL=vultr (deploy/mysql makes a box; needs VULTR_API_KEY, MYSQL_ZONE_ID,
#         MYSQL_HOST) or MYSQL=external (MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD,
#         MYSQL_DATABASE; the server must have SSL)
# Optional: LOCATION (default enam), MEDIA=1 (R2 media library; R2 must be on),
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
log() { printf '\n== %s\n' "$*"; }
case "$VARIANT" in b-do|a) ;; *) echo "VARIANT must be b-do or a"; exit 2 ;; esac

# Terraform state: local by default; DEPLOY_STATE=r2 writes a backend override
# for the root in $1 (deploy/terraform or deploy/mysql).
backend() {
  [ "${DEPLOY_STATE:-local}" = r2 ] || return 0
  : "${STATE_BUCKET:?set STATE_BUCKET}" "${STATE_ENDPOINT:?set STATE_ENDPOINT (https://<account>.r2.cloudflarestorage.com)}"
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

# 2. Build: PHP WebAssembly, WordPress, precompiled OPcache (local wrangler dev).
log "build"
cd "$APP"
[ -d node_modules ] || npm ci --silent
[ -f vendor/php_8_3.js ] || ./prepare.sh
if [ "$VARIANT" = b-do ]; then
  ./build.sh | tail -1
  DEV_ENV=do-local ./opcache.sh | tail -1
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
    WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="mysql://wp:$LP@127.0.0.1:3399/wordpress" DEV_ENV=a-local ./opcache.sh | tail -1
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
  if [ "$VARIANT" = b-do ]; then
    echo 'PHP_IN_DO = "on"'
    echo "PHP_LOCATION = \"$LOCATION\""
    echo 'PHP_DO_POOL = "1"'
  fi
  echo '[images]'; echo 'binding = "IMAGES"'
  if [ -n "$BUCKET" ]; then echo '[[r2_buckets]]'; echo 'binding = "MEDIA"'; echo "bucket_name = \"$BUCKET\""; fi
  if [ "$VARIANT" = b-do ]; then
    echo '[[d1_databases]]'; echo 'binding = "DB"'; echo "database_name = \"$(out d1_name)\""; echo "database_id = \"$(out d1_id)\""
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

PW_HINT="(admin; password: cd deploy/terraform && terraform workspace select $NAME && terraform output -raw admin_password)"
[ "${BENCH:-1}" = 0 ] && { echo "$URL $PW_HINT"; exit 0; }

# 6. Measure: database time per statement from where PHP runs, e2e.sh, pages.
log "measure"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RES="$ROOT/deploy/results/$NAME-$STAMP.json"
W=$(mktemp -d)
for i in 1 2 3; do curl -s -H "x-spike-token: $SPIKE_TOKEN" "$URL/_d1ping?nocache=$RANDOM$i"; echo; done > "$W/ping"
# A failing e2e.sh is a result to record, so it must not stop the script (set -e).
E2E_EXIT=0
SPIKE_TOKEN=$SPIKE_TOKEN ADMIN_PASSWORD=$ADMIN_PASSWORD ./e2e.sh "$URL" > "$W/e2e" 2>&1 || E2E_EXIT=$?
B=$URL ADMIN_PASSWORD=$ADMIN_PASSWORD N=${N:-10} python3 "$ROOT/tests/a/bench.py" > "$W/bench" 2>&1 || true
VARIANT=$VARIANT python3 "$ROOT/deploy/summarize.py" "$RES" "$NAME" "$URL" "$LOCATION" "$E2E_EXIT" "$W"
rm -rf "$W"
echo "$URL $PW_HINT"
