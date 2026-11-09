# deploy/wfp, the SaaS home routing (#157 owed IaC, filed as #248). This is the
# IaC follow-up #157 owes: the live SaaS home on zone skyphusionwp.dev was
# HAND-APPLIED (a */* Worker route to the one dispatcher wp-dispatch, plus the
# Cloudflare for SaaS fallback origin fallback.skyphusionwp.dev), so the home was
# not reproducible from code. This file codifies exactly those two resources.
#
# shared/main.tf is namespace-only by design ("Nothing here routes a zone"), so
# the zone routing lives in its OWN file here, not folded into main.tf.
#
# CR AUTHORITY: #157 is the approved change-request for this routing, so this IS
# its owed IaC PR; the repo rule "do not route a zone without a CR issue" is
# satisfied by #157 (tracked and productized under #248).
#
# ALREADY LIVE -- IMPORT, DO NOT CREATE. Both resources exist on the live zone
# (proven end-to-end under #157). A fresh `apply` would try to CREATE a second
# route and a duplicate record; the correct first step is to IMPORT the live
# ones so `terraform plan` is clean (no diff). Read the live ids, then:
#
#   SZ=a18f75d980042a17bec427edc6b04592   # skyphusionwp.dev (the SaaS home zone)
#   # route id:   GET /zones/$SZ/workers/routes            (the entry whose pattern is var.saas_route_pattern)
#   # record id:  GET /zones/$SZ/dns_records?type=AAAA&name=fallback.skyphusionwp.dev
#   terraform import cloudflare_workers_route.saas_dispatch "$SZ/<route_id>"
#   terraform import cloudflare_dns_record.saas_fallback   "$SZ/<record_id>"
#
# After import, `terraform plan` must show NO changes. If it shows a diff, the
# default below does not match the live value (most likely saas_route_pattern);
# reconcile the variable to the live read, never apply over it.

variable "saas_zone_id" {
  type        = string
  default     = "a18f75d980042a17bec427edc6b04592" # skyphusionwp.dev, the SaaS home (zone id, not a secret)
  description = "The Cloudflare for SaaS home zone whose */* dispatcher serves every tenant and custom hostname."
}

variable "saas_dispatcher" {
  type        = string
  default     = "wp-dispatch"
  description = "The one dispatcher Worker the SaaS home routes to. It routes by request Host through the site map, so one route serves every site. Deployed by up.sh, not by Terraform; this route references it by name."
}

variable "saas_route_pattern" {
  type        = string
  default     = "*/*"
  description = "The live Worker-route pattern on the SaaS home zone (the hand-applied value, per #157/#248). Must equal the live route's pattern exactly; verify with GET /zones/<zone>/workers/routes before import."
}

variable "saas_fallback_hostname" {
  type        = string
  default     = "fallback.skyphusionwp.dev"
  description = "The Cloudflare for SaaS fallback origin. A custom hostname CNAMEs here; this originless AAAA keeps the name proxied so the fallback resolves inside Cloudflare and never leaves the edge."
}

# The */* Worker route on the SaaS home zone to the one dispatcher. The
# dispatcher (wp-dispatch) routes by the request's own Host through the site map,
# so a single route serves every tenant site AND every attached custom hostname.
resource "cloudflare_workers_route" "saas_dispatch" {
  zone_id = var.saas_zone_id
  pattern = var.saas_route_pattern
  script  = var.saas_dispatcher
}

# The Cloudflare for SaaS fallback origin. A tenant's custom hostname is CNAMEd
# to this name (addCustomHostname returns it as the CNAME target); the record is
# an originless AAAA to 100:: kept PROXIED (orange cloud), the standard SaaS
# fallback so the hostname terminates at the edge and the */* route above runs.
# ttl = 1 because a proxied record is always auto-TTL.
resource "cloudflare_dns_record" "saas_fallback" {
  zone_id = var.saas_zone_id
  name    = var.saas_fallback_hostname
  type    = "AAAA"
  content = "100::"
  proxied = true
  ttl     = 1
}

output "saas_route_pattern" { value = cloudflare_workers_route.saas_dispatch.pattern }
output "saas_fallback_hostname" { value = cloudflare_dns_record.saas_fallback.name }
