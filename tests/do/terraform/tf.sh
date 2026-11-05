#!/bin/bash
# terraform for tests/do/terraform. Usage: ./tf.sh plan
set -euo pipefail
cd "$(dirname "$0")"
set -a; . /Users/conrad/.wp-on-cf-tfstate.env; set +a
export TF_VAR_free_api_token="$(cat /Users/conrad/.cf-testing.token)"
exec terraform "$@"
