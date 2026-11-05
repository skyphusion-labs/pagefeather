# shellcheck shell=bash
# Variant c1: WordPress and WooCommerce in one Cloudflare Container
# (spikes/c1-woo-container, docs/approach-c1.md). Workers Paid only.
# deploy.sh sources this file after `terraform apply`; it uses ROOT, TF, NAME,
# ACCOUNT_ID, LOCATION, log and out from deploy.sh.
#
# Steps: build -> Wrangler config from the Terraform outputs -> deploy with the
# secrets in the same version -> wait for the rollout, stop the container once
# -> wait for WordPress (the first container installs it) -> e2e.sh, the page
# benchmark and one cold start -> deploy/results/.
#
# Options: INSTANCE_TYPE (default standard-1), PHP_WORKERS (default from the
# instance type), IDLE_SECONDS (default 900), PUBLIC_HOST (default
# <NAME>.<account subdomain>.workers.dev), ROLLOUT_WAIT (default 60 s),
# START_TIMEOUT (default 900 s), BENCH, N.

C1="$ROOT/spikes/c1-woo-container"
INSTANCE_TYPE=${INSTANCE_TYPE:-standard-1}
# PHP workers at 256 MB each. basic (1 GiB) dropped a connection with 4
# (docs/approach-c1.md); standard-1 (4 GiB) and standard-2 (6 GiB) were
# measured with 4 and 8.
case "$INSTANCE_TYPE" in basic) w=2 ;; standard-1|standard) w=4 ;; standard-2) w=8 ;; *) w=2 ;; esac
PHP_WORKERS=${PHP_WORKERS:-$w}
IDLE_SECONDS=${IDLE_SECONDS:-900}
REPLICA=$(out replica_bucket); MEDIA_BUCKET=$(out media_bucket); R2_ENDPOINT=$(out r2_endpoint)
echo "replica bucket $REPLICA, media bucket $MEDIA_BUCKET"

