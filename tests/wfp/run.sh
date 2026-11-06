#!/bin/bash
# Workers for Platforms spike (issue #35): make the namespace and the test data
# plane (Terraform), upload the test Workers (Wrangler), then collect evidence
# (check.py) and the dispatch hop latency (latency.py).
#
#   CLOUDFLARE_API_TOKEN=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... ./tests/wfp/run.sh
#
# Options: CONTAINER=1 (also the container test: tests/wfp/user-container as
# tenant-c in the namespace, its container application through the API, and
# the same Worker as a normal Worker, <prefix>-cdirect, as the control),
# CONTAINER_IMAGE (default: build tests/wfp/user-container/Dockerfile, see
# below; or an image reference to use for both), BOX_PORT (the port the image
# listens on; default 8080 for the built image, else 80), LATENCY_N (default
# 100; 0 skips).
#
# The built image: an image cannot be pushed to the account registry on its
# own ("push access denied ... insufficient_scope", 2026-11-06, issue #43); a
# new repository is made when Wrangler deploys a normal Worker with that
# Dockerfile. So the control <prefix>-cdirect is deployed FIRST (Wrangler builds
# and pushes <prefix>-cdirect-box:<tag>; this needs Docker), its image is read
# from its container application, and tenant-c's application uses that image.
#
# Every upload is a result: a failed upload is recorded in the result file and
# the script goes on. Everything is on workers.dev; no zone is routed.
# Output: tests/wfp/results/wfp-<time>.json
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
H="$ROOT/tests/wfp"
TF="$H/terraform"
GEN="$H/gen"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
log() { printf '\n== %s\n' "$*"; }
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RES="$H/results/wfp-$STAMP.json"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
mkdir -p "$GEN" "$H/results"

