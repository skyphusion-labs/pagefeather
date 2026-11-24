#!/bin/bash
# The plugin suite on approach B, Free and Paid. The 18 plugins do not fit in one
# Worker (64 MiB), so they go in groups: build with the group, precompile, deploy
# to both accounts, run tests/plugins/plugins.py for each plugin of the group.
# Usage: ./plugin-suite.sh [group-number ...]   (no number: all groups)
# ENGINE=a runs approach A (MySQL through Hyperdrive) instead of B: envs a-free and
# a-paid, OPcache primed against the local MariaDB (wp-a-local-mysql), results in a-*.jsonl.
# Needs: $CF_TESTING_TOKEN_FILE (default ~/.cf-testing.token, Free account),
# $WP_ON_D1_PAID_ENV / $WP_ON_D1_SPIKE_ENV (defaults under $HOME). For ENGINE=a,
# also $WP_A_LOCAL_ENV and $CLOUDFLARE_ENV_FILE (defaults under $HOME).
set -uo pipefail
cd "$(dirname "$0")"
# The pinned Wrangler (deploy/wr, #371), never a global one.
WR=${WR:-$(cd ../.. && pwd)/deploy/wr}
CF_TESTING_TOKEN_FILE="${CF_TESTING_TOKEN_FILE:-$HOME/.cf-testing.token}"
WP_ON_D1_PAID_ENV="${WP_ON_D1_PAID_ENV:-$HOME/.wp-on-d1-paid.env}"
WP_ON_D1_SPIKE_ENV="${WP_ON_D1_SPIKE_ENV:-$HOME/.wp-on-d1-spike.env}"
WP_A_LOCAL_ENV="${WP_A_LOCAL_ENV:-$HOME/.wp-a-local.env}"
CLOUDFLARE_ENV_FILE="${CLOUDFLARE_ENV_FILE:-$HOME/cloudflare-mcp.env}"
WP_A_FREE_ENV="${WP_A_FREE_ENV:-$HOME/.wp-a-free.env}"
WP_A_PAID_ENV="${WP_A_PAID_ENV:-$HOME/.wp-a-paid.env}"
GROUPS_=(
  "elementor"
  "jetpack"
  "wpforms-lite"
  "google-site-kit updraftplus"
  "wordfence wordpress-seo"
  "seo-by-rank-math wp-mail-smtp really-simple-ssl insert-headers-and-footers"
  "contact-form-7 classic-editor litespeed-cache akismet all-in-one-wp-migration duplicate-post duplicate-page"
)
FREE_URL=https://wp-on-d1-spike.vivijure-coldrun.workers.dev
PAID_URL=https://wp-on-d1-paid.skyphusion.workers.dev
PREFIX=b; DEPLOY_FREE=free; DEPLOY_PAID=paid; ENVF_FREE=$WP_ON_D1_SPIKE_ENV; ENVF_PAID=$WP_ON_D1_PAID_ENV
if [ "${ENGINE:-d1}" = a ]; then
  FREE_URL=https://wp-a-free.vivijure-coldrun.workers.dev
  PAID_URL=https://wp-a-paid.skyphusion.workers.dev
  PREFIX=a; DEPLOY_FREE=a-free; DEPLOY_PAID=a-paid; ENVF_FREE=$WP_A_FREE_ENV; ENVF_PAID=$WP_A_PAID_ENV
  set -a; . "$WP_A_LOCAL_ENV"; set +a
  export WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="mysql://wp:${LOCAL_MYSQL_PASSWORD}@127.0.0.1:3307/wordpress"
  export DEV_ENV=a-local
fi
out=../../tests/plugins/results; mkdir -p "$out"
sel=("$@"); [ ${#sel[@]} -gt 0 ] || sel=($(seq 1 ${#GROUPS_[@]}))
for g in "${sel[@]}"; do
  P=${GROUPS_[$((g-1))]}
  echo "== group $g: $P"
  WOO=0 PLUGINS="$P" ENGINE="${ENGINE:-d1}" ./build.sh | tail -2 || { echo "build failed"; continue; }
  # A: a fresh local database for each group, so OPcache priming starts from an install.
  [ "$PREFIX" != a ] || docker exec wp-a-local-mysql mariadb -uroot -p"$LOCAL_MYSQL_PASSWORD" -e "DROP DATABASE wordpress; CREATE DATABASE wordpress CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
  PLUGINS="$P" ./opcache.sh || { echo "group $g: opcache failed"; continue; }
  size=$(( $(wc -c < build/site.zip) + $(wc -c < build/opcache.zip) ))
  echo "group $g: site.zip + opcache.zip = $size bytes"
  for env in ${ENVS:-free paid}; do
    if [ $env = free ]; then
      dep=$(CLOUDFLARE_API_TOKEN=$(cat "$CF_TESTING_TOKEN_FILE") CLOUDFLARE_ACCOUNT_ID=32ce15b8adb82f5a85b67d6c46b28177 "$WR" deploy --env $DEPLOY_FREE 2>&1)
      url=$FREE_URL; envf=$ENVF_FREE
    else
      deployenv=$WP_ON_D1_PAID_ENV; [ "$PREFIX" != a ] || deployenv=$CLOUDFLARE_ENV_FILE
      dep=$( (set -a; . "$deployenv"; set +a; CLOUDFLARE_ACCOUNT_ID=fabcb25d9c7eb087110ec474a03e50d2 "$WR" deploy --env $DEPLOY_PAID) 2>&1)
      url=$PAID_URL; envf=$ENVF_PAID
    fi
    if ! grep -q 'Current Version ID' <<<"$dep"; then
      err=$(grep -iE 'error|exceed|limit' <<<"$dep" | head -3 | tr '\n' ' ' | cut -c1-300)
      for s in $P; do printf '{"plugin":"%s","target":"%s","error":"deploy refused","detail":%s,"bundle_bytes":%s}\n' "$s" "$url" "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$err")" "$size"; done >> "$out/$PREFIX-$env.jsonl"
      echo "group $g $env: deploy refused: $err"; continue
    fi
    echo "group $g $env: deployed $(grep -E 'Total Upload' <<<"$dep" | head -1)"
    sleep 10
    (set -a; . "$envf"; set +a; B=$url python3 ../../tests/plugins/plugins.py $P) | python3 -c "
import json,sys
for l in sys.stdin:
  r=json.loads(l); r['bundle_bytes']=$size; print(json.dumps(r), flush=True)" >> "$out/$PREFIX-$env.jsonl"
  done
done
