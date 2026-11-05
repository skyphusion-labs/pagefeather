# Workers for Platforms verification spike (issue #35). Terraform makes the
# dispatch namespace and the data plane the test user Workers bind to. Wrangler
# uploads the code (tests/wfp/run.sh). Nothing here routes a zone: every Worker
# is on workers.dev.
#
# Do not touch the other namespaces in this account (vivijure-*, vhc-*): this
# root manages only the resources below.

variable "account_id" {
  type    = string
  default = "fabcb25d9c7eb087110ec474a03e50d2" # Skyphusion Labs (Workers Paid)
}

variable "prefix" {
  type    = string
  default = "wp-on-cf-wfp"
}

resource "cloudflare_workers_for_platforms_dispatch_namespace" "spike" {
  account_id = var.account_id
  name       = "wp-on-cf-spike"
}

# Item 3: a D1 database and an R2 bucket for the user Worker bindings.
resource "cloudflare_d1_database" "spike" {
  account_id       = var.account_id
  name             = "${var.prefix}-d1"
  read_replication = { mode = "disabled" }
}

resource "cloudflare_r2_bucket" "spike" {
  account_id = var.account_id
  name       = "${var.prefix}-r2"
}

# The b-dosql site in the namespace (tests/wfp/dosql.sh): its secrets, as in
# deploy/terraform. They reach the user Worker with --secrets-file.
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

output "account_id" { value = var.account_id }
output "namespace" { value = cloudflare_workers_for_platforms_dispatch_namespace.spike.name }
output "d1_id" { value = cloudflare_d1_database.spike.id }
output "d1_name" { value = cloudflare_d1_database.spike.name }
output "r2_bucket" { value = cloudflare_r2_bucket.spike.name }
output "prefix" { value = var.prefix }
