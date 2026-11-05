# shellcheck shell=bash
# Variant c1: WordPress and WooCommerce in one Cloudflare Container
# (spikes/c1-woo-container, docs/approach-c1.md). Workers Paid only.
#
# deploy.sh sources this file after `terraform apply` and calls the steps in
# order (c1_main does all of them):
#   c1_build    WordPress, WooCommerce and the plugin suite into build/
#   c1_config   the Wrangler config from the Terraform outputs (sets CONF, PUBLIC_HOST)
#   c1_deploy   wrangler deploy with the secrets in the same version (sets URL,
#               SPIKE_TOKEN, ADMIN_PASSWORD)
#   c1_wait     wait for the rollout, stop the container once, wait for the
#               first 200 (sets FIRST_START_S)
#   c1_check    the Store object is from this deploy, and the running container
#               has its settings (the drop-in is there exactly when
#               OBJECT_CACHE=apcu); CHECK_WAIT (default 600 s)
#   c1_measure  e2e.sh, the page benchmark, one cold start -> deploy/results/
# The steps use ROOT, TF, NAME, ACCOUNT_ID, LOCATION, log and out from deploy.sh,
# and share the variables they set.
#
# Options: INSTANCE_TYPE (default standard-1), PHP_WORKERS (default from the
# instance type), IDLE_SECONDS (default 900), OBJECT_CACHE (none or apcu,
# default none), REPLICA_PATH (default store), PUBLIC_HOST (default
# <NAME>.<account subdomain>.workers.dev), ROLLOUT_WAIT (default 60 s),
# START_TIMEOUT (default 900 s), BENCH, N.

C1="$ROOT/spikes/c1-woo-container"
INSTANCE_TYPE=${INSTANCE_TYPE:-standard-1}
# PHP workers at 256 MB each. basic (1 GiB) dropped a connection with 4
# (docs/approach-c1.md); standard-1 (4 GiB) and standard-2 (6 GiB) were
# measured with 4 and 8.
case "$INSTANCE_TYPE" in basic) c1_w=2 ;; standard-1|standard) c1_w=4 ;; standard-2) c1_w=8 ;; *) c1_w=2 ;; esac
PHP_WORKERS=${PHP_WORKERS:-$c1_w}
IDLE_SECONDS=${IDLE_SECONDS:-900}
OBJECT_CACHE=${OBJECT_CACHE:-none}
REPLICA_PATH=${REPLICA_PATH:-store}

c1_build() {
  log "build (c1)"
  (cd "$C1" && { [ -d node_modules ] || npm ci --silent; } && ./build.sh | tail -1)
}

