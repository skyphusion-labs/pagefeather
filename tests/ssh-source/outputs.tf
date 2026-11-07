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

# ---- CR #141: the import route (empty strings when enable_mysql_import is off) --
# The lead feeds these to deploy.sh VARIANT=a MYSQL=external:
#   MYSQL_HOST                = mysql_import_hostname
#   MYSQL_PASSWORD            = db_password        (the box's wp user)
#   MYSQL_ACCESS_CLIENT_ID    = mysql_import_access_client_id
#   MYSQL_ACCESS_CLIENT_SECRET = mysql_import_access_client_secret
# MYSQL_USER defaults to wp and MYSQL_DATABASE to wordpress (the cloud-init grant).

output "mysql_import_hostname" {
  value = var.enable_mysql_import ? var.mysql_import_hostname : ""
}

output "mysql_import_access_client_id" {
  value = one(cloudflare_zero_trust_access_service_token.mysql_import[*].client_id)
}

output "mysql_import_access_client_secret" {
  value     = one(cloudflare_zero_trust_access_service_token.mysql_import[*].client_secret)
  sensitive = true
}

# The wp database user's password (random_password.db), for the Hyperdrive
# origin of the import run. Sensitive: read with terraform output -raw.
output "db_password" {
  value     = random_password.db.result
  sensitive = true
}
