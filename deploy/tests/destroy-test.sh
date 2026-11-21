#!/bin/bash
# Offline tests of deploy/destroy.sh's checks (local state, no Cloudflare).
#   deploy/tests/destroy-test.sh [another destroy.sh]
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
R2PID=""
trap '[ -z "$APIPID" ] || kill "$APIPID" 2>/dev/null; [ -z "$R2PID" ] || kill "$R2PID" 2>/dev/null; rm -rf "${T:?}"' EXIT
mkdir -p "$T/deploy/terraform/.terraform" "$T/deploy/mysql/.terraform" "$T/spikes/b2-wordpress" "$T/bin"
cp "${1:-$SRC/destroy.sh}" "$T/deploy/destroy.sh"; chmod +x "$T/deploy/destroy.sh"; cp "$SRC/tf-backend.sh" "$T/deploy/"
# #1031: the media bucket is emptied with a temporary R2 credential (the deploy/wfp minter).
mkdir -p "$T/deploy/wfp" && cp "$SRC/wfp/r2_temp.py" "$T/deploy/wfp/"
mkdir -p "$T/deploy/lib" && cp "$SRC/lib/gone-wait.sh" "$T/deploy/lib/"  # #789: the bounded gone check
cp "$SRC/lib/custom-domain.sh" "$T/deploy/lib/"  # #1262: the custom-domain detach before the Worker delete
cp -R "$SRC/variants" "$T/deploy/"
# #1196: copy the Terraform files WITHOUT any *_override.tf. A real deploy with DEPLOY_STATE=r2 leaves a gitignored
# deploy/terraform/backend_override.tf (the R2 state backend); copied in, it made this test init an S3 backend with no
# credentials and fail in any clone that had deployed. A local deploy's state must never reach this test.
copy_tf() { # copy_tf <src dir> <dst dir> <glob...>: every match except *_override.tf
  local src=$1 dst=$2 f; shift 2
  for f in "$@"; do for f in "$src"/$f; do case "$f" in *_override.tf) ;; *) [ -e "$f" ] && cp "$f" "$dst/" ;; esac; done; done
}
copy_tf "$SRC/terraform" "$T/deploy/terraform" '*.tf' .terraform.lock.hcl
copy_tf "$SRC/mysql" "$T/deploy/mysql" '*.tf' '*.tftpl'
ln -s "$SRC/terraform/.terraform/providers" "$T/deploy/terraform/.terraform/providers"
# #1196 guard: copy_tf must leave out a planted backend_override.tf (and keep the real files).
mkdir -p "$T/ct-src" "$T/ct-dst"; : > "$T/ct-src/main.tf"; : > "$T/ct-src/backend_override.tf"; : > "$T/ct-src/x_override.tf"
copy_tf "$T/ct-src" "$T/ct-dst" '*.tf'
[ -e "$T/ct-dst/main.tf" ] && [ ! -e "$T/ct-dst/backend_override.tf" ] && [ ! -e "$T/ct-dst/x_override.tf" ] \
  || { echo "FAIL #1196: copy_tf copied an *_override.tf (or dropped a real .tf)"; exit 1; }
