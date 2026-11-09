# deploy/wfp, the SaaS home edge security (#245). The WFP SaaS home zone
# skyphusionwp.dev terminates EVERY tenant site and every attached custom
# hostname: a single */* Worker route sends all of it to the one dispatcher
# wp-dispatch (see saas-home.tf), which routes by request Host through the site
# map. So a WAF rule on THIS zone is a rule on EVERY tenant at once.
#
# CR AUTHORITY: #245 is the approved change-request for this edge-security layer,
# so this IS its owed IaC PR; the repo rule "do not route a zone without a CR
# issue" is satisfied by #245 for the security surface it governs.
#
# BLAST RADIUS -- READ BEFORE APPLY. Because all tenant traffic shares this zone,
# a mitigation rule scoped too broadly would break every tenant's wp-admin, REST
# API, WooCommerce checkout, or wp-cron at once. Every mitigation rule below is
# therefore scoped to a SPECIFIC attack path and nothing else. The legitimate
# paths we deliberately DO NOT match, and why, are named inline at each rule:
#   - /wp-admin/* and the login PAGE load (GET /wp-login.php): never matched; only
#     POST /wp-login.php (the credential submit) is rate-limited.
#   - /wp-json/* (the REST API, incl. /wp-json/wc/* WooCommerce and app clients):
#     never matched by any rule here.
#   - /wp-json/wp/v2/users: deliberately NOT challenged, so the authenticated
#     block editor (Gutenberg) and REST clients keep working.
#   - /wp-cron.php: never matched.
#   - WooCommerce checkout, /wc-api/* and REST webhooks: never matched.
#   - the dispatcher's own */* route and fallback.skyphusionwp.dev: never matched;
#     no rule here keys on the dispatcher or the fallback origin.
#
# NOT YET LIVE -- CREATE (contrast saas-home.tf, which imports already-live
# resources). The zone has no edge-security layer today (#245), so these three
# phase rulesets are net-new. BUT a zone has at most ONE entry-point ruleset per
# phase. If one already exists for a phase (an empty container counts), a fresh
# `terraform apply` returns 409 "ruleset already exists"; import it first, then
# apply. Read the live ids, then:
#
#   SZ=a18f75d980042a17bec427edc6b04592   # skyphusionwp.dev (the SaaS home zone)
#   # list phase entrypoints:  GET /zones/$SZ/rulesets   (match kind=zone + the phase)
#   terraform import cloudflare_ruleset.waf_managed   "zones/$SZ/<ruleset_id>"
#   terraform import cloudflare_ruleset.waf_custom    "zones/$SZ/<ruleset_id>"
#   terraform import cloudflare_ruleset.waf_ratelimit "zones/$SZ/<ruleset_id>"
#
# On a clean create (no pre-existing phase ruleset), `terraform plan` shows
# exactly three resources to add and nothing else.
#
# PLAN REQUIREMENT / COST (#245): the Cloudflare Managed Ruleset and multi-rule
# rate limiting need a PAID zone plan (Pro or above). skyphusionwp.dev must be on
# Pro+ for an apply to succeed; on Free these resources return 403. Rate limiting
# is metered per rule evaluation (line item named in the #245 cost note).

variable "cf_managed_ruleset_id" {
  type        = string
  default     = "efb7b8c949ac4650a09736fc376e9aee" # Cloudflare Managed Ruleset (public id, not a secret)
  description = "The Cloudflare Managed Ruleset. It carries the managed WordPress rules (tag `wordpress`). There is no separate deployable WordPress ruleset id in the current WAF engine; the WordPress rules live inside this ruleset and are turned on by the category override in waf_managed below."
}

# PHASE 1 of 3 (managed). The Cloudflare Managed Ruleset, with the WordPress
# managed rules (tag `wordpress`) explicitly enabled. Attack-signature based, so
# it does not match legitimate wp-admin / REST / checkout traffic.
resource "cloudflare_ruleset" "waf_managed" {
  zone_id = var.saas_zone_id
  name    = "WFP SaaS home managed WAF"
  kind    = "zone"
  phase   = "http_request_firewall_managed"

  rules = [{
    ref         = "exec_cf_managed_wordpress"
    action      = "execute"
    expression  = "true" # every tenant host terminating on the zone
    enabled     = true
    description = "Run the Cloudflare Managed Ruleset and enable its WordPress rules; rules keep their vendor default actions."
    action_parameters = {
      id = var.cf_managed_ruleset_id
      overrides = {
        # Turn the WordPress-tagged managed rules ON. No `action` is set on the
        # category, so each rule keeps its Cloudflare-tuned default action (block
        # or managed_challenge on a signature hit). If, after apply, Security
        # Events shows a specific managed rule firing on legitimate wp-admin /
        # REST / WooCommerce traffic, demote THAT rule (not the whole category)
        # to log:
        #   overrides = { rules = [{ id = "<managed_rule_id>", action = "log" }] }
        #
        # We deliberately do NOT deploy the OWASP Core Ruleset
        # (4814384a9e5d4991b9815dcfc25d2f1f) on this zone: its generic rules
        # heavily false-positive on wp-admin POST bodies, the REST API, and
        # WooCommerce checkout, which is exactly the "must not break" set.
        categories = [{
          category = "wordpress"
          enabled  = true
        }]
      }
    }
  }]
}