log "terraform: namespace, D1, R2"
(cd "$TF" && terraform init -input=false >/dev/null && terraform apply -input=false -auto-approve >/dev/null)
out() { (cd "$TF" && terraform output -raw "$1"); }
ACCOUNT_ID=$(out account_id); NS=$(out namespace); D1_ID=$(out d1_id); D1_NAME=$(out d1_name); R2=$(out r2_bucket); PREFIX=$(out prefix)
export CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID
SUB=$(curl -sf -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/subdomain" \
  | python3 -c 'import json, sys; print(json.load(sys.stdin)["result"]["subdomain"])')
COMPAT=2026-07-01
echo "namespace $NS, D1 $D1_NAME, R2 $R2, workers.dev subdomain $SUB"

# Wrangler configs (gitignored). Paths are relative to the config file.
cat > "$GEN/outbound.toml" <<TOML
name = "$PREFIX-outbound"
main = "../outbound/worker.js"
compatibility_date = "$COMPAT"
workers_dev = true
TOML
cat > "$GEN/echo-direct.toml" <<TOML
name = "$PREFIX-echo"
main = "../echo/worker.js"
compatibility_date = "$COMPAT"
workers_dev = true
TOML
cat > "$GEN/echo-user.toml" <<TOML
name = "echo"
main = "../echo/worker.js"
compatibility_date = "$COMPAT"
TOML
cat > "$GEN/user-min.toml" <<TOML
name = "tenant-a"
main = "../user-min/worker.js"
compatibility_date = "$COMPAT"

[[d1_databases]]
binding = "DB"
database_name = "$D1_NAME"
database_id = "$D1_ID"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "$R2"

[images]
binding = "IMAGES"

[[durable_objects.bindings]]
name = "COUNTER"
class_name = "Counter"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Counter"]
TOML
cat > "$GEN/user-container.toml" <<TOML
name = "tenant-c"
main = "../user-container/worker.js"
compatibility_date = "$COMPAT"

[[containers]]
class_name = "Box"
image = "${CONTAINER_IMAGE:-../user-container/Dockerfile}"
max_instances = 1

[[durable_objects.bindings]]
name = "BOX"
class_name = "Box"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Box"]
TOML
# The control for item 2: the same container Worker as a normal Worker.
sed -e "s/^name = \"tenant-c\"/name = \"$PREFIX-cdirect\"\nworkers_dev = true/" "$GEN/user-container.toml" > "$GEN/container-direct.toml"
cat > "$GEN/dispatcher.toml" <<TOML
name = "$PREFIX-dispatch"
main = "../dispatcher/worker.js"
compatibility_date = "$COMPAT"
workers_dev = true

[[dispatch_namespaces]]
binding = "DISPATCHER"
namespace = "$NS"

[[dispatch_namespaces]]
binding = "DISPATCHER_OUT"
namespace = "$NS"
outbound = { service = "$PREFIX-outbound", parameters = ["TENANT_FROM_DISPATCH"] }
TOML

# One upload. Records the exit code and the last lines (no secrets: Wrangler
# prints names and ids) in $W/deploys.jsonl, and never stops the script.
deploy() {
  local label=$1; shift
  local rc=0 t0=$SECONDS
  (cd "$GEN" && npx wrangler deploy "$@") > "$W/$label.log" 2>&1 || rc=$?
  python3 - "$label" "$rc" "$((SECONDS - t0))" "$W/$label.log" >> "$W/deploys.jsonl" <<'PY'
import json, re, sys
label, rc, s, log = sys.argv[1:5]
lines = [re.sub(r"\x1b\[[0-9;]*m", "", l).rstrip() for l in open(log, errors="replace")]
print(json.dumps({"deploy": label, "exit": int(rc), "s": int(s), "tail": [l for l in lines if l.strip()][-12:]}))
PY
  echo "$label: exit $rc ($((SECONDS - t0)) s)"
}

# Order: the outbound Worker and the namespace scripts exist before the
# dispatcher that names them.
log "upload"
deploy outbound --config outbound.toml
deploy echo-direct --config echo-direct.toml
deploy ns-echo --config echo-user.toml --dispatch-namespace "$NS"
deploy ns-tenant-a --config user-min.toml --dispatch-namespace "$NS" --name tenant-a --var TENANT:tenant-a
deploy ns-tenant-b --config user-min.toml --dispatch-namespace "$NS" --name tenant-b --var TENANT:tenant-b
if [ "${CONTAINER:-0}" = 1 ]; then
  (cd "$H/user-container" && [ -d node_modules ] || npm ci --silent)
  PORT_DEFAULT=$([ -z "${CONTAINER_IMAGE:-}" ] && echo 8080 || echo 80)
  BOX_PORT=${BOX_PORT:-$PORT_DEFAULT}
  # 1. The control, a normal Worker: Wrangler makes its container application
  #    and, for the Dockerfile, builds and pushes the image.
  deploy container-direct --config container-direct.toml --containers-rollout immediate --var "BOX_PORT:$BOX_PORT"
  # 2. The image the control's application runs (exact name <prefix>-cdirect-box).
  IMG=${CONTAINER_IMAGE:-}
  if [ -z "$IMG" ]; then
    IMG=$( (cd "$H" && npx wrangler containers list --json 2>/dev/null) | python3 -c '
import json, sys
s = sys.stdin.read()
try:
    apps = json.loads(s[s.find("["):])
except ValueError:
    apps = []
m = [a.get("image") for a in apps if a.get("name") == sys.argv[1]]
print(m[0] if len(m) == 1 and m[0] else "")' "$PREFIX-cdirect-box")
  fi
  python3 -c 'import json, sys; print(json.dumps({"deploy": "container-image", "exit": 0 if sys.argv[1] else 1, "s": 0, "image": sys.argv[1], "tail": []}))' "$IMG" >> "$W/deploys.jsonl"
  echo "container image: ${IMG:-NOT FOUND}"
  # 3. tenant-c in the namespace. Wrangler cannot make the container
  #    application of a namespace script (code 10007, docs/wfp.md item 2):
  #    upload without it, then make it through the API with the same image.
  deploy ns-tenant-c --config user-container.toml --dispatch-namespace "$NS" --containers-rollout none --var "BOX_PORT:$BOX_PORT"
  if [ -n "$IMG" ]; then
    "$H/container-app.sh" tenant-c Box "$IMG" lite || echo "container-app.sh failed"
  else
    echo "no image for tenant-c: the control did not deploy a container application"
  fi
fi
deploy dispatcher --config dispatcher.toml
D="https://$PREFIX-dispatch.$SUB.workers.dev"
DIRECT="https://$PREFIX-echo.$SUB.workers.dev"
sleep 5

log "checks"
CHECK_ARGS=("$D"); [ "${CONTAINER:-0}" = 1 ] && CHECK_ARGS+=(container)
python3 "$H/check.py" "${CHECK_ARGS[@]}" > "$W/checks.json" || true
if [ "${LATENCY_N:-100}" != 0 ]; then
  log "latency from this machine (${CLIENT:-laptop}): $DIRECT against $D/echo/"
  python3 "$H/latency.py" "$DIRECT/" "$D/echo/" "${LATENCY_N:-100}" > "$W/latency.json" || true
fi
python3 - "$RES" "$W" "$NS" "$D" "$DIRECT" <<'PY'
import json, os, sys, time
res, w, ns, d, direct = sys.argv[1:6]
def load(f):
    p = os.path.join(w, f)
    try:
        return json.load(open(p))
    except (OSError, ValueError):
        return None
out = {"utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "namespace": ns, "dispatcher": d, "direct": direct,
       "deploys": [json.loads(l) for l in open(os.path.join(w, "deploys.jsonl"))],
       "checks": load("checks.json"), "latency_laptop": load("latency.json")}
json.dump(out, open(res, "w"), indent=1)
print("result:", res)
PY
