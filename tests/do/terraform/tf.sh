#!/bin/bash
# terraform for tests/do/terraform. Usage: ./tf.sh plan
# Credential files default under $HOME. Override with TFSTATE_ENV and
# CF_TESTING_TOKEN_FILE when they live elsewhere.
set -euo pipefail
cd "$(dirname "$0")"
TFSTATE_ENV="${TFSTATE_ENV:-$HOME/.wp-on-cf-tfstate.env}"
CF_TESTING_TOKEN_FILE="${CF_TESTING_TOKEN_FILE:-$HOME/.cf-testing.token}"
set -a; . "$TFSTATE_ENV"; set +a
export TF_VAR_free_api_token="$(cat "$CF_TESTING_TOKEN_FILE")"
exec terraform "$@"
