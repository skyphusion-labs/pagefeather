#!/bin/bash
# Remove a site made by deploy.sh: the Worker (and its PHP object), then the
# data plane (D1 with the site's data, the media bucket, the secrets, the
# Hyperdrive config) and, for variant a with MYSQL=vultr, the MySQL box.
#
#   CLOUDFLARE_API_TOKEN=... ACCOUNT_ID=... NAME=my-site ./deploy/destroy.sh
#
# The state is found as deploy.sh keeps it (deploy/tf-backend.sh): local in
# the clone that deployed the site, or DEPLOY_STATE=r2 (STATE_BUCKET,
# STATE_ENDPOINT and the R2 key) from any clone. Before anything is deleted:
# - the workspace NAME must exist (it is never made here);
# - the state's name output must be NAME, so a backend or a workspace that
#   points at another site is refused;
# - a backend_override.tf left by an earlier DEPLOY_STATE=r2 run is refused
#   when DEPLOY_STATE is not r2.
# Without deploy.sh's sites/<NAME>.tfvars in this clone, the variables come
# from the state's outputs. The Worker is deleted by name (it is NAME), so
# the clone's Wrangler config is not needed.
#
# The D1 database and all posts in it are deleted. Export first if you need
# them: npx wrangler d1 export <name> --remote --output backup.sql
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TF="$ROOT/deploy/terraform"
APP="$ROOT/spikes/b2-wordpress"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}" "${ACCOUNT_ID:?set ACCOUNT_ID}" "${NAME:?set NAME}"
export CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID
# shellcheck source=SCRIPTDIR/tf-backend.sh
. "$ROOT/deploy/tf-backend.sh"
W=$(mktemp -d "${TMPDIR:-/tmp}/wp-destroy.XXXXXX"); trap 'rm -rf "${W:?}"' EXIT

# 1. Checks, before anything is deleted.
site_state "$TF"
site_name_matches "$TF"
VARS=$(site_vars "$TF" "$W/site.tfvars")
tfs() { (cd "$TF" && terraform workspace select "$NAME" >/dev/null && terraform "$@"); }
VARIANT=$(tfs output -raw variant)
echo "destroy: $NAME (variant $VARIANT), variables from $VARS"
# Variant a with MYSQL=vultr: its box has its own Terraform root. Check it now
# too, so the run does not stop halfway.
M="$ROOT/deploy/mysql"
MYSQL_BOX=""
if [ "$VARIANT" = a ]; then
  if ! site_state "$M" 2> "$W/mysql-state.err"; then
    # Variant a on an external MySQL (a2, PlanetScale) has no box: that is fine.
    # Any other reason is said, so a box is never left running silently.
    echo "destroy: no deploy/mysql state for $NAME selected ($(tr '\n' ' ' < "$W/mysql-state.err")). If this site has a MYSQL=vultr box, it is NOT removed by this run." >&2
  elif (cd "$M" && terraform output -raw host >/dev/null 2>&1); then
    MYSQL_BOX=1
    : "${VULTR_API_KEY:?set VULTR_API_KEY to remove the MySQL box}"
    if [ -f "$M/sites/$NAME.tfvars" ]; then
      MVARS="$M/sites/$NAME.tfvars"
    else
      # zone_id is no output of deploy/mysql: it must come from the caller.
      : "${MYSQL_ZONE_ID:?no deploy/mysql/sites/$NAME.tfvars here: set MYSQL_ZONE_ID and MYSQL_HOST as for deploy.sh}" "${MYSQL_HOST:?set MYSQL_HOST}"
      MVARS="$W/mysql.tfvars"
      printf 'name = "%s"\nzone_id = "%s"\nhostname = "%s"\n' "$NAME" "$MYSQL_ZONE_ID" "$MYSQL_HOST" > "$MVARS"
    fi
  fi
fi

# Variant c1 (Container) has its own steps: container, Worker, buckets.
if [ "$VARIANT" = c1 ]; then
  # shellcheck source=SCRIPTDIR/variants/c1-destroy.sh
  . "$ROOT/deploy/variants/c1-destroy.sh"
  exit 0
fi

# 2. The Worker (named NAME by deploy.sh) and its PHP object. Run in deploy/,
# which has no Wrangler config, so no other config can be used by mistake.
(cd "$ROOT/deploy" && npx wrangler delete --name "$NAME" --force) || echo "Worker $NAME not deleted (already deleted?)"

# 3. The data plane, then the workspace.
tfs destroy -input=false -auto-approve -var-file="$VARS"
(cd "$TF" && terraform workspace select default >/dev/null && terraform workspace delete "$NAME")
rm -f "$TF/sites/$NAME.tfvars" "$TF/sites/$NAME.apply.log" "$APP/wrangler.deploy.$NAME.toml"

# 4. The MySQL box (variant a with MYSQL=vultr).
if [ -n "$MYSQL_BOX" ]; then
  (cd "$M" && terraform workspace select "$NAME" >/dev/null && terraform destroy -input=false -auto-approve -var-file="$MVARS" && terraform workspace select default >/dev/null && terraform workspace delete "$NAME")
  rm -f "$M/sites/$NAME.tfvars"
fi
