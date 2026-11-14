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

# #515: set when a rollback's data restore FAILED, to the snapshot key that restores the site
# (<site>/<build>-<time>.ndjson under _snapshots/). The database is partial until a restore runs
# through, so "site update" refuses while it is set; "site restore" clears it. site_vars passes
# the recorded value to every apply, so no other apply clears it by leaving it out.
variable "data_hold" {
  type    = string
  default = ""

  validation {
    condition     = can(regex("^[A-Za-z0-9._/-]{0,200}$", var.data_hold))
    error_message = "data_hold must be empty or a snapshot key ([A-Za-z0-9._/-], at most 200 characters)."
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
  media_bucket = "wp-wfp-${var.name}-media"
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
    var.data_hold != "" ? { data_hold = var.data_hold } : {},
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

# No account token here (#273): the keys that empty the bucket (site down) and put an import's
# uploads (site import) are temporary R2 credentials minted from the deploy token
# (deploy/wfp/r2_temp.py), so the deploy token needs no API Tokens permission.

output "media_bucket" { value = cloudflare_r2_bucket.media.name }
output "hostname" { value = var.hostname }
output "data_hold" { value = var.data_hold }
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
