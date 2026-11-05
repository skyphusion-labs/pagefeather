#!/bin/bash
# Run the benchmark for one or more sites on the Vultr runner, and wait for the
# result. The sites were made by deploy/deploy.sh.
#
#   CLOUDFLARE_API_TOKEN=... ./tests/bench-runner/run.sh wp-c1 wp-ref-free=https://wp-ref-free.example.workers.dev
#
# A site is NAME or NAME=URL. For NAME alone, the URL is
# https://NAME.<subdomain>.workers.dev, with the subdomain of the account in
# the site's Terraform outputs (GET /accounts/{id}/workers/subdomain with
# CLOUDFLARE_API_TOKEN). Give NAME=URL when the token cannot read that account.
#
# The admin password, spike token and variant come from the site's Terraform
# outputs (deploy/terraform, workspace NAME). DEPLOY_STATE=r2 reads them from
# the R2 state as deploy.sh writes it (STATE_BUCKET, STATE_ENDPOINT, and the
# state key in AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).
#
# The job bucket and its key come from tests/bench-runner/terraform outputs
# (its state is in R2: the same AWS_* key).
#
# Options: N (fresh renders per page, default 10), BRANCH (the runner pulls it
# before the job; default: the runner's own default), WAIT (seconds to wait for
# the result, default 3600), DRY_RUN=1 (print the job with the secrets hidden;
# upload nothing).
# LOAD=levels:seconds:buyers runs tests/load/load.py on each site instead of the
# benchmark, e.g. LOAD=1,5,10,25,50:60:0.2 (users per step, seconds per step,
# fraction of loops that check out). The sites need WooCommerce active.
#
# Output: a table, and deploy/results/bench-runner-<job-id>.json.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HERE="$ROOT/tests/bench-runner"
DT="$ROOT/deploy/terraform"
RT="$HERE/terraform"
[ $# -ge 1 ] || { sed -n '2,26p' "$0"; exit 2; }
N=${N:-10}
[[ "$N" =~ ^[1-9][0-9]?$|^100$ ]] || { echo "N must be 1 to 100" >&2; exit 2; }
umask 077
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
JOB_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"

# Terraform outputs of one site, as JSON. TF_WORKSPACE selects the workspace
# without writing .terraform/environment, so a deploy.sh that runs in the same
# tree is not disturbed.
site_outputs() {
  local name=$1 d
  if [ "${DEPLOY_STATE:-local}" = r2 ]; then
    : "${STATE_BUCKET:?set STATE_BUCKET}" "${STATE_ENDPOINT:?set STATE_ENDPOINT}"
    # A copy of the root with the same backend as deploy.sh (key
    # deploy/<name>/terraform.tfstate), so deploy/terraform is not changed.
    d="$W/tf-$name"; mkdir -p "$d"
    cp "$DT"/*.tf "$DT/.terraform.lock.hcl" "$d/"
    rm -f "$d/backend_override.tf"
    cat > "$d/backend_override.tf" <<TF
terraform {
  backend "s3" {
    bucket                      = "$STATE_BUCKET"
    key                         = "deploy/$name/terraform.tfstate"
    region                      = "auto"
    endpoints                   = { s3 = "$STATE_ENDPOINT" }
    use_path_style              = true
    skip_s3_checksum            = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
  }
}
TF
    (cd "$d" && terraform init -input=false >/dev/null && TF_WORKSPACE=$name terraform output -json)
  else
    (cd "$DT" && TF_WORKSPACE=$name terraform output -json)
  fi
}

# The workers.dev subdomain of an account. The token goes to curl in a config
# on a pipe, not in the arguments.
subdomain() {
  : "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN, or give NAME=URL}"
  curl -sf -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") \
    "https://api.cloudflare.com/client/v4/accounts/$1/workers/subdomain" \
    | python3 -c 'import json, sys; print(json.load(sys.stdin)["result"]["subdomain"])'
}

# 1. The job: one target per site.
for arg in "$@"; do
  name=${arg%%=*}; url=""
  [ "$arg" = "$name" ] || url=${arg#*=}
  site_outputs "$name" > "$W/out.json" || { echo "$name: no Terraform outputs (workspace $name)" >&2; exit 1; }
  if [ -z "$url" ]; then
    acct=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["account_id"]["value"])' "$W/out.json")
    sub=$(subdomain "$acct") || { echo "$name: cannot read the workers.dev subdomain of account $acct; give $name=https://..." >&2; exit 1; }
    url="https://$name.$sub.workers.dev"
  fi
  python3 "$HERE/job.py" target "$name" "$url" < "$W/out.json" >> "$W/targets.jsonl"
  rm -f "$W/out.json"
  echo "target $name: $url"
done
python3 "$HERE/job.py" job "$JOB_ID" "${BRANCH:-}" "$N" "$W/targets.jsonl" > "$W/job.json"

if [ "${DRY_RUN:-0}" = 1 ]; then
  echo "DRY_RUN: job $JOB_ID (secrets hidden), not uploaded:"
  python3 "$HERE/job.py" redact "$W/job.json"
  exit 0
fi

# 2. The job bucket and its key (tests/bench-runner/terraform outputs).
rto() { (cd "$RT" && terraform output -raw "$1"); }
EP=$(rto endpoint); BUCKET=$(rto bucket); KEY_ID=$(rto access_key_id); SECRET=$(rto secret_access_key)
s3() { curl -sS -K <(printf 'user = "%s:%s"\n' "$KEY_ID" "$SECRET") --aws-sigv4 "aws:amz:auto:s3" "$@"; }

# 3. Upload, then wait for the result.
code=$(s3 -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: application/json' --data-binary "@$W/job.json" "$EP/$BUCKET/jobs/$JOB_ID.json")
[ "$code" = 200 ] || { echo "upload jobs/$JOB_ID.json: HTTP $code" >&2; exit 1; }
rm -f "$W/job.json" "$W/targets.jsonl"
echo "job $JOB_ID uploaded; waiting for results/$JOB_ID.json (the runner checks every 30 s)"
t0=$SECONDS
while :; do
  code=$(s3 -o "$W/result.json" -w '%{http_code}' "$EP/$BUCKET/results/$JOB_ID.json" || echo 000)
  [ "$code" = 200 ] && break
  [ $((SECONDS - t0)) -lt "${WAIT:-3600}" ] || { echo "no result after ${WAIT:-3600} s (last HTTP $code). The job is still in jobs/: see journalctl -u bench-runner on the runner (Vultr console)." >&2; exit 1; }
  sleep 15
done
OUT="$ROOT/deploy/results/bench-runner-$JOB_ID.json"
mkdir -p "$ROOT/deploy/results"
cp "$W/result.json" "$OUT"
chmod 644 "$OUT"
python3 "$HERE/job.py" table "$OUT"
echo "result: $OUT ($((SECONDS - t0)) s)"
