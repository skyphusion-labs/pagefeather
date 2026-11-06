# deploy/wfp, one site (issue #35). One Terraform workspace per site (the
# workspace name is the site name). Its data plane: the media bucket, the
# secrets of its user Worker, and its entry in the site map. The user Worker
# (site-<name>) and its dispatcher (wp-<name>) are uploaded by up.sh.

variable "account_id" {
  type    = string
  default = "fabcb25d9c7eb087110ec474a03e50d2"
}

variable "name" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?$", var.name)) && var.name != "probe"
    error_message = "name: lower case, digits and hyphens, 1 to 30 characters, not probe."
  }
}

# The hostname the site answers on (phase A: wp-<name>.<subdomain>.workers.dev).
variable "hostname" { type = string }

variable "kv_namespace_id" { type = string }

# Per-call limits, applied by the dispatcher (docs/wfp.md item 4: cpuMs is
# not exact below about 2 s). 0 leaves a limit unset.
variable "cpu_ms" {
  type    = number
  default = 30000
}
variable "sub_requests" {
  type    = number
  default = 1000
}

# true only while down.sh empties the bucket: a key that can read and delete
# objects in this site's bucket and nothing else (as deploy/terraform does).
# down.sh makes it with -target, so nothing else is created then.
variable "teardown" {
  type    = bool
  default = false
}

locals {
  r2_item_read  = "6a018a9f2fc74eb6b293b0c548f38b39" # Workers R2 Storage Bucket Item Read
  r2_item_write = "2efd5506f9c8494dacb1fa10a3e7d5b6" # Workers R2 Storage Bucket Item Write
  r2_resource   = "com.cloudflare.edge.r2.bucket.${var.account_id}_default_"
  media_bucket  = "wp-wfp-${var.name}-media"
}

resource "cloudflare_r2_bucket" "media" {
  account_id = var.account_id
  name       = local.media_bucket
}

resource "random_password" "wp_salt" {
  length  = 64
  special = false
}
resource "random_password" "spike_token" {
  length  = 48
  special = false
}
resource "random_password" "admin_password" {
  length  = 24
  special = false
}

resource "cloudflare_workers_kv" "entry" {
  account_id   = var.account_id
  namespace_id = var.kv_namespace_id
  key_name     = var.hostname
  value = jsonencode(merge(
    { script = "site-${var.name}", outbound = true },
    var.cpu_ms > 0 ? { cpuMs = var.cpu_ms } : {},
    var.sub_requests > 0 ? { subRequests = var.sub_requests } : {},
  ))
}

resource "cloudflare_account_token" "teardown" {
  count      = var.teardown ? 1 : 0
  account_id = var.account_id
  name       = "wp-wfp-${var.name}-teardown"
  policies = [{
    effect = "allow"
    permission_groups = [
      { id = local.r2_item_read },
      { id = local.r2_item_write },
    ]
    # The bucket by its name, NOT by cloudflare_r2_bucket.media: with no
    # dependency, down.sh can apply -target=cloudflare_account_token.teardown
    # alone, and a down never creates the bucket or the site map entry (seen
    # live 2026-11-06: an apply in down re-created the missing entry).
    resources = jsonencode({ "${local.r2_resource}${local.media_bucket}" = "*" })
  }]
}

output "media_bucket" { value = cloudflare_r2_bucket.media.name }
output "hostname" { value = var.hostname }
output "r2_endpoint" { value = "https://${var.account_id}.r2.cloudflarestorage.com" }
output "wp_salt" {
  value     = random_password.wp_salt.result
  sensitive = true
}
output "spike_token" {
  value     = random_password.spike_token.result
  sensitive = true
}
output "admin_password" {
  value     = random_password.admin_password.result
  sensitive = true
}
# R2's S3 API: the token id is the access key id, the SHA-256 of its value the secret.
output "teardown_access_key_id" { value = var.teardown ? cloudflare_account_token.teardown[0].id : "" }
output "teardown_secret_access_key" {
  value     = var.teardown ? sha256(cloudflare_account_token.teardown[0].value) : ""
  sensitive = true
}
