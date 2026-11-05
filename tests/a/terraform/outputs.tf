output "host" {
  value = local.host
}

output "hyperdrive" {
  value = {
    a_paid        = cloudflare_hyperdrive_config.a_paid.id
    a_free        = cloudflare_hyperdrive_config.a_free.id
    a_paid_public = one(cloudflare_hyperdrive_config.a_paid_public[*].id)
    a_free_public = one(cloudflare_hyperdrive_config.a_free_public[*].id)
  }
}

output "db_password" {
  value     = random_password.db.result
  sensitive = true
}

output "access_client_id" {
  value = cloudflare_zero_trust_access_service_token.hyperdrive.client_id
}

output "access_client_secret" {
  value     = cloudflare_zero_trust_access_service_token.hyperdrive.client_secret
  sensitive = true
}

output "hwp_s3_access_key_id" {
  value = cloudflare_account_token.hwp_media_s3.id
}

output "hwp_s3_secret_access_key" {
  value     = sha256(cloudflare_account_token.hwp_media_s3.value)
  sensitive = true
}

output "hwp_deploy_token_paid" {
  value     = cloudflare_account_token.hwp_deploy_paid.value
  sensitive = true
}

output "hwp_deploy_token_free" {
  value     = cloudflare_account_token.hwp_deploy_free.value
  sensitive = true
}
