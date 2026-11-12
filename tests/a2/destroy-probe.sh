#!/bin/bash
# Remove what tests/a2/probe.sh made: the Worker wp-a2-probe, then the two
# Hyperdrive configs and the token (Terraform). The database is not touched.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
export CLOUDFLARE_ACCOUNT_ID=${ACCOUNT_ID:-fabcb25d9c7eb087110ec474a03e50d2}
(cd "$ROOT/tests/a2" && "$ROOT/deploy/wr" delete wp-a2-probe --force) || echo "Worker wp-a2-probe not deleted (already deleted?)"
(cd "$ROOT/tests/a2/terraform" && terraform init -input=false >/dev/null && terraform destroy -input=false -auto-approve)