# The site address goes into the Worker vars (WordPress uses it as its home
# URL), so it must be known before the deploy: ask the API for the account's
# workers.dev subdomain.
if [ -z "${PUBLIC_HOST:-}" ]; then
  SUB=$(curl -sf -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/subdomain" \
    | python3 -c 'import json, sys; print(json.load(sys.stdin)["result"]["subdomain"])')
  PUBLIC_HOST="$NAME.$SUB.workers.dev"
fi

# 2. Build: WordPress, WooCommerce and the plugin suite into build/ (the image
# and the static files). Wrangler builds the image from container/Dockerfile.
log "build (c1)"
cd "$C1" || exit 1
[ -d node_modules ] || npm ci --silent
./build.sh | tail -1

# 3. Wrangler config from the Terraform outputs, next to wrangler.toml so the
# relative paths are the same.
CONF="$C1/wrangler.deploy.$NAME.toml"
COMPAT=$(sed -n 's/^compatibility_date = "\(.*\)"/\1/p' wrangler.toml | head -1)
NAME=$NAME PUBLIC_HOST=$PUBLIC_HOST REPLICA=$REPLICA MEDIA_BUCKET=$MEDIA_BUCKET R2_ENDPOINT=$R2_ENDPOINT \
  COMPAT=$COMPAT INSTANCE_TYPE=$INSTANCE_TYPE PHP_WORKERS=$PHP_WORKERS IDLE_SECONDS=$IDLE_SECONDS \
  "$ROOT/deploy/variants/c1-config.sh" > "$CONF"

# 4. Deploy. The secrets go in the same version (--secrets-file): a container
# that starts between a deploy and a later `secret bulk` would install
# WordPress with no admin password and no salt.
log "deploy (c1, $INSTANCE_TYPE, $PHP_WORKERS PHP workers)"
SECRETS=$(mktemp); chmod 600 "$SECRETS"
trap 'rm -f "$SECRETS"' EXIT
(cd "$TF" && terraform workspace select "$NAME" >/dev/null && terraform output -json) | python3 -c '
import json, sys
o = {k: v["value"] for k, v in json.load(sys.stdin).items()}
json.dump({"WP_SALT": o["wp_salt"], "ADMIN_PASSWORD": o["admin_password"], "SPIKE_TOKEN": o["spike_token"],
           "LITESTREAM_ACCESS_KEY_ID": o["litestream_access_key_id"],
           "LITESTREAM_SECRET_ACCESS_KEY": o["litestream_secret_access_key"]}, open(sys.argv[1], "w"))' "$SECRETS"
DEP=$(npx wrangler deploy --config "$CONF" --secrets-file "$SECRETS" --containers-rollout immediate 2>&1) || { echo "$DEP" | tail -30; exit 1; }
rm -f "$SECRETS"
URL=$(echo "$DEP" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
echo "$DEP" | grep -E 'Total Upload|Current Version' || true
[ "$URL" = "https://$PUBLIC_HOST" ] || { echo "deployed to '$URL', but PUBLIC_HOST is $PUBLIC_HOST: WordPress would link to the wrong host" >&2; exit 1; }
SPIKE_TOKEN=$(out spike_token); ADMIN_PASSWORD=$(out admin_password)

# 5. Rollout. A container that starts within about a minute of a deploy can run
# the old image (seen on the spike and on ggc). Wait, then stop the container
# once: the next request starts one from the new image. On a new site there is
# no container yet and the stop does nothing.
log "rollout: wait ${ROLLOUT_WAIT:-60} s, then stop the container once"
sleep "${ROLLOUT_WAIT:-60}"
curl -s -m 60 -X POST -H "x-spike-token: $SPIKE_TOKEN" "$URL/_store-stop"; echo

# Wait for WordPress. The first container of a new site installs WordPress and
# WooCommerce (php/install.php); later containers restore the database from
# the replica. ?nocache= keeps the edge page cache out of the answer.
wait_up() {
  local t0=$SECONDS code
  while :; do
    code=$(curl -s -o /dev/null -m 120 -w '%{http_code}' "$URL/?nocache=$RANDOM$RANDOM" || true)
    [ "$code" = 200 ] && { echo $((SECONDS - t0)); return 0; }
    [ $((SECONDS - t0)) -lt "${START_TIMEOUT:-900}" ] || { echo "no 200 from $URL/ after ${START_TIMEOUT:-900} s (last $code)" >&2; return 1; }
    sleep 5
  done
}
log "wait for WordPress"
FIRST_START_S=$(wait_up)
echo "first answer 200 after $FIRST_START_S s"

[ "${BENCH:-1}" = 0 ] && { echo "$URL (admin; password: cd deploy/terraform && terraform workspace select $NAME && terraform output -raw admin_password)"; exit 0; }

# 6. Measure: e2e.sh, uncached page times, then one cold start (stop the
# container; time until a new container restored the database and answers).
log "measure"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RES="$ROOT/deploy/results/$NAME-$STAMP.json"
W=$(mktemp -d)
E2E_EXIT=0
SPIKE_TOKEN=$SPIKE_TOKEN ADMIN_PASSWORD=$ADMIN_PASSWORD "$ROOT/spikes/b2-wordpress/e2e.sh" "$URL" > "$W/e2e" 2>&1 || E2E_EXIT=$?
B=$URL ADMIN_PASSWORD=$ADMIN_PASSWORD N=${N:-10} python3 "$ROOT/tests/a/bench.py" > "$W/bench" 2>&1 || true
# Cold start. _boot.txt holds an id that each container start writes, so a new
# id proves a new container.
BOOT0=$(curl -s -m 30 "$URL/_boot.txt" || true)
curl -s -m 60 -X POST -H "x-spike-token: $SPIKE_TOKEN" "$URL/_store-stop" > /dev/null || true
t0=$SECONDS; COLD_S=null
while [ $((SECONDS - t0)) -lt 300 ]; do
  b=$(curl -s -m 120 "$URL/_boot.txt" || true)
  if [ -n "$b" ] && [ "$b" != "$BOOT0" ] && [ ${#b} -eq 36 ]; then
    if START_TIMEOUT=300 wait_up > /dev/null; then COLD_S=$((SECONDS - t0)); fi
    break
  fi
  sleep 2
done
printf '{"instance_type": "%s", "php_workers": %s, "idle_seconds": %s, "first_start_s": %s, "cold_start_s": %s}\n' \
  "$INSTANCE_TYPE" "$PHP_WORKERS" "$IDLE_SECONDS" "$FIRST_START_S" "$COLD_S" > "$W/extra"
VARIANT=c1 python3 "$ROOT/deploy/summarize.py" "$RES" "$NAME" "$URL" "$LOCATION" "$E2E_EXIT" "$W"
rm -rf "$W"
echo "$URL  (admin; password: cd deploy/terraform && terraform workspace select $NAME && terraform output -raw admin_password)"
