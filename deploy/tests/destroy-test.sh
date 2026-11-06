#!/bin/bash
# Offline tests of deploy/destroy.sh's checks (local state, no Cloudflare).
#   deploy/tests/destroy-test.sh
# A copy of deploy/ in a temp dir; the cloudflare provider from this clone's
# deploy/terraform/.terraform (run terraform init there once); npx is a stub
# that logs. The states are pushed with outputs only (no resources), so
# terraform destroy has nothing to call.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$(cd "$HERE/.." && pwd)
[ -d "$SRC/terraform/.terraform/providers" ] || { echo "run terraform init in deploy/terraform first (the provider)" >&2; exit 2; }
T=$(mktemp -d "${TMPDIR:-/tmp}/destroy-test.XXXXXX")
trap 'rm -rf "${T:?}"' EXIT
mkdir -p "$T/deploy/terraform/.terraform" "$T/deploy/mysql/.terraform" "$T/spikes/b2-wordpress" "$T/bin"
cp "$SRC/destroy.sh" "$SRC/tf-backend.sh" "$T/deploy/"
cp -R "$SRC/variants" "$T/deploy/"
cp "$SRC"/terraform/*.tf "$SRC/terraform/.terraform.lock.hcl" "$T/deploy/terraform/"
cp "$SRC"/mysql/*.tf "$SRC"/mysql/*.tftpl "$T/deploy/mysql/"
ln -s "$SRC/terraform/.terraform/providers" "$T/deploy/terraform/.terraform/providers"
printf '#!/bin/bash\necho "$*" >> %q\n' "$T/npx.log" > "$T/bin/npx"; chmod +x "$T/bin/npx"
export PATH="$T/bin:$PATH" CLOUDFLARE_API_TOKEN=test ACCOUNT_ID=00000000000000000000000000000000
unset DEPLOY_STATE
fails=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }
TFD="$T/deploy/terraform"
(cd "$TFD" && terraform init -input=false -backend=false > /dev/null && terraform init -input=false -reconfigure > /dev/null)
TV=$(terraform version -json | python3 -c 'import json,sys; print(json.load(sys.stdin)["terraform_version"])')
push() { # workspace name-output variant
  (cd "$TFD" && terraform workspace new "$1" > /dev/null && python3 -c '
import json, sys, uuid
o = {"name": sys.argv[2], "variant": sys.argv[3], "account_id": "0" * 32, "location": "enam", "media_bucket": ""}
print(json.dumps({"version": 4, "terraform_version": sys.argv[1], "serial": 1, "lineage": str(uuid.uuid4()),
  "outputs": {k: {"value": v, "type": "string"} for k, v in o.items()}, "resources": []}))' "$TV" "$2" "$3" > "$T/state.json" && terraform state push "$T/state.json" > /dev/null && terraform workspace select default > /dev/null)
}
push site-x site-x b-do
push site-y site-z b-do
push site-a site-a a
run() { : > "$T/npx.log"; set +e; NAME=$1 "$T/deploy/destroy.sh" > "$T/out" 2>&1; rc=$?; set -e; }
ws() { (cd "$TFD" && terraform workspace list | tr -d ' *' | grep -cx "$1" || true); }

# 1. Red control: a stale override from another site's r2 run, local mode.
printf 'terraform {\n  backend "s3" {\n    bucket = "state"\n    key = "deploy/other-site/terraform.tfstate"\n    region = "auto"\n  }\n}\n' > "$TFD/backend_override.tf"
run site-x
check "stale override: refused" "$rc:$(grep -c 'backend_override.tf exists' "$T/out")" "1:1"
npx_calls=$(wc -l < "$T/npx.log" | tr -d ' ')
rm "$TFD/backend_override.tf"
check "stale override: nothing deleted" "$npx_calls:$(ws site-x)" "0:1"

# 2. The state for NAME says another name.
run site-y
check "name mismatch: refused" "$rc:$(grep -c "says name='site-z': refusing" "$T/out")" "1:1"
check "name mismatch: nothing deleted" "$(wc -l < "$T/npx.log" | tr -d ' '):$(ws site-y)" "0:1"

# 3. No workspace for NAME: never made.
run nope
check "no workspace: refused" "$rc:$(grep -c 'no Terraform state for nope in this clone' "$T/out")" "1:1"
check "no workspace: none made" "$(ws nope)" "0"

# 4. A good site, no sites/<NAME>.tfvars in this clone.
run site-x
check "good: destroyed" "$rc" "0"
check "good: variables from the state outputs" "$(grep -c 'variables from .*/site.tfvars' "$T/out")" "1"
check "good: the Worker deleted by name" "$(cat "$T/npx.log")" "wrangler delete --name site-x --force"
check "good: workspace gone" "$(ws site-x)" "0"

# 5. Variant a with no deploy/mysql state: said, not silent.
run site-a
check "variant a, no MySQL state: destroyed, and said" "$rc:$(grep -c 'is NOT removed by this run' "$T/out")" "0:1"

[ "$fails" = 0 ] || { echo "$fails failed"; cat "$T/out"; exit 1; }
echo "all passed"
