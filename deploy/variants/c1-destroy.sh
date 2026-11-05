# shellcheck shell=bash
# Remove a c1 site. destroy.sh sources this file; it uses ROOT, TF and NAME.
# Order: the container application (so no new container starts), the Worker,
# then the buckets are emptied (R2 refuses to delete a bucket with objects),
# then Terraform deletes the buckets, the Litestream key and the secrets.
#
# The database replica and the uploads are deleted. Nothing is kept.

C1="$ROOT/spikes/c1-woo-container"
CONF="$C1/wrangler.deploy.$NAME.toml"
[ -f "$TF/sites/$NAME.tfvars" ] || { echo "no sites/$NAME.tfvars: nothing in Terraform for $NAME"; exit 1; }
# Wrangler commands run in deploy/, which has no Wrangler config, so a
# command can never act on the spike's own wrangler.toml by mistake.
WR() { (cd "$ROOT/deploy" && npx wrangler "$@"); }

# 1. The container application. deploy.sh names it <NAME>-store.
# `containers list --json` prints a list of {id, name, ...} (Wrangler 4.107,
# appsToJsonOutput), first page only.
APPS=$(WR containers list --json)
APP_ID=$(printf '%s' "$APPS" | python3 -c '
import json, sys
s = sys.stdin.read()
items = json.loads(s[s.find("["):])
ids = [a.get("id") for a in items if a.get("name") == sys.argv[1]]
print(ids[0] if len(ids) == 1 else "")' "$NAME-store")
if [ -n "$APP_ID" ]; then
  WR containers delete "$APP_ID"
else
  echo "WARNING: no container application named $NAME-store in the first page of"
  echo "  wrangler containers list. If it exists, delete it: wrangler containers delete <id>"
fi

# 2. The Worker and its Durable Object namespace.
WR delete "$NAME" --force || echo "Worker $NAME not deleted (already deleted?)"

# 3. Empty the buckets. teardown=true gives the Litestream key the media
# bucket too, for this step only; the Worker and the container are gone.
tf() { (cd "$TF" && terraform "$@"); }
tf init -input=false -reconfigure >/dev/null
tf workspace select "$NAME" >/dev/null
tf apply -input=false -auto-approve -var-file="sites/$NAME.tfvars" -var teardown=true >/dev/null
EP=$(tf output -raw r2_endpoint)
R2_KEY_ID=$(tf output -raw litestream_access_key_id)
R2_SECRET=$(tf output -raw litestream_secret_access_key)
export R2_KEY_ID R2_SECRET
for b in "$(tf output -raw replica_bucket)" "$(tf output -raw media_bucket)"; do
  "$ROOT/deploy/variants/r2-empty.sh" "$EP" "$b"
done
unset R2_KEY_ID R2_SECRET

# 4. Terraform deletes the rest, then the workspace.
tf destroy -input=false -auto-approve -var-file="sites/$NAME.tfvars" -var teardown=true
tf workspace select default >/dev/null
tf workspace delete "$NAME"
rm -f "$TF/sites/$NAME.tfvars" "$CONF"
