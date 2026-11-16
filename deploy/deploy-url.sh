# shellcheck shell=bash
# deploy-url.sh (#754): where a `wrangler deploy` landed, and the origin check. Sourced by deploy/deploy.sh.
#
# deployed_workers_url <script name>: reads wrangler's deploy output on stdin and prints the workers.dev URL on its
# TRIGGER line, the URL alone on its own line under "Deployed <name> triggers". It is never a URL that wrangler prints
# elsewhere, such as a var's value in the bindings table: any var holding a workers.dev URL, as a tick URL did in #754's
# proof, and SITE_ORIGIN itself. Before
# this, deploy.sh took the FIRST workers.dev URL anywhere in the output. It prints nothing when the deploy has no
# workers.dev trigger, and it always returns 0 (deploy.sh runs under set -euo pipefail).
deployed_workers_url() {
  local name=$1
  { grep -E "^[[:space:]]+https://${name}\.[a-z0-9-]+\.workers\.dev[[:space:]]*\$" || true; } | head -1 | tr -d '[:space:]'
}

# origin_check <deployed url> <SITE_ORIGIN>: a workers.dev site must be at its configured origin, or every link points
# elsewhere. A custom-domain origin is not checked here. deploy.sh runs this AFTER the redaction and the secrets
# (#754), so a failed check never strands a site without them.
origin_check() {
  local url=$1 origin=$2
  case "$origin" in
    *.workers.dev) [ "$url" = "$origin" ] || { echo "deployed to '$url', but SITE_ORIGIN is $origin" >&2; return 1; } ;;
  esac
  return 0
}
