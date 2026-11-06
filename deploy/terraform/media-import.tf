# The key that deploy/import.sh uses to put an existing site's uploads into the
# media bucket through R2's S3 API (issue #31). It exists only during an
# import: import.sh applies with media_import = true, sends the files, and
# applies with false again (also when the import fails), which deletes it.
# Scope: read and write objects in this site's media bucket, nothing else.
# R2's S3 API takes the token id as the access key id and the SHA-256 of the
# token value as the secret (as for the Litestream key in c1.tf).

locals {
  media_import = var.media_import && (var.media || local.c1)
}

resource "cloudflare_account_token" "media_import" {
  count      = local.media_import ? 1 : 0
  account_id = var.account_id
  name       = "${var.name}-media-import"
  policies = [{
    effect = "allow"
    permission_groups = [
      { id = local.r2_item_read },
      { id = local.r2_item_write },
    ]
    resources = jsonencode({ "${local.r2_resource}${cloudflare_r2_bucket.media[0].name}" = "*" })
  }]
}

output "media_import_access_key_id" {
  value = local.media_import ? cloudflare_account_token.media_import[0].id : ""
}

output "media_import_secret_access_key" {
  value     = local.media_import ? sha256(cloudflare_account_token.media_import[0].value) : ""
  sensitive = true
}
