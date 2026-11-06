# deploy/wfp, the shared pieces (issue #35): the dispatch namespace and the
# site map. The Workers themselves (the dispatchers and the outbound Worker)
# are uploaded by up.sh from the templates in deploy/wfp, as deploy/ does.
# Nothing here routes a zone.

variable "account_id" {
  type    = string
  default = "fabcb25d9c7eb087110ec474a03e50d2" # Skyphusion Labs (Workers Paid, WfP on)
}

variable "namespace" {
  type    = string
  default = "wp-wfp"
}

resource "cloudflare_workers_for_platforms_dispatch_namespace" "wfp" {
  account_id = var.account_id
  name       = var.namespace
}

# The site map: hostname -> {"script", "cpuMs", "subRequests", "outbound"}.
# Each site's own workspace (../site) writes its entry.
resource "cloudflare_workers_kv_namespace" "sites" {
  account_id = var.account_id
  title      = "wp-wfp-sites"
}

output "account_id" { value = var.account_id }
output "namespace" { value = cloudflare_workers_for_platforms_dispatch_namespace.wfp.name }
output "kv_namespace_id" { value = cloudflare_workers_kv_namespace.sites.id }