c1_config() {
  local replica media endpoint compat sub
  replica=$(out replica_bucket); media=$(out media_bucket); endpoint=$(out r2_endpoint)
  echo "replica bucket $replica, media bucket $media"
  # The site address goes into the Worker vars (WordPress uses it as its home
  # URL), so it must be known before the deploy: ask the API for the account's
  # workers.dev subdomain.
  if [ -z "${PUBLIC_HOST:-}" ]; then
    # The token goes to curl in a config on a pipe, not in the arguments (ps).
    sub=$(curl -sf -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/subdomain" \
      | python3 -c 'import json, sys; print(json.load(sys.stdin)["result"]["subdomain"])')
    PUBLIC_HOST="$NAME.$sub.workers.dev"
  fi
  # Next to wrangler.toml, so the relative paths are the same.
  CONF="$C1/wrangler.deploy.$NAME.toml"
  compat=$(sed -n 's/^compatibility_date = "\(.*\)"/\1/p' "$C1/wrangler.toml" | head -1)
  NAME=$NAME PUBLIC_HOST=$PUBLIC_HOST REPLICA=$replica MEDIA_BUCKET=$media R2_ENDPOINT=$endpoint \
    COMPAT=$compat INSTANCE_TYPE=$INSTANCE_TYPE PHP_WORKERS=$PHP_WORKERS IDLE_SECONDS=$IDLE_SECONDS OBJECT_CACHE=$OBJECT_CACHE REPLICA_PATH=$REPLICA_PATH \
    "$ROOT/deploy/variants/c1-config.sh" > "$CONF"
}

# The secrets go in the same version (--secrets-file): a container that starts
# between a deploy and a later `secret bulk` would install WordPress with no
# admin password and no salt.
c1_deploy() {
  local secrets dep rc=0
  log "deploy (c1, $INSTANCE_TYPE, $PHP_WORKERS PHP workers, object cache $OBJECT_CACHE, replica path $REPLICA_PATH)"
  secrets=$(mktemp); chmod 600 "$secrets"
  (cd "$TF" && terraform workspace select "$NAME" >/dev/null && terraform output -json) | python3 -c '
import json, sys
o = {k: v["value"] for k, v in json.load(sys.stdin).items()}
json.dump({"WP_SALT": o["wp_salt"], "ADMIN_PASSWORD": o["admin_password"], "SPIKE_TOKEN": o["spike_token"],
           "LITESTREAM_ACCESS_KEY_ID": o["litestream_access_key_id"],
           "LITESTREAM_SECRET_ACCESS_KEY": o["litestream_secret_access_key"]}, open(sys.argv[1], "w"))' "$secrets" || rc=$?
  [ "$rc" = 0 ] && { dep=$(cd "$C1" && npx wrangler deploy --config "$CONF" --secrets-file "$secrets" --containers-rollout immediate 2>&1) || rc=$?; }
  rm -f "$secrets"
  [ "$rc" = 0 ] || { echo "${dep:-}" | tail -30; return 1; }
  URL=$(echo "$dep" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
  echo "$dep" | grep -E 'Total Upload|Current Version' || true
  [ "$URL" = "https://$PUBLIC_HOST" ] || { echo "deployed to '$URL', but PUBLIC_HOST is $PUBLIC_HOST: WordPress would link to the wrong host" >&2; return 1; }
  SPIKE_TOKEN=$(out spike_token); ADMIN_PASSWORD=$(out admin_password)
}

# Print the seconds until GET / answers 200. ?nocache= keeps the edge page
# cache out of the answer.
c1_up() {
  local t0=$SECONDS code
  while :; do
    code=$(curl -s -o /dev/null -m 120 -w '%{http_code}' "$URL/?nocache=$RANDOM$RANDOM" || true)
    [ "$code" = 200 ] && { echo $((SECONDS - t0)); return 0; }
    [ $((SECONDS - t0)) -lt "${START_TIMEOUT:-900}" ] || { echo "no 200 from $URL/ after ${START_TIMEOUT:-900} s (last $code)" >&2; return 1; }
    sleep 5
  done
}

# A container that starts within about a minute of a deploy can run the old
# image (seen on the spike and on ggc). Wait, then stop the container once:
# the next request starts one from the new image. On a new site there is no
# container yet and the stop does nothing. The first container of a new site
# installs WordPress and WooCommerce (php/install.php); later containers
# restore the database from the replica.
c1_wait() {
  log "rollout: wait ${ROLLOUT_WAIT:-60} s, then stop the container once"
  sleep "${ROLLOUT_WAIT:-60}"
  # The answer says if a container was running (and was stopped) or not
  # (skipped). The token goes to curl in a config on a pipe, not in argv.
  curl -s -m 60 -X POST -K <(printf 'header = "x-spike-token: %s"\n' "$SPIKE_TOKEN") "$URL/_store-stop" \
    | python3 -c 'import json, sys
try:
    d = json.load(sys.stdin)
except ValueError:
    d = {}
print("no container was running: nothing to stop" if d.get("skipped") else "stop: %s" % json.dumps(d))' || true
  log "wait for WordPress"
  FIRST_START_S=$(c1_up)
  echo "first answer 200 after $FIRST_START_S s"
}

# A container can run the new image with the environment of the deploy before
# (seen twice on 2026-11-05 on wp-c1-perf: the drop-in did not match
# OBJECT_CACHE). The container gets its environment from the Store Durable
# Object, and a request on the new Worker can reach an object that still runs
# the code of the deploy before, "typically for seconds to minutes"
# (developers.cloudflare.com/durable-objects/platform/known-issues/). Two
# steps:
# 1. Wait (up to CHECK_WAIT, default 600 s) until /_store-info says the object
#    was built by this Worker version.
# 2. Then _stats.php must show the drop-in that OBJECT_CACHE asks for. If not,
#    the container is from the old object: stop it (the stop resets the object
#    too) and check the next one, once.
# Still wrong: fail, so no measurement runs on the wrong settings.
c1_info() {
  curl -s -m 60 -K <(printf 'header = "x-spike-token: %s"\n' "$SPIKE_TOKEN") "$URL$1" | python3 -c 'import json, sys
try:
    d = json.load(sys.stdin)
except ValueError:
    d = {}
k = sys.argv[1]
print(str(d.get(k)).lower() if k in d else "unknown", d.get("do_version") or "-", d.get("worker_version") or "-")' "$2"
}
c1_check() {
  local want cur got t0=$SECONDS try
  want=false; [ "$OBJECT_CACHE" = apcu ] && want=true
  while :; do
    cur=$(c1_info /_store-info current)
    [ "${cur%% *}" = true ] && break
    [ $((SECONDS - t0)) -lt "${CHECK_WAIT:-600}" ] || { echo "the Store object is not from this deploy after ${CHECK_WAIT:-600} s (current do worker: $cur)" >&2; return 1; }
    sleep 15
  done
  echo "Store object is from this deploy after $((SECONDS - t0)) s ($cur)"
  for try in 1 2; do
    got=$(c1_info "/_stats.php?what=info" drop_in); got=${got%% *}
    [ "$got" = "$want" ] && { echo "container settings ok on try $try (object cache drop-in: $got)"; return 0; }
    echo "try $try: drop-in $got, want $want (OBJECT_CACHE=$OBJECT_CACHE): the container is older than the object; stop it" >&2
    [ "$try" = 2 ] && break
    curl -s -m 60 -X POST -K <(printf 'header = "x-spike-token: %s"\n' "$SPIKE_TOKEN") "$URL/_store-stop" > /dev/null || true
    START_TIMEOUT=300 c1_up > /dev/null || return 1
  done
  echo "the container does not have this deploy's settings" >&2
  return 1
}

# e2e.sh, uncached page times, then one cold start: stop the container and time
# until a new container restored the database and answers. _boot.txt holds an
# id that each container start writes, so a new id proves a new container.
c1_measure() {
  local stamp res w e2e_exit=0 boot0 b t0 cold=null
  log "measure"
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  res="$ROOT/deploy/results/$NAME-$stamp.json"
  w=$(mktemp -d)
  SPIKE_TOKEN=$SPIKE_TOKEN ADMIN_PASSWORD=$ADMIN_PASSWORD "$ROOT/spikes/b2-wordpress/e2e.sh" "$URL" > "$w/e2e" 2>&1 || e2e_exit=$?
  B=$URL ADMIN_PASSWORD=$ADMIN_PASSWORD N=${N:-10} python3 "$ROOT/tests/a/bench.py" > "$w/bench" 2>&1 || true
  boot0=$(curl -s -m 30 "$URL/_boot.txt" || true)
  curl -s -m 60 -X POST -K <(printf 'header = "x-spike-token: %s"\n' "$SPIKE_TOKEN") "$URL/_store-stop" > /dev/null || true
  t0=$SECONDS
  while [ $((SECONDS - t0)) -lt 300 ]; do
    b=$(curl -s -m 120 "$URL/_boot.txt" || true)
    if [ -n "$b" ] && [ "$b" != "$boot0" ] && [ ${#b} -eq 36 ]; then
      if START_TIMEOUT=300 c1_up > /dev/null; then cold=$((SECONDS - t0)); fi
      break
    fi
    sleep 2
  done
  printf '{"instance_type": "%s", "php_workers": %s, "object_cache": "%s", "replica_path": "%s", "idle_seconds": %s, "first_start_s": %s, "cold_start_s": %s}\n' \
    "$INSTANCE_TYPE" "$PHP_WORKERS" "$OBJECT_CACHE" "$REPLICA_PATH" "$IDLE_SECONDS" "${FIRST_START_S:-null}" "$cold" > "$w/extra"
  VARIANT=c1 python3 "$ROOT/deploy/summarize.py" "$res" "$NAME" "$URL" "$LOCATION" "$e2e_exit" "$w"
  rm -rf "$w"
}

c1_main() {
  c1_build
  c1_config
  c1_deploy
  c1_wait
  c1_check
  [ "${BENCH:-1}" = 0 ] || c1_measure
  echo "$URL  (admin; password: cd deploy/terraform && terraform workspace select $NAME && terraform output -raw admin_password)"
}
