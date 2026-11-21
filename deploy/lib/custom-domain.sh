# shellcheck shell=bash
# #1262: an opt-in custom domain for a deploy.sh site. CUSTOM_DOMAIN=<host> (a recorded input, #1108) puts the Worker on
# that hostname as a Workers Custom Domain (render-conf.sh writes the route; wrangler deploy creates it with the version).
# custom_domain_prepare checks it BEFORE any step and derives SITE_ORIGIN from it:
# - a lower-case hostname with at least one dot, and not *.workers.dev (that is the default host already);
# - in a zone on this account (GET /zones?account.id=..., the longest zone name the host ends with);
# - an explicit SITE_ORIGIN must be https://<host>; any other is refused (one origin, not two).
# Off (CUSTOM_DOMAIN unset): nothing is checked or derived, and the deploy is as before.
# CF_API_BASE points the zone read at a stub (deploy/tests/custom-domain-test.sh). The token never reaches argv.

custom_domain_zone() { # custom_domain_zone <host>: prints the zone name that holds <host>, or nothing; 1 on a failed read
  local host=$1 base=${CF_API_BASE:-https://api.cloudflare.com/client/v4} body
  body=$(curl -sS -m 60 -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") \
    "$base/zones?account.id=$ACCOUNT_ID&per_page=50&status=active") || return 1
  HOST="$host" BODY="$body" python3 -I -c '
import json, os, sys
try:
    d = json.loads(os.environ["BODY"])
except Exception:
    sys.exit(1)
if d.get("success") is not True:
    sys.exit(1)
h = os.environ["HOST"]
names = [z.get("name", "") for z in d.get("result") or [] if isinstance(z, dict)]
hits = sorted((n for n in names if n and (h == n or h.endswith("." + n))), key=len, reverse=True)
print(hits[0] if hits else "", end="")
'
}

custom_domain_prepare() {
  [ -n "${CUSTOM_DOMAIN:-}" ] || return 0
  local host=$CUSTOM_DOMAIN zone
  [[ "$host" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] \
    || { echo "CUSTOM_DOMAIN must be a lower-case hostname (for example shop.example.com), got '$host' (#1262)" >&2; return 2; }
  case "$host" in *.workers.dev) echo "CUSTOM_DOMAIN is a workers.dev hostname ($host): that is the default host already; leave CUSTOM_DOMAIN unset (#1262)" >&2; return 2 ;; esac
  if [ -n "${SITE_ORIGIN:-}" ] && [ "$SITE_ORIGIN" != "https://$host" ]; then
    echo "SITE_ORIGIN ($SITE_ORIGIN) and CUSTOM_DOMAIN ($host) disagree: with CUSTOM_DOMAIN, leave SITE_ORIGIN unset (it becomes https://$host) (#1262)" >&2; return 2
  fi
  zone=$(custom_domain_zone "$host") || { echo "CUSTOM_DOMAIN: the account's zones could not be read; nothing was changed (#1262)" >&2; return 2; }
  [ -n "$zone" ] || { echo "CUSTOM_DOMAIN: $host is in no active zone on account $ACCOUNT_ID; a Workers Custom Domain needs one (#1262)" >&2; return 2; }
  SITE_ORIGIN="https://$host"
  echo "custom domain: $host (zone $zone); SITE_ORIGIN $SITE_ORIGIN"
}

# custom_domain_detach <service>: before a site's Worker is deleted (deploy/destroy.sh), remove every Workers Custom
# Domain attached to it, then read back that none remain. A site never deployed with CUSTOM_DOMAIN has none, and this
# changes nothing. Any failed read or delete returns 1, so the teardown stops loudly instead of leaving a domain (and its
# DNS record) behind. CF_API is the API base (destroy.sh's, so deploy/tests/destroy-test.sh can stub it).
custom_domain_detach() {
  local svc=$1 base=${CF_API:-https://api.cloudflare.com/client/v4} ids id body
  _cd_list() { curl -sS -m 60 -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") "$base/accounts/$ACCOUNT_ID/workers/domains?service=$svc"; }
  _cd_ids() { BODY="$1" SVC="$svc" python3 -I -c '
import json, os, sys
try:
    d = json.loads(os.environ["BODY"])
except Exception:
    sys.exit(1)
if d.get("success") is not True:
    sys.exit(1)
for x in d.get("result") or []:
    if isinstance(x, dict) and x.get("service") == os.environ["SVC"] and x.get("id"):
        print(x["id"], x.get("hostname", ""))
'; }
  body=$(_cd_list) || { echo "destroy: the Worker custom domains of $svc could not be listed; stopping (#1262)" >&2; return 1; }
  ids=$(_cd_ids "$body") || { echo "destroy: the Worker custom domains of $svc could not be read; stopping (#1262)" >&2; return 1; }
  [ -n "$ids" ] || { echo "destroy: no Worker custom domain on $svc"; return 0; }
  while read -r id host; do
    [ -n "$id" ] || continue
    curl -sS -m 60 -o /dev/null -w '%{http_code}' -X DELETE -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") \
      "$base/accounts/$ACCOUNT_ID/workers/domains/$id" | grep -qx 200 || { echo "destroy: the custom domain $host ($id) of $svc could not be deleted; stopping (#1262)" >&2; return 1; }
    echo "destroy: custom domain $host removed from $svc"
  done <<< "$ids"
  body=$(_cd_list) && ids=$(_cd_ids "$body") || { echo "destroy: the custom domains of $svc could not be read back; stopping (#1262)" >&2; return 1; }
  [ -z "$ids" ] || { echo "destroy: custom domains of $svc remain after the delete: $(echo "$ids" | tr '\n' ' '); stopping (#1262)" >&2; return 1; }
  echo "destroy: read back, no custom domain on $svc"
}
