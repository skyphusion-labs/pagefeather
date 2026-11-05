#!/bin/bash
# terraform for tests/a/terraform with every credential it needs. Usage: ./tf.sh plan
set -euo pipefail
cd "$(dirname "$0")"
set -a; . /Users/conrad/.wp-on-cf-tfstate.env; . /Users/conrad/cloudflare-mcp.env; set +a
export VULTR_API_KEY="$(cat /Users/conrad/.vultr-api.key)"
export TF_VAR_free_hyperdrive_token="$(cat /Users/conrad/.cf-testing-hyperdrive.token)"
export TF_VAR_free_admin_token="$(cat /Users/conrad/.cf-testing.token)"
exec terraform "$@"