# PHASE 2 of 3 (custom). Author enumeration and probe-path mitigation. Both rules
# target paths no legitimate visitor, admin, REST client, or checkout requests.
resource "cloudflare_ruleset" "waf_custom" {
  zone_id = var.saas_zone_id
  name    = "WFP SaaS home custom WAF"
  kind    = "zone"
  phase   = "http_request_firewall_custom"

  rules = [
    {
      ref         = "block_wp_probe_paths"
      action      = "block"
      enabled     = true
      description = "Block requests for files no legitimate client ever fetches."
      # Each disjunct is a path NO real visitor / admin / REST client / checkout
      # requests, so blocking cannot break a tenant:
      #   - any path containing wp-config.php (secrets file + *.bak/*.save/~ copies)
      #   - /wp-content/debug.log (WP_DEBUG_LOG output, must never be readable)
      #   - /.env (framework secrets) and anything under /.git/ (repo exposure)
      #   - a .php under /wp-content/uploads/ (planted web shell; uploads are media)
      expression = "(http.request.uri.path contains \"wp-config.php\") or (http.request.uri.path eq \"/wp-content/debug.log\") or (http.request.uri.path eq \"/.env\") or (starts_with(http.request.uri.path, \"/.git/\")) or (http.request.uri.path contains \"/wp-content/uploads/\" and ends_with(http.request.uri.path, \".php\"))"
    },
    {
      ref         = "challenge_author_enumeration"
      action      = "managed_challenge"
      enabled     = true
      description = "Challenge author enumeration via /?author=N on the site root."
      # Scoped to the root with an author query arg: a human browsing never asks
      # for ?author= on / ; a scanner mapping usernames does. We deliberately do
      # NOT touch /wp-json/wp/v2/users (the authenticated block editor reads it).
      expression = "http.request.uri.path eq \"/\" and http.request.uri.query contains \"author=\""
    }
  ]
}

# PHASE 3 of 3 (rate limit). wp-login.php and xmlrpc.php, challenge then block on
# a burst. For each path the BLOCK rule (higher threshold) is listed BEFORE the
# CHALLENGE rule (lower threshold) on purpose: rules match top-to-bottom, first
# match wins, so a large burst trips block while a smaller burst falls through to
# challenge. Reversing the order would challenge first and block would never be
# reached. The counter is keyed on client IP (ip.src) only, so one attacking IP
# is limited across ALL tenant hosts at once; a NAT sharing one public IP is the
# known trade-off, and the thresholds leave a human admin generous headroom.
resource "cloudflare_ruleset" "waf_ratelimit" {
  zone_id = var.saas_zone_id
  name    = "WFP SaaS home rate limits"
  kind    = "zone"
  phase   = "http_ratelimit"

  rules = [
    {
      ref         = "block_wp_login_burst"
      action      = "block"
      enabled     = true
      description = "Block wp-login.php POST brute force: over 15 login POSTs per IP in 60s, blocked 10 min."
      expression  = "http.request.uri.path eq \"/wp-login.php\" and http.request.method eq \"POST\""
      ratelimit = {
        characteristics     = ["ip.src"]
        period              = 60
        requests_per_period = 15
        mitigation_timeout  = 600
      }
    },
    {
      ref         = "challenge_wp_login"
      action      = "managed_challenge"
      enabled     = true
      description = "Challenge wp-login.php POSTs above a human rate: over 5 login POSTs per IP in 60s."
      expression  = "http.request.uri.path eq \"/wp-login.php\" and http.request.method eq \"POST\""
      ratelimit = {
        characteristics     = ["ip.src"]
        period              = 60
        requests_per_period = 5
        mitigation_timeout  = 60
      }
    },
    {
      ref         = "block_xmlrpc_burst"
      action      = "block"
      enabled     = true
      description = "Block xmlrpc.php POST floods (system.multicall amplification, pingback abuse): over 30 POSTs per IP in 60s, blocked 10 min."
      expression  = "http.request.uri.path eq \"/xmlrpc.php\" and http.request.method eq \"POST\""
      ratelimit = {
        characteristics     = ["ip.src"]
        period              = 60
        requests_per_period = 30
        mitigation_timeout  = 600
      }
    },
    {
      ref         = "challenge_xmlrpc"
      action      = "managed_challenge"
      enabled     = true
      description = "Challenge elevated xmlrpc.php POST rates while leaving Jetpack / mobile-app use headroom: over 10 POSTs per IP in 60s."
      expression  = "http.request.uri.path eq \"/xmlrpc.php\" and http.request.method eq \"POST\""
      ratelimit = {
        characteristics     = ["ip.src"]
        period              = 60
        requests_per_period = 10
        mitigation_timeout  = 60
      }
    }
  ]
}

output "waf_managed_ruleset_id" { value = cloudflare_ruleset.waf_managed.id }
output "waf_custom_ruleset_id" { value = cloudflare_ruleset.waf_custom.id }
output "waf_ratelimit_ruleset_id" { value = cloudflare_ruleset.waf_ratelimit.id }
