output "hostname" { value = var.hostname }
output "box_ip" { value = vultr_instance.src.main_ip }

# For cloudflared access ssh (ProxyCommand). Sensitive: read with terraform output -raw.
output "access_client_id" { value = cloudflare_zero_trust_access_service_token.src.client_id }
output "access_client_secret" {
  value     = cloudflare_zero_trust_access_service_token.src.client_secret
  sensitive = true
}

output "admin_password" {
  value     = random_password.admin.result
  sensitive = true
}

# A ~/.ssh/config block for the run. The service token comes from the
# environment (TUNNEL_SERVICE_TOKEN_ID and TUNNEL_SERVICE_TOKEN_SECRET, which
# cloudflared reads), so it is not written into the file.
output "ssh_config" {
  value = <<-CFG
    Host ${var.hostname}
      User importer
      ProxyCommand cloudflared access ssh --hostname %h
      StrictHostKeyChecking accept-new
  CFG
}
