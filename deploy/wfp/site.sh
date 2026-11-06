#!/bin/bash
# One site of the reference deployment (issue #35, deploy/wfp).
#   CLOUDFLARE_API_TOKEN=... deploy/wfp/site.sh up <name>
#   CLOUDFLARE_API_TOKEN=... deploy/wfp/site.sh down <name>
# up.sh and down.sh call it for each site; slice 3 makes it "site add/remove".
# The shared pieces (up.sh) must exist. b-dosql must be built (up.sh builds it).
#
# up, in the order of the #35 design (a KV entry must exist before its
# hostname is ever requested, or the "absent" answer is cached):
#   1. the site's Terraform workspace: media bucket, secrets, site map entry
#   2. the user Worker site-<name> in the namespace (b-dosql), with its secrets
#   3. the dispatcher copy wp-<name> on workers.dev: the site's hostname
#   4. wait for the site, then install WordPress
# down, the other way round, each step checked against the API before the next:
#   1. the dispatcher copy (the hostname)   2. the user Worker
#   3. the bucket emptied, then the workspace destroyed (bucket, secrets, entry)
set -euo pipefail
. "$(dirname "$0")/lib.sh"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
cmd=${1:-}; s=${2:-}
valid_site "$s" || { echo "usage: site.sh up|down <name> (lower case, digits, hyphens; 1 to 30; not probe)" >&2; exit 2; }
umask 077
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
mkdir -p "$GEN"
KV_ID=$(tfr shared output -raw kv_namespace_id)
SUB=$(subdomain)
D=$(dispatcher_name "$s"); U=$(user_script "$s")
HOST="$D.$SUB.workers.dev"; ORIGIN="https://$HOST"
VARS=(-var "name=$s" -var "hostname=$HOST" -var "kv_namespace_id=$KV_ID")
out() { tfr site output -raw "$1"; }
ws() { tfr site init -input=false >/dev/null && tfr site workspace select -or-create "$s" >/dev/null; }
gone() { # gone <what> <API path>: 404 or stop
  local c; c=$(api_code GET "$2")
  case "$c" in 404) echo "  $1 is gone (API 404)" ;; *) echo "  $1 is NOT gone (API $c): stopping" >&2; exit 1 ;; esac
}

if [ "$cmd" = up ]; then
  log "site $s: data plane and site map entry (workspace $s)"
  ws
  tfr site apply -input=false -auto-approve "${VARS[@]}" >/dev/null

  log "site $s: user Worker $U in $NAMESPACE"
  CONF="$APP/wrangler.deploy.wfp-$s.toml"
  render_user "$s" "$ORIGIN" > "$CONF"
  tfr site output -json | python3 -c '
import json, sys
o = {k: v["value"] for k, v in json.load(sys.stdin).items()}
json.dump({"WP_SALT": o["wp_salt"], "SPIKE_TOKEN": o["spike_token"]}, open(sys.argv[1], "w"))' "$W/secrets.json"
  (cd "$APP" && npx wrangler deploy --config "$CONF" --dispatch-namespace "$NAMESPACE" --secrets-file "$W/secrets.json") > "$W/user.log" 2>&1 \
    || { rm -f "$W/secrets.json"; tail -20 "$W/user.log"; exit 1; }
  rm -f "$W/secrets.json"
  grep -E 'Total Upload|Current Version' "$W/user.log" || true

  log "site $s: dispatcher $D"
  render_dispatcher "$s" "$KV_ID" > "$GEN/$D.toml"
  (cd "$GEN" && npx wrangler deploy --config "$D.toml") > "$W/disp.log" 2>&1 || { tail -20 "$W/disp.log"; exit 1; }
  grep -q "$ORIGIN" "$W/disp.log" || { echo "the dispatcher did not deploy to $ORIGIN:" >&2; tail -5 "$W/disp.log" >&2; exit 1; }

  log "site $s: wait for $ORIGIN, then install"
  # A new workers.dev name can answer 404 for a while (seen 2026-11-06, #106);
  # the site is there when the answer is not the platform's 404 page.
  t0=$SECONDS; code=000
  while [ $((SECONDS - t0)) -lt "${SITE_WAIT:-300}" ]; do
    code=$(curl -s -o "$W/first" -w '%{http_code}' -D "$W/first.h" -m 60 "$ORIGIN/_dbping?nocache=$RANDOM" || true)
    grep -qi '^x-wfp-error:' "$W/first.h" && { echo "  the dispatcher answered: $(grep -i '^x-wfp-error:' "$W/first.h" | tr -d '\r')"; }
    [ "$code" != 000 ] && ! grep -qi 'nothing here yet' "$W/first" && break
    sleep 10
  done
  echo "  first answer HTTP $code after $((SECONDS - t0)) s"
  hdr() { printf 'header = "x-spike-token: %s"\nheader = "x-admin-password: %s"\n' "$(out spike_token)" "$(out admin_password)"; }
  curl -s -m 300 -X POST -K <(hdr) "$ORIGIN/_install" > "$W/install.json" || true
  python3 -c 'import json, sys
try:
    d = json.load(open(sys.argv[1])); print("  install:", str(d.get("installed") or d.get("out", ""))[-80:])
except ValueError:
    print("  install did not answer JSON:", open(sys.argv[1]).read()[:200]); sys.exit(1)' "$W/install.json"
  echo "site $s: up at $ORIGIN"
elif [ "$cmd" = down ]; then
  log "site $s: dispatcher $D (the hostname first)"
  (cd "$ROOT/deploy" && npx wrangler delete --name "$D" --force) > "$W/del.log" 2>&1 || tail -5 "$W/del.log"
  gone "dispatcher $D" "/workers/scripts/$D"

  log "site $s: user Worker $U"
  api DELETE "/workers/dispatch/namespaces/$NAMESPACE/scripts/$U?force=true" > /dev/null || true
  gone "user Worker $U" "/workers/dispatch/namespaces/$NAMESPACE/scripts/$U"

  log "site $s: media bucket emptied, then the workspace destroyed"
  # A down never creates: no workspace means no data plane to remove.
  tfr site init -input=false >/dev/null
  if tfr site workspace select "$s" >/dev/null 2>&1; then
    tfr site apply -input=false -auto-approve "${VARS[@]}" -var teardown=true >/dev/null
    R2_KEY_ID=$(out teardown_access_key_id) R2_SECRET=$(out teardown_secret_access_key) \
      "$ROOT/deploy/variants/r2-empty.sh" "$(out r2_endpoint)" "$(out media_bucket)"
    tfr site destroy -input=false -auto-approve "${VARS[@]}" -var teardown=true >/dev/null
    tfr site workspace select default >/dev/null && tfr site workspace delete "$s" >/dev/null
  else
    echo "  no workspace $s: no data plane to remove (checked below)"
  fi
  gone "site map entry $HOST" "/storage/kv/namespaces/$KV_ID/values/$HOST"
  gone "bucket $(media_bucket "$s")" "/r2/buckets/$(media_bucket "$s")"
  rm -f "$APP/wrangler.deploy.wfp-$s.toml" "$GEN/$D.toml"
  echo "site $s: down"
else
  echo "usage: site.sh up|down <name>" >&2; exit 2
fi
