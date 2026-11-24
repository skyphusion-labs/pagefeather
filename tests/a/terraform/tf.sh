#!/bin/bash
# terraform for tests/a/terraform with every credential it needs. Usage: ./tf.sh plan
# Credential files default under $HOME. Override with the env vars below when they
# live elsewhere.
set -euo pipefail
cd "$(dirname "$0")"
TFSTATE_ENV="${TFSTATE_ENV:-$HOME/.wp-on-cf-tfstate.env}"
CLOUDFLARE_ENV_FILE="${CLOUDFLARE_ENV_FILE:-$HOME/cloudflare-mcp.env}"
VULTR_API_KEY_FILE="${VULTR_API_KEY_FILE:-$HOME/.vultr-api.key}"
CF_TESTING_HYPERDRIVE_TOKEN_FILE="${CF_TESTING_HYPERDRIVE_TOKEN_FILE:-$HOME/.cf-testing-hyperdrive.token}"
CF_TESTING_TOKEN_FILE="${CF_TESTING_TOKEN_FILE:-$HOME/.cf-testing.token}"
set -a; . "$TFSTATE_ENV"; . "$CLOUDFLARE_ENV_FILE"; set +a
export VULTR_API_KEY="$(cat "$VULTR_API_KEY_FILE")"
export TF_VAR_free_hyperdrive_token="$(cat "$CF_TESTING_HYPERDRIVE_TOKEN_FILE")"
export TF_VAR_free_admin_token="$(cat "$CF_TESTING_TOKEN_FILE")"
exec terraform "$@"
