# Variant c1: WordPress and WooCommerce in one Cloudflare Container (Workers
# Paid only). The code is spikes/c1-woo-container; docs/approach-c1.md explains
# it. Wrangler deploys the Worker and the Container. This file makes what
# Wrangler does not own: the replica bucket and the key that Litestream uses.
# The media bucket is cloudflare_r2_bucket.media in main.tf (always made for c1).
# There is no D1 database for c1 (main.tf makes D1 for b-do only): WordPress
# uses SQLite on the container disk.

locals {
  c1 = var.variant == "c1"
  # R2 permission groups (ids from GET /accounts/{id}/tokens/permission_groups).
  r2_item_read  = "6a018a9f2fc74eb6b293b0c548f38b39" # Workers R2 Storage Bucket Item Read
  r2_item_write = "2efd5506f9c8494dacb1fa10a3e7d5b6" # Workers R2 Storage Bucket Item Write
  # The R2 resource name for a bucket in the default jurisdiction.
  r2_resource = "com.cloudflare.edge.r2.bucket.${var.account_id}_default_"
}

# The Litestream replica of the SQLite file. A container loses its disk when it
# stops; the next container restores the database from here.
resource "cloudflare_r2_bucket" "replica" {
  count      = local.c1 ? 1 : 0
  account_id = var.account_id
  name       = "${var.name}-db"
  location   = var.location
}

# The container's only credential: read and write objects in the replica
# bucket. Not the media bucket (the Worker writes media through its R2
# binding) and nothing else in the account. R2's S3 API takes the token id as
# the access key id and the SHA-256 of the token value as the secret.
#
# teardown = true (destroy.sh only) adds the media bucket, so destroy.sh can
# empty both buckets: R2 refuses to delete a bucket that has objects. At that
# point the Worker and the container are already deleted.
resource "cloudflare_account_token" "litestream" {
  count      = local.c1 ? 1 : 0
  account_id = var.account_id
  name       = "${var.name}-litestream"
  policies = [{
    effect = "allow"
    permission_groups = [
      { id = local.r2_item_read },
      { id = local.r2_item_write },
    ]
    resources = jsonencode(merge(
      { "${local.r2_resource}${cloudflare_r2_bucket.replica[0].name}" = "*" },
      var.teardown ? { "${local.r2_resource}${cloudflare_r2_bucket.media[0].name}" = "*" } : {},
    ))
  }]
}

output "replica_bucket" {
  value = local.c1 ? cloudflare_r2_bucket.replica[0].name : ""
}

output "r2_endpoint" {
  value = "https://${var.account_id}.r2.cloudflarestorage.com"
}

output "litestream_access_key_id" {
  value = local.c1 ? cloudflare_account_token.litestream[0].id : ""
}

output "litestream_secret_access_key" {
  value     = local.c1 ? sha256(cloudflare_account_token.litestream[0].value) : ""
  sensitive = true
}
