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
APIPID=""
trap '[ -z "$APIPID" ] || kill "$APIPID" 2>/dev/null; rm -rf "${T:?}"' EXIT
mkdir -p "$T/deploy/terraform/.terraform" "$T/deploy/mysql/.terraform" "$T/spikes/b2-wordpress" "$T/bin"
cp "$SRC/destroy.sh" "$SRC/tf-backend.sh" "$T/deploy/"
cp -R "$SRC/variants" "$T/deploy/"
cp "$SRC"/terraform/*.tf "$SRC/terraform/.terraform.lock.hcl" "$T/deploy/terraform/"
cp "$SRC"/mysql/*.tf "$SRC"/mysql/*.tftpl "$T/deploy/mysql/"
ln -s "$SRC/terraform/.terraform/providers" "$T/deploy/terraform/.terraform/providers"
# npx: logs, and exits NPX_RC (default 0), like a wrangler delete that fails.
# shellcheck disable=SC2016 # the stub script, not shell to expand here
printf '#!/bin/bash\necho "$*" >> %q\nexit "${NPX_RC:-0}"\n' "$T/npx.log" > "$T/bin/npx"; chmod +x "$T/bin/npx"
# A stand-in for the Cloudflare API: GET .../workers/scripts/<name> answers the
# code in $T/api/<name> (default 404, gone).
mkdir -p "$T/api"
cat > "$T/fake-api.py" <<'PY'
import http.server, os, sys
root = sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        name = self.path.rstrip("/").rsplit("/", 1)[-1]
        f = os.path.join(root, name)
        code = int(open(f).read().strip()) if os.path.exists(f) else 404
        self.send_response(code); self.send_header("content-length", "2"); self.end_headers(); self.wfile.write(b"{}")
srv = http.server.HTTPServer(("127.0.0.1", 0), H)
open(sys.argv[1], "w").write(str(srv.server_address[1])); srv.serve_forever()
PY
python3 "$T/fake-api.py" "$T/api.port" "$T/api" & APIPID=$!
for _ in $(seq 1 50); do [ -s "$T/api.port" ] && break; sleep 0.1; done
CF_API="http://127.0.0.1:$(cat "$T/api.port")"
export CF_API
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
push site-g1 site-g1 b-do
push site-g2 site-g2 b-do
push site-g3 site-g3 b-do
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

# 6. wrangler delete fails, but the Worker is gone (as on wp-perf-dosql): go on.
NPX_RC=1 run site-g1
check "delete fails, Worker gone: destroyed" "$rc:$(grep -c 'exited 1' "$T/out"):$(grep -c 'is gone (API: 404)' "$T/out"):$(ws site-g1)" "0:1:1:0"

# 7. wrangler delete fails and the Worker is still there: stop, keep the data plane.
echo 200 > "$T/api/site-g2"
NPX_RC=1 run site-g2
check "delete fails, Worker still there: stopped" "$rc:$(grep -c 'STILL EXISTS (API: 200)' "$T/out")" "1:1"
check "delete fails, Worker still there: data plane kept" "$(ws site-g2)" "1"

# 8. The API gives no clear answer: stop.
echo 500 > "$T/api/site-g3"
run site-g3
check "API unclear: stopped, data plane kept" "$rc:$(grep -c 'cannot tell whether Worker site-g3 is gone (API: HTTP 500)' "$T/out"):$(ws site-g3)" "1:1:1"

[ "$fails" = 0 ] || { echo "$fails failed"; cat "$T/out"; exit 1; }
echo "all passed"
