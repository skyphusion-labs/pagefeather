#!/bin/bash
# Item 2 of issue #35: give a namespace script's Durable Object class a
# container application, through the API.
#
#   CLOUDFLARE_API_TOKEN=... ./tests/wfp/container-app.sh <script> <class> [image] [instance-type]
#
# Why: `wrangler deploy --dispatch-namespace` (4.107.0) uploads the script but
# then looks the script up at /workers/scripts/<name>/versions/<id> (account
# scripts, not namespace scripts) and fails with code 10007 before it makes the
# container application (measured 2026-11-05). The application itself only
# needs the Durable Object namespace id, which the API lists for namespace
# scripts too. This makes the same request Wrangler makes
# (POST /accounts/{id}/containers/applications with durable_objects.namespace_id).
set -euo pipefail
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
A=${ACCOUNT_ID:-fabcb25d9c7eb087110ec474a03e50d2}
SCRIPT=${1:?script}; CLASS=${2:?class}
IMAGE=${3:-docker.io/library/httpd:2.4}; TYPE=${4:-lite}
api() { curl -sS -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") "$@"; }
B="https://api.cloudflare.com/client/v4/accounts/$A"
NSID=$(api "$B/workers/durable_objects/namespaces?per_page=1000" | python3 -c '
import json, sys
s, c = sys.argv[1:3]
ids = [n["id"] for n in json.load(sys.stdin).get("result") or [] if n.get("script") == s and n.get("class") == c]
print(ids[0] if len(ids) == 1 else "")' "$SCRIPT" "$CLASS")
[ -n "$NSID" ] || { echo "no Durable Object namespace for script $SCRIPT class $CLASS" >&2; exit 1; }
NAME=$(printf '%s-%s' "$SCRIPT" "$CLASS" | tr '[:upper:]' '[:lower:]')
EXISTING=$(api "$B/containers/applications" | python3 -c '
import json, sys
ids = [a.get("id") for a in json.load(sys.stdin).get("result") or [] if a.get("name") == sys.argv[1]]
print(ids[0] if ids else "")' "$NAME")
if [ -n "$EXISTING" ]; then
  echo "application $NAME exists ($EXISTING): nothing to do"
  exit 0
fi
echo "Durable Object namespace $NSID; application $NAME ($IMAGE, $TYPE)"
BODY=$(python3 -c '
import json, sys
name, image, typ, ns = sys.argv[1:5]
print(json.dumps({"name": name, "scheduling_policy": "default", "instances": 0, "max_instances": 1,
                  "configuration": {"image": image, "instance_type": typ}, "durable_objects": {"namespace_id": ns}}))' "$NAME" "$IMAGE" "$TYPE" "$NSID")
api -X POST -H 'content-type: application/json' --data "$BODY" "$B/containers/applications" | python3 -c '
import json, sys
d = json.load(sys.stdin)
r = d.get("result") or {}
print(json.dumps({"success": d.get("success"), "errors": d.get("errors"), "id": r.get("id"), "name": r.get("name"),
                  "durable_objects": r.get("durable_objects")}))'
