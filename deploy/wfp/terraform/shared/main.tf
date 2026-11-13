# deploy/wfp, the shared pieces (issue #35): the dispatch namespace and the
# site map. The Workers themselves (the dispatchers and the outbound Worker)
# are uploaded by up.sh from the templates in deploy/wfp, as deploy/ does.
# Nothing here routes a zone.

# No default: lib.sh need_account passes it (TF_VAR_account_id).
variable "account_id" {
  type = string
}

variable "namespace" {
  type    = string
  default = "wp-wfp"
}

resource "cloudflare_workers_for_platforms_dispatch_namespace" "wfp" {
  account_id = var.account_id
  name       = var.namespace
}

# The site map: hostname -> script, limits, outbound, the build id, and an
# optional config_hash (#421). Each site's own workspace (../site) writes its entry.
resource "cloudflare_workers_kv_namespace" "sites" {
  account_id = var.account_id
  title      = "wp-wfp-sites"
}

output "account_id" { value = var.account_id }
output "namespace" { value = cloudflare_workers_for_platforms_dispatch_namespace.wfp.name }
output "kv_namespace_id" { value = cloudflare_workers_kv_namespace.sites.id }
