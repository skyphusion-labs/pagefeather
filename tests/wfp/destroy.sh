#!/bin/bash
# Remove everything tests/wfp/run.sh, dosql.sh and container-app.sh made: the
# container applications and the control's image, the namespace scripts, the workers.dev Workers, then
# the namespace, D1, R2 and the secrets (Terraform). Every name is exact: no
# glob, nothing that is not in this list. SITES names the dosql.sh sites
# (default wp-dosql).
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
B="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID"
# The b-dosql sites of dosql.sh (SITE names; default wp-dosql).
SITES=${SITES:-wp-dosql}

# The image the control's application runs, for the log. Wrangler gives the
# application the image by DIGEST (registry.cloudflare.com/<account>/
# <prefix>-cdirect-box@sha256:...), not by tag (measured 2026-11-06, #43).
APPS_JSON=$(api "$B/containers/applications")
IMAGE=$(printf '%s' "$APPS_JSON" | python3 -c '
import json, sys
m = [((a.get("configuration") or {}).get("image") or "") for a in json.load(sys.stdin).get("result") or [] if a.get("name") == sys.argv[1]]
print(m[0] if len(m) == 1 else "")' "$PREFIX-cdirect-box")

# 1. Container applications first, so nothing starts a container. By id from
# the API, for these exact names only: tenant-c-box (container-app.sh) and
# <prefix>-cdirect-box (the control, made by Wrangler).
printf '%s' "$APPS_JSON" | python3 -c '
import json, sys
names = set(sys.argv[1:])
for a in json.load(sys.stdin).get("result") or []:
    if a.get("name") in names:
        print(a["id"], a["name"])' tenant-c-box "$PREFIX-cdirect-box" | while read -r id name; do
  code=$(api -o /dev/null -w '%{http_code}' -X DELETE "$B/containers/applications/$id")
  echo "container application $name ($id): HTTP $code"
done

# 1b. The control's image repository, <prefix>-cdirect-box: Wrangler named it
# after our control Worker when run.sh deployed it, so it is ours. Its tags
# come from the account's registry listing (exact name only; the listing is
# for this account only), and each is deleted as <name>:<tag>. The
# application's own reference is a digest, which "images delete" does not
# take: the first version of this step skipped the image (#43).
echo "control image (from its application): ${IMAGE:-none}"
TAGS=$( (cd "$H" && "$ROOT/deploy/wr" containers images list --json 2>/dev/null) | python3 -c '
import json, re, sys
s = sys.stdin.read()
i = s.find("[")
if i < 0:
    sys.exit(2)
for r in json.loads(s[i:]):
    if r.get("name") == sys.argv[1]:
        for t in r.get("tags") or []:
            if re.fullmatch(r"[A-Za-z0-9._-]+", t):
                print(t)' "$PREFIX-cdirect-box") || TAGS="LIST-FAILED"
if [ "$TAGS" = "LIST-FAILED" ]; then
  echo "could not list the registry: image $PREFIX-cdirect-box not deleted (list.sh shows it)"
elif [ -z "$TAGS" ]; then
  echo "no image $PREFIX-cdirect-box in the registry"
else
  for t in $TAGS; do
    (cd "$H" && "$ROOT/deploy/wr" containers images delete "$PREFIX-cdirect-box:$t" -y) || echo "image $PREFIX-cdirect-box:$t not deleted"
  done
fi

# 2. Namespace scripts: force, because they own Durable Object namespaces.
for s in tenant-a tenant-b tenant-c echo $SITES; do
  code=$(api -o /dev/null -w '%{http_code}' -X DELETE "$B/workers/dispatch/namespaces/$NS/scripts/$s?force=true")
  echo "namespace script $s: HTTP $code"
done

# 3. workers.dev Workers, from a directory with no Wrangler config.
WORKERS=("$PREFIX-dispatch" "$PREFIX-echo" "$PREFIX-outbound" "$PREFIX-cdirect")
for s in $SITES; do WORKERS+=("$PREFIX-site-$s"); done
for w in "${WORKERS[@]}"; do
  (cd "$H" && "$ROOT/deploy/wr" delete "$w" --force) || echo "Worker $w not deleted (already deleted?)"
done

# 4. The namespace, D1, R2 and the secrets.
(cd "$TF" && terraform destroy -input=false -auto-approve)

# 5. Check from the API that every name is gone (list.sh exits 1 if not).
PREFIX=$PREFIX NS=$NS SITES=$SITES ACCOUNT_ID=$ACCOUNT_ID "$H/list.sh"
