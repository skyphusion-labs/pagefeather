#!/bin/bash
# Remove a site made by deploy.sh: the Worker (and its PHP object), then the
# data plane (D1 with the site's data, the media bucket, the secrets, the
# Hyperdrive config) and, for variant a with MYSQL=vultr, the MySQL box.
#
#   CLOUDFLARE_API_TOKEN=... ACCOUNT_ID=... NAME=my-site ./deploy/destroy.sh
#
# The D1 database and all posts in it are deleted. Export first if you need
# them: npx wrangler d1 export <name> --remote --output backup.sql
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TF="$ROOT/deploy/terraform"
APP="$ROOT/spikes/b2-wordpress"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}" "${ACCOUNT_ID:?set ACCOUNT_ID}" "${NAME:?set NAME}"
export CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID
# Variant c1 (Container) has its own steps: container, Worker, buckets.
VARIANT=$(sed -n 's/^variant *= *"\(.*\)"$/\1/p' "$TF/sites/$NAME.tfvars" 2>/dev/null || true)
if [ "$VARIANT" = c1 ]; then
  . "$ROOT/deploy/variants/c1-destroy.sh"
  exit 0
fi
CONF="$APP/wrangler.deploy.$NAME.toml"
[ -f "$CONF" ] && (cd "$APP" && npx wrangler delete --config "$CONF" --force) || echo "no Wrangler config for $NAME; Worker not removed"
[ -f "$TF/sites/$NAME.tfvars" ] || { echo "no sites/$NAME.tfvars: nothing in Terraform for $NAME"; exit 1; }
(cd "$TF" && terraform init -input=false -reconfigure >/dev/null && terraform workspace select "$NAME" && terraform destroy -input=false -auto-approve -var-file="sites/$NAME.tfvars" && terraform workspace select default && terraform workspace delete "$NAME")
rm -f "$TF/sites/$NAME.tfvars" "$TF/sites/$NAME.apply.log" "$CONF"
# Variant a with MYSQL=vultr: the database box (its own Terraform root).
M="$ROOT/deploy/mysql"
if [ -f "$M/sites/$NAME.tfvars" ]; then
  : "${VULTR_API_KEY:?set VULTR_API_KEY to remove the MySQL box}"
  (cd "$M" && terraform init -input=false -reconfigure >/dev/null && terraform workspace select "$NAME" && terraform destroy -input=false -auto-approve -var-file="sites/$NAME.tfvars" && terraform workspace select default && terraform workspace delete "$NAME")
  rm -f "$M/sites/$NAME.tfvars"
fi
