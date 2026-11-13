# deploy/wfp, one site (issue #35). One Terraform workspace per site (the
# workspace name is the site name). Its data plane: the media bucket, the
# secrets of its user Worker, and its entry in the site map. The user Worker
# (site-<name>) and its dispatcher are uploaded by up.sh. Phase A deploys a
# per-site dispatcher (wp-<name>) on workers.dev; phase B (#138) attaches a
# Workers Custom Domain for this site to the ONE dispatcher instead.

# No default: lib.sh need_account passes it (TF_VAR_account_id), and a plan with
# no account fails instead of planning against another account.
variable "account_id" {
  type = string
}

variable "name" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?$", var.name)) && var.name != "probe"
    error_message = "name: lower case, digits and hyphens, 1 to 30 characters, not probe."
  }
}

# The hostname the site answers on and the site map key. Phase A:
# wp-<name>.<subdomain>.workers.dev. Phase B (#138): <name>.wfp-test.skyphusion.org,
# the same value the Custom Domain below carries, so the key and the routed
# hostname can never drift. site.sh / site compute it (lib.sh site_host).
variable "hostname" { type = string }

# The build id of the deployed user Worker (issue #35 slice 5): recorded in the
# site map entry, read by "site update" as the rollback target. site.sh takes
# it from the built bundle (build/build-id.js).
variable "build" {
  type    = string
  default = "dev"
}

# sha256 of the rendered user config and the sorted secret key names (#421).
# Empty for a site recorded before that change. site update treats empty as a
# difference and uploads once. This value is never a secret.
variable "config_hash" {
  type    = string
  default = ""

  validation {
    condition     = var.config_hash == "" || can(regex("^[0-9a-f]{64}$", var.config_hash))
    error_message = "config_hash must be empty or 64 lower-case hex characters."
  }
}

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

# true only while "site import" puts an existing site's uploads into the bucket
# (deploy/import.sh, issue #31 for deploy/wfp): a key that can read and write
# objects in this site's bucket and nothing else, as deploy/terraform's
# media_import key is. "site import" makes it with -target and deletes it after
# the import, also when the import fails.
variable "media_import" {
  type    = bool
  default = false
}

# Phase B (#138), CR gated. When true, attach a Workers Custom Domain for this
# site to the one dispatcher (var.dispatcher). The live attach is a CR #138
# step (add-and-prove-before-you-remove); nothing here applies until this is
# true. false is the default, so phase A (workers.dev) stays the only live
# target.
variable "custom_domain" {
  type    = bool
  default = false
}

# Phase B: the one dispatcher Worker the Custom Domain attaches to (its service
# name). The same dispatcher/worker.js as phase A, deployed once as wp-dispatch.
variable "dispatcher" {
  type    = string
  default = "wp-dispatch"
}

# Phase B: the zone that holds the site's Custom Domain (WFP_ZONE_ID, passed by
# lib.sh need_account, or recorded by an existing site). No zone default: a
# Custom Domain with no zone fails at plan (the precondition on the domain).
variable "zone_id" {
  type    = string
  default = ""
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
    { script = "site-${var.name}", outbound = true, build = var.build },
    var.config_hash != "" ? { config_hash = var.config_hash } : {},
    var.cpu_ms > 0 ? { cpuMs = var.cpu_ms } : {},
    var.sub_requests > 0 ? { subRequests = var.sub_requests } : {},
  ))
}

# Phase B (#138): the Workers Custom Domain for this site on the one dispatcher.
# var.hostname is BOTH this domain and the site map key above, so the routed
# hostname and the key are the same value by construction. Created only when
# custom_domain = true; phase A leaves it unset. The dispatcher must already be
# deployed (up.sh) when this applies, because a Custom Domain attaches to an
# existing service. Cloudflare creates the DNS record and the Advanced
# Certificate for the hostname (Custom Domains docs, read 2026-11-06).
resource "cloudflare_workers_custom_domain" "site" {
  count      = var.custom_domain ? 1 : 0
  account_id = var.account_id
  zone_id    = var.zone_id
  hostname   = var.hostname
  service    = var.dispatcher

  lifecycle {
    precondition {
      condition     = var.zone_id != ""
      error_message = "zone_id: a Custom Domain needs its zone. Set WFP_ZONE_ID (the reference deploy sources deploy/wfp/reference.env)."
    }
  }
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

resource "cloudflare_account_token" "media_import" {
  count      = var.media_import ? 1 : 0
  account_id = var.account_id
  name       = "wp-wfp-${var.name}-media-import"
  policies = [{
    effect = "allow"
    permission_groups = [
      { id = local.r2_item_read },
      { id = local.r2_item_write },
    ]
    # The bucket by its name, as for the teardown key: with no dependency,
    # "site import" applies -target=cloudflare_account_token.media_import
    # alone, so an import can never create or change anything else.
    resources = jsonencode({ "${local.r2_resource}${local.media_bucket}" = "*" })
  }]
}

output "media_bucket" { value = cloudflare_r2_bucket.media.name }
output "hostname" { value = var.hostname }
output "custom_domain_hostname" {
  value = var.custom_domain ? cloudflare_workers_custom_domain.site[0].hostname : ""
}
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
output "media_import_access_key_id" { value = var.media_import ? cloudflare_account_token.media_import[0].id : "" }
output "media_import_secret_access_key" {
  value     = var.media_import ? sha256(cloudflare_account_token.media_import[0].value) : ""
  sensitive = true
}
output "teardown_access_key_id" { value = var.teardown ? cloudflare_account_token.teardown[0].id : "" }
output "teardown_secret_access_key" {
  value     = var.teardown ? sha256(cloudflare_account_token.teardown[0].value) : ""
  sensitive = true
}
