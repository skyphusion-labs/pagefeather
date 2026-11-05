#!/bin/bash
# One time, before the first `terraform init`: the state bucket and an R2 key
# for it alone. A backend cannot create the bucket it keeps its own state in.
# Writes /Users/conrad/.wp-on-cf-tfstate.env (AWS_ACCESS_KEY_ID,
# AWS_SECRET_ACCESS_KEY; mode 600). Needs /Users/conrad/cloudflare-mcp.env.
set -euo pipefail
A=fabcb25d9c7eb087110ec474a03e50d2
OUT=/Users/conrad/.wp-on-cf-tfstate.env
[ ! -s "$OUT" ] || { echo "$OUT exists: already bootstrapped"; exit 0; }
set -a; . /Users/conrad/cloudflare-mcp.env; set +a
cf() { curl -sf -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' "$@"; }
cf -X POST "https://api.cloudflare.com/client/v4/accounts/$A/r2/buckets" -d '{"name":"wp-on-cf-tfstate","locationHint":"enam"}' > /dev/null
umask 077
cf -X POST "https://api.cloudflare.com/client/v4/accounts/$A/tokens" -d "{\"name\":\"wp-on-cf-tfstate\",\"policies\":[{\"effect\":\"allow\",\"permission_groups\":[{\"id\":\"6a018a9f2fc74eb6b293b0c548f38b39\"},{\"id\":\"2efd5506f9c8494dacb1fa10a3e7d5b6\"}],\"resources\":{\"com.cloudflare.edge.r2.bucket.${A}_default_wp-on-cf-tfstate\":\"*\"}}]}" \
  | python3 -c "
import hashlib, json, sys
r = json.load(sys.stdin)['result']
open('$OUT', 'w').write('AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\n' % (r['id'], hashlib.sha256(r['value'].encode()).hexdigest()))"
echo "state bucket and key ready: $OUT"
