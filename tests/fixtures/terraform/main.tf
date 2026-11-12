# The test fixture bucket (fleet-chezmoi#2575). Every WordPress test loads the WooCommerce sample
# store, and this bucket holds that store as a file: one object per fixture version,
# sample-store/<YYYYMMDD>-<sha12>.sql.gz. Its own root and its own state, NOT deploy/wfp/terraform/
# shared: deploy/wfp/down.sh destroys that root, which would take the fixture with every reference
# teardown (and fail, because R2 will not delete a bucket that holds objects).
#
# Private: no r2.dev public URL (disabled explicitly below), no custom domain, no CORS. Access is
# per-function R2 tokens scoped to this bucket only, minted outside this root (CR step 2).

# No default: the same rule as deploy/wfp (pass TF_VAR_account_id, or -var).
variable "account_id" {
  type = string
}

resource "cloudflare_r2_bucket" "fixtures" {
  account_id = var.account_id
  name       = "wp-test-fixtures"

  # A destroy must not delete a fixture by accident. Removing it is a reviewed change: delete this
  # block, empty the bucket, then destroy (the CR rollback).
  lifecycle {
    prevent_destroy = true
  }
}

# The public r2.dev URL, OFF. Off is the default for a new bucket; this states it, so a dashboard
# toggle shows up as drift in the next plan.
resource "cloudflare_r2_managed_domain" "fixtures" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.fixtures.name
  enabled     = false
}

output "bucket" { value = cloudflare_r2_bucket.fixtures.name }
