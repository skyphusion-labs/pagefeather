#!/bin/bash
# terraform for tests/bench-runner/terraform with every credential it needs,
# loaded the same way as tests/a/terraform/tf.sh. Usage: ./tf.sh init | plan | apply | destroy | output
#   /Users/conrad/.wp-on-cf-tfstate.env  AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (state bucket)
#   /Users/conrad/cloudflare-mcp.env     CLOUDFLARE_API_TOKEN (R2 buckets, account API tokens)
#   /Users/conrad/.vultr-api.key         VULTR_API_KEY
set -euo pipefail
cd "$(dirname "$0")/terraform"
set -a; . /Users/conrad/.wp-on-cf-tfstate.env; . /Users/conrad/cloudflare-mcp.env; set +a
VULTR_API_KEY="$(cat /Users/conrad/.vultr-api.key)"
export VULTR_API_KEY
exec terraform "$@"
