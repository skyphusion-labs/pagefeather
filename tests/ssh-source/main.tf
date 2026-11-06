# A throwaway WordPress source for the SSH import of #31 (#83). The box takes
# no inbound traffic: SSH reaches it only through a Cloudflare Tunnel, behind
# Access with a service token. Design: #31 comment 6681505234. DNS: CR #101.
# Teardown: terraform destroy here removes every part below.

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "random_password" "admin" {
  length  = 24
  special = false
}

# The tunnel, managed from Cloudflare: its only route is SSH on the box.
resource "cloudflare_zero_trust_tunnel_cloudflared" "src" {
  account_id = var.account_id
  name       = "wp-ssh-source"
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "src" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.src.id
  config = {
    ingress = [
      { hostname = var.hostname, service = "ssh://localhost:22" },
      { service = "http_status:404" },
    ]
  }
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "src" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.src.id
}

resource "cloudflare_dns_record" "src" {
  zone_id = var.zone_id
  name    = var.hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.src.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
  comment = "wordpress-on-cloudflare #83 SSH test source, temporary (CR #101)"
}

# Access: only the service token passes (no identity login).
resource "cloudflare_zero_trust_access_service_token" "src" {
  account_id = var.account_id
  name       = "wp-ssh-source"
  duration   = "24h"
}

resource "cloudflare_zero_trust_access_policy" "src" {
  account_id = var.account_id
  name       = "wp-ssh-source service token"
  decision   = "non_identity"
  include    = [{ service_token = { token_id = cloudflare_zero_trust_access_service_token.src.id } }]
}

resource "cloudflare_zero_trust_access_application" "src" {
  account_id       = var.account_id
  name             = "wp-ssh-source"
  type             = "self_hosted"
  domain           = var.hostname
  session_duration = "1h"
  policies         = [{ id = cloudflare_zero_trust_access_policy.src.id, precedence = 1 }]
}

# Vultr: a firewall group with NO rules allows all inbound traffic (measured in
# deploy/mysql). One rule that matches nothing (ICMP from a documentation
# address) makes the group drop everything else.
resource "vultr_firewall_group" "src" {
  description = "wp-ssh-source: no inbound (the tunnel is outbound)"
}

resource "vultr_firewall_rule" "none" {
  firewall_group_id = vultr_firewall_group.src.id
  protocol          = "icmp"
  ip_type           = "v4"
  subnet            = "192.0.2.1"
  subnet_size       = 32
  notes             = "matches nothing: a group with a rule drops all other inbound"
}

resource "vultr_instance" "src" {
  region            = var.region
  plan              = var.plan
  os_id             = 2284 # Ubuntu 24.04 LTS x64
  label             = "wp-ssh-source"
  hostname          = "wp-ssh-source"
  firewall_group_id = vultr_firewall_group.src.id
  enable_ipv6       = false
  backups           = "disabled"
  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    ssh_public_key = var.ssh_public_key
    tunnel_token   = data.cloudflare_zero_trust_tunnel_cloudflared_token.src.token
    db_password    = random_password.db.result
    admin_password = random_password.admin.result
  })
  depends_on = [vultr_firewall_rule.none, cloudflare_zero_trust_tunnel_cloudflared_config.src]
}
