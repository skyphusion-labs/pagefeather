#!/bin/bash
# Deploy approach A's wp-a-lean and redact its log query strings in ONE step (#394).
#   spikes/b2-wordpress/deploy-a-lean.sh [extra wrangler deploy args, e.g. --var LAZY_CACHE_MB:2]
# env.a-paid-lean turns Workers Logs on, and wrangler has no key for the query-string redaction,
# so it is set through the script-settings API right after the upload and read back. If it does not
# read back, the script's observability is turned OFF (fail closed) and this exits 1. The gap
# between the upload and the redaction is the API round trip (seconds), not a manual step.
# Needs CLOUDFLARE_API_TOKEN and ACCOUNT_ID (or CLOUDFLARE_ACCOUNT_ID) in the environment.
# Run ./prepare.sh && ./opcache-a.sh first (the build).
set -euo pipefail
cd "$(dirname "$0")"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
../../deploy/wr deploy --env a-paid-lean "$@"
python3 -I ../../deploy/wfp/obs_settings.py redact-or-off - wp-a-lean