echo "ok   #1196 copy_tf leaves out *_override.tf"
[ ! -e "$T/deploy/terraform/backend_override.tf" ] || { echo "FAIL #1196: backend_override.tf reached the test's terraform dir"; exit 1; }
# The pinned Wrangler (WR): logs, and exits NPX_RC (default 0), like a wrangler delete that fails.
# shellcheck disable=SC2016 # the stub script, not shell to expand here
printf '#!/bin/bash\necho "$*" >> %q\nexit "${NPX_RC:-0}"\n' "$T/npx.log" > "$T/bin/wr"; chmod +x "$T/bin/wr"
# A stand-in for the Cloudflare API: GET .../workers/scripts/<name> answers the
# code in $T/api/<name> (default 404, gone). A comma list is a SEQUENCE (#789): each GET takes the
# next code, and the last one repeats, as a just-deleted Worker that reads 200 for a while, then 404.
mkdir -p "$T/api"
cat > "$T/fake-api.py" <<'PY'
import http.server, os, sys
root = sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if "/workers/domains" in self.path:  # #1262: no custom domain on a test site
            body = b'{"success":true,"result":[]}'
            self.send_response(200); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body); return
        name = self.path.rstrip("/").rsplit("/", 1)[-1]
        f = os.path.join(root, name)
        code = 404
        if os.path.exists(f):
            seq = [c for c in open(f).read().strip().split(",") if c]
            code = int(seq[0])
            if len(seq) > 1:
                open(f, "w").write(",".join(seq[1:]))
        self.send_response(code); self.send_header("content-length", "2"); self.end_headers(); self.wfile.write(b"{}")
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
open(sys.argv[1], "w").write(str(srv.server_address[1])); srv.serve_forever()
PY
python3 "$T/fake-api.py" "$T/api.port" "$T/api" & APIPID=$!
for _ in $(seq 1 50); do [ -s "$T/api.port" ] && break; sleep 0.1; done
CF_API="http://127.0.0.1:$(cat "$T/api.port")"
# #1031: the R2 temporary credential API and R2's S3 API (deploy/wfp/tests/fake-r2-temp.py).
python3 -I "$SRC/wfp/tests/fake-r2-temp.py" "$T/r2.port" & R2PID=$!
for _ in $(seq 1 50); do [ -s "$T/r2.port" ] && break; sleep 0.1; done
R2="http://127.0.0.1:$(cat "$T/r2.port")"
export WFP_API="$R2/api" R2_RETRY_S=2 R2_RETRY_STEP=0.2
export CF_API
export WR="$T/bin/wr" PATH="$T/bin:$PATH" CLOUDFLARE_API_TOKEN=test ACCOUNT_ID=00000000000000000000000000000000
# #789: the gone check polls up to GONE_WAIT_S; short here, so a Worker that never goes fails in seconds.
export GONE_WAIT_S=3 GONE_POLL_S=0.2
unset DEPLOY_STATE
fails=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }
TFD="$T/deploy/terraform"
(cd "$TFD" && terraform init -input=false -backend=false > /dev/null && terraform init -input=false -reconfigure > /dev/null)
TV=$(terraform version -json | python3 -c 'import json,sys; print(json.load(sys.stdin)["terraform_version"])')
push() { # workspace name-output variant [media bucket]
  (cd "$TFD" && terraform workspace new "$1" > /dev/null && python3 -c '
import json, sys, uuid
o = {"name": sys.argv[2], "variant": sys.argv[3], "account_id": "0" * 32, "location": "enam", "media_bucket": sys.argv[4], "r2_endpoint": sys.argv[5]}
print(json.dumps({"version": 4, "terraform_version": sys.argv[1], "serial": 1, "lineage": str(uuid.uuid4()),
  "outputs": {k: {"value": v, "type": "string"} for k, v in o.items()}, "resources": []}))' "$TV" "$2" "$3" "${4:-}" "$R2" > "$T/state.json" && terraform state push "$T/state.json" > /dev/null && terraform workspace select default > /dev/null)
}
push site-x site-x b-do
push site-y site-z b-do
push site-a site-a a
push site-g1 site-g1 b-do
push site-g2 site-g2 b-do
push site-g3 site-g3 b-do
push site-g4 site-g4 b-do
push site-g5 site-g5 b-do
push site-m1 site-m1 b-do site-m1-media
push site-m2 site-m2 b-do site-m2-media
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
check "good: the Worker deleted by name" "$(cat "$T/npx.log")" "delete --name site-x --force"
check "good: workspace gone" "$(ws site-x)" "0"

# 5. Variant a with no deploy/mysql state: said, not silent.
run site-a
check "variant a, no MySQL state: destroyed, and said" "$rc:$(grep -c 'is NOT removed by this run' "$T/out")" "0:1"

# 5b. ACCOUNT_ID is not the account in the state (the Free test account case).
push site-acct site-acct b-do
: > "$T/npx.log"; set +e; NAME=site-acct ACCOUNT_ID=11111111111111111111111111111111 "$T/deploy/destroy.sh" > "$T/out" 2>&1; rc=$?; set -e
check "another account: refused, nothing deleted" "$rc:$(grep -c 'is not the account of site-acct' "$T/out"):$(wc -l < "$T/npx.log" | tr -d ' '):$(ws site-acct)" "1:1:0:1"

# 6. wrangler delete fails, but the Worker is gone (as on wp-perf-dosql): go on.
NPX_RC=1 run site-g1
check "delete fails, Worker gone: destroyed" "$rc:$(grep -c 'exited 1' "$T/out"):$(grep -c 'is gone (API: 404)' "$T/out"):$(ws site-g1)" "0:1:1:0"

# 7. wrangler delete fails and the Worker is still there: stop, keep the data plane.
echo 200 > "$T/api/site-g2"
NPX_RC=1 run site-g2
check "delete fails, Worker still there: stopped" "$rc:$(grep -c 'STILL EXISTS (API: 200)' "$T/out")" "1:1"
[ "$(grep -c 'STILL EXISTS (API: 200)' "$T/out")" = 1 ] || { echo "--- out of case 7:"; cat "$T/out"; }
check "delete fails, Worker still there: data plane kept" "$(ws site-g2)" "1"

# 8. The API gives no clear answer: stop.
echo 500 > "$T/api/site-g3"
run site-g3
check "API unclear: stopped, data plane kept" "$rc:$(grep -c 'cannot tell whether Worker site-g3 is gone (API: HTTP 500)' "$T/out"):$(ws site-g3)" "1:1:1"

# 9. (#789) A just-deleted Worker reads 200 for a while, then 404 (pf755f, 2026-11-16: "STILL EXISTS", then 404
#    on a retry 30 s later): the check polls, and the destroy goes on.
echo 200,200,404 > "$T/api/site-g4"
run site-g4
check "#789 the Worker reads 200 twice, then 404: the check waits, and the destroy goes on" "$rc:$(grep -c 'is gone (API: 404)' "$T/out"):$(ws site-g4)" "0:1:0"
# 10. (#789) An unreadable answer (5xx) is never gone; it is retried within the cap.
echo 503,404 > "$T/api/site-g5"
run site-g5
check "#789 a 503, then 404: retried, never taken as gone, then gone" "$rc:$(grep -c 'is gone (API: 404)' "$T/out"):$(ws site-g5)" "0:1:0"

# 11. (#1031) A site with a media bucket: emptied with a temporary R2 credential minted from the deploy
#     token, never an account token (API Tokens Write). Measured before #1031 on cf759h (2026-11-20):
#     the Worker was deleted, then the token mint answered 403 9109, and the run stopped half done.
for k in uploads/a.jpg uploads/b.jpg; do curl -s -o /dev/null -X PUT --data x "$R2/_seed/site-m1-media/$k"; done
check "#1031   control: the bucket holds 2 objects before the run" "$(python3 -I -c 'import json, sys, urllib.request; d = json.load(urllib.request.urlopen(sys.argv[1] + "/_state")); print(len([o for o in d["objects"] if o.lstrip("/").startswith("site-m1-media/")]))' "$R2")" "2"
run site-m1
check "#1031 media bucket: destroyed" "$rc" "0"
check "#1031   one temporary credential, for that bucket only" "$(python3 -I -c 'import json, sys, urllib.request; d = json.load(urllib.request.urlopen(sys.argv[1] + "/_state")); print(len(d["mints"]), sorted({m["bucket"] for m in d["mints"]}))' "$R2")" "1 ['site-m1-media']"
check "#1031   the bucket is empty" "$(python3 -I -c 'import json, sys, urllib.request; d = json.load(urllib.request.urlopen(sys.argv[1] + "/_state")); print(len([o for o in d["objects"] if o.lstrip("/").startswith("site-m1-media/")]))' "$R2")" "0"
check "#1031   the Worker deleted, the workspace gone" "$(cat "$T/npx.log"):$(ws site-m1)" "delete --name site-m1 --force:0"
# 12. (#1031) The deploy token cannot mint the credential: refused BEFORE anything is deleted.
curl -s -o /dev/null -X POST "$R2/_refuse_mint"
run site-m2
check "#1031 mint refused: stopped, nothing deleted" "$rc:$(grep -c 'Nothing was deleted' "$T/out"):$(wc -l < "$T/npx.log" | tr -d ' '):$(ws site-m2)" "1:1:0:1"

[ "$fails" = 0 ] || { echo "$fails failed"; cat "$T/out"; exit 1; }
echo "all passed"
