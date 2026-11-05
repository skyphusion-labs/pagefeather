#!/bin/bash
# Remove everything tests/wfp/run.sh made: the namespace scripts, the three
# workers.dev Workers, then the namespace, D1 and R2 (Terraform).
#
#   CLOUDFLARE_API_TOKEN=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... ./tests/wfp/destroy.sh
#
# R2 refuses to delete a bucket that has objects. The tests delete their own
# objects; if one is left, empty the bucket first (deploy/variants/r2-empty.sh).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
H="$ROOT/tests/wfp"
TF="$H/terraform"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
out() { (cd "$TF" && terraform output -raw "$1"); }
(cd "$TF" && terraform init -input=false >/dev/null)
ACCOUNT_ID=$(out account_id); NS=$(out namespace); PREFIX=$(out prefix)
export CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID
api() { curl -sS -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") "$@"; }
# Namespace scripts: force, because they own Durable Object namespaces.
for s in tenant-a tenant-b tenant-c echo; do
  code=$(api -o /dev/null -w '%{http_code}' -X DELETE "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/dispatch/namespaces/$NS/scripts/$s?force=true")
  echo "namespace script $s: HTTP $code"
done
# workers.dev Workers, from a directory with no Wrangler config.
for w in "$PREFIX-dispatch" "$PREFIX-echo" "$PREFIX-outbound"; do
  (cd "$H" && npx wrangler delete "$w" --force) || echo "Worker $w not deleted (already deleted?)"
done
(cd "$TF" && terraform destroy -input=false -auto-approve)
