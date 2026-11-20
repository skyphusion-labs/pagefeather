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
# them: deploy/wr d1 export <name> --remote --output backup.sql
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# The pinned Wrangler. A test points WR at a stub.
WR=${WR:-$ROOT/deploy/wr}
TF="$ROOT/deploy/terraform"
APP="$ROOT/spikes/b2-wordpress"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}" "${ACCOUNT_ID:?set ACCOUNT_ID}" "${NAME:?set NAME}"
export CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID
# shellcheck source=SCRIPTDIR/tf-backend.sh
. "$ROOT/deploy/tf-backend.sh"
# shellcheck source=SCRIPTDIR/lib/gone-wait.sh
. "$ROOT/deploy/lib/gone-wait.sh"
W=$(mktemp -d "${TMPDIR:-/tmp}/wp-destroy.XXXXXX"); trap 'rm -rf "${W:?}"' EXIT

# The Worker: delete it, then ASK the API whether it is gone. wrangler
# delete can remove the Worker and still exit non-zero (wp-perf-dosql,
# 2026-11-06: it failed on a KV listing after the delete), and it can also
# fail with the Worker still there. So its exit status is reported as a fact,
# and the API decides: 404 is gone (go on), 200 is still there (stop before
# the data plane), anything else is unknown (stop). The API is read until it says 404, for up to
# GONE_WAIT_S (#789, deploy/lib/gone-wait.sh): a just-deleted Worker can read 200 for 30 s or more. CF_API exists
# for deploy/tests/destroy-test.sh.
CF_API=${CF_API:-https://api.cloudflare.com/client/v4}
worker_status() { # -> HTTP status of GET .../workers/scripts/NAME
  curl -s -o /dev/null -w '%{http_code}' -m 30 -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") "$CF_API/accounts/$ACCOUNT_ID/workers/scripts/$NAME" || echo 000
}
worker_gone_state() { gone_http_state "$(worker_status)"; }
delete_worker() { # delete_worker <command...>
  local rc=0
  "$@" || rc=$?
  echo "destroy: wrangler delete for $NAME exited $rc"
  if wait_gone worker_gone_state; then
    echo "destroy: Worker $NAME is gone (API: 404)$(gone_waited_note)"
    return 0
  fi
  case "$GONE_LAST" in
    200) echo "destroy: Worker $NAME STILL EXISTS (API: 200) after ${GONE_WAITED} s. Stopping before the data plane; delete it, then run this again." >&2 ;;
    *) echo "destroy: cannot tell whether Worker $NAME is gone (API: HTTP $GONE_LAST) after ${GONE_WAITED} s. Stopping before the data plane." >&2 ;;
  esac
  exit 1
}

# 1. Checks, before anything is deleted.
site_state "$TF"
site_name_matches "$TF"
VARS=$(site_vars "$TF" "$W/site.tfvars")
tfs() { (cd "$TF" && terraform workspace select "$NAME" >/dev/null && terraform "$@"); }
VARIANT=$(tfs output -raw variant)
# The account: the Worker delete and the API check use ACCOUNT_ID, so it must
# be the site's (wp-ref-free is on the Free test account, the others on Paid).
STATE_ACCOUNT=$(tfs output -raw account_id)
[ "$STATE_ACCOUNT" = "$ACCOUNT_ID" ] || { echo "destroy: ACCOUNT_ID is not the account of $NAME in its state ($STATE_ACCOUNT): refusing. Use that account's id and token." >&2; exit 1; }
echo "destroy: $NAME (variant $VARIANT, account $ACCOUNT_ID), variables from $VARS"
# The media bucket (MEDIA=1) is emptied with a temporary R2 credential that reaches only that bucket
# (#1031, the deploy/wfp path, #273: deploy/wfp/r2_temp.py). It is minted HERE, before anything is
# deleted, so a deploy token that cannot mint it stops the run with the site whole. Before #1031,
# step 3 made an account token (media-import.tf), which needs API Tokens Write, and the run stopped
# after the Worker was gone (cf759h, 2026-11-20). R2 Storage Write is enough for the mint.
BUCKET=$(tfs output -raw media_bucket)
R2_TTL=${R2_TEMP_TTL:-3600}
R2_CF="$W/r2-temp.cred"
# c1 empties its buckets with its own teardown key (variants/c1-destroy.sh): no mint there.
if [ -n "$BUCKET" ] && [ "$VARIANT" != c1 ]; then
  python3 -I "$ROOT/deploy/wfp/r2_temp.py" mint "$BUCKET" "$R2_TTL" "$R2_CF" || {
    echo "destroy: no temporary R2 credential for the media bucket $BUCKET (the deploy token needs Workers R2 Storage Write). Nothing was deleted." >&2; exit 1; }
fi
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
wr_delete() { (cd "$ROOT/deploy" && "$WR" delete --name "$NAME" --force); }
delete_worker wr_delete

# 3. The media bucket (MEDIA=1): R2 refuses to delete a bucket that has
# objects, so it is emptied first, with the temporary credential minted in step 1
# (object read and write on this bucket only). r2-empty.sh mints a fresh one on
# a refusal (it expires after R2_TEMP_TTL, default 3600 s, and cannot be revoked alone).
if [ -n "$BUCKET" ]; then
  R2_CRED_FILE=$R2_CF R2_CRED_REFRESH=$(printf 'python3 -I %q mint %q %q %q' "$ROOT/deploy/wfp/r2_temp.py" "$BUCKET" "$R2_TTL" "$R2_CF") \
    "$ROOT/deploy/variants/r2-empty.sh" "$(tfs output -raw r2_endpoint)" "$BUCKET"
fi

# 4. The data plane (the bucket, D1, Hyperdrive, the secrets, the key), then
# the workspace.
tfs destroy -input=false -auto-approve -var-file="$VARS"
(cd "$TF" && terraform workspace select default >/dev/null && terraform workspace delete "$NAME")
rm -f "$TF/sites/$NAME.tfvars" "$TF/sites/$NAME.apply.log" "$APP/wrangler.deploy.$NAME.toml"

# 5. The MySQL box (variant a with MYSQL=vultr).
if [ -n "$MYSQL_BOX" ]; then
  (cd "$M" && terraform workspace select "$NAME" >/dev/null && terraform destroy -input=false -auto-approve -var-file="$MVARS" && terraform workspace select default >/dev/null && terraform workspace delete "$NAME")
  rm -f "$M/sites/$NAME.tfvars"
fi
