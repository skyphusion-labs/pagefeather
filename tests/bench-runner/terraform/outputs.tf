output "bucket" { value = cloudflare_r2_bucket.jobs.name }
output "endpoint" { value = local.r2_endpoint }
output "access_key_id" { value = cloudflare_account_token.runner.id }

output "secret_access_key" {
  value     = local.r2_secret
  sensitive = true
}

output "instance_id" { value = vultr_instance.runner.id }
output "ip" { value = vultr_instance.runner.main_ip }
output "region" { value = var.region }
output "plan" { value = var.plan }
