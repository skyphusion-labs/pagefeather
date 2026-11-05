output "account_id" { value = var.account_id }
output "name" { value = var.name }
output "variant" { value = var.variant }
output "location" { value = var.location }
output "d1_id" { value = one(cloudflare_d1_database.wp[*].id) }
output "d1_name" { value = one(cloudflare_d1_database.wp[*].name) }
output "hyperdrive_id" { value = one(cloudflare_hyperdrive_config.wp[*].id) }
output "media_bucket" { value = var.media ? cloudflare_r2_bucket.media[0].name : "" }

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
