# A throwaway WordPress source for the SSH import of #31 (#83). The box takes
# no inbound traffic: SSH reaches it only through a Cloudflare Tunnel, behind
# Access with a service token. Design: #31 comment 6681505234. DNS: CR #101.
# Teardown: terraform destroy here removes every part below.
#
# CR #141 adds, behind the enable_mysql_import switch (off by default), a
# second route on the SAME tunnel: TCP 3306 on its own hostname, behind its
# own Access service token, for the #31 live variant-a round trip. It is added
# ALONGSIDE the SSH route; the SSH route is never changed.

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "random_password" "admin" {
  length  = 24
  special = false
}

# The tunnel, managed from Cloudflare: SSH on the box, and (CR #141, optional)
# TCP 3306 on the import hostname.
resource "cloudflare_zero_trust_tunnel_cloudflared" "src" {
  account_id = var.account_id
  name       = "wp-ssh-source"
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "src" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.src.id
  config = {
    # SSH is always first and the 404 catch-all is always last. The 3306 rule
    # is inserted between them only when enable_mysql_import is true, so with
    # it off the ingress is byte-for-byte the SSH-only list of #83.
    ingress = concat(
      [{ hostname = var.hostname, service = "ssh://localhost:22" }],
      var.enable_mysql_import ? [{ hostname = var.mysql_import_hostname, service = "tcp://localhost:3306" }] : [],
      [{ service = "http_status:404" }],
    )
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

# ---- CR #141: the TCP 3306 import route (enable_mysql_import) ----------------
# Its own hostname, its own service token, its own policy and its own Access
# application, all scoped to that one hostname. The MariaDB it reaches is the
# box's own (cloud-init makes database wordpress and user wp on localhost); the
# tunnel terminates at localhost:3306, so 'wp'@'localhost' is the right grant.
# This is the proven tests/a/terraform pattern (CR #27): tunnel, 3306 ingress,
# service_token-only policy, Access application on the hostname. It never uses
# the deploy/mysql model (a Vultr firewall opening 3306 to Cloudflare IP
# ranges): the box opens no inbound port and there is no IP allowlist.

resource "cloudflare_dns_record" "mysql_import" {
  count   = var.enable_mysql_import ? 1 : 0
  zone_id = var.mysql_import_zone_id
  name    = var.mysql_import_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.src.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
  comment = "wordpress-on-cloudflare #31 variant-a live import, TCP 3306, temporary (CR #141)"
}

resource "cloudflare_zero_trust_access_service_token" "mysql_import" {
  count      = var.enable_mysql_import ? 1 : 0
  account_id = var.account_id
  name       = "wp-mysql-import-a"
  duration   = "24h"
}

resource "cloudflare_zero_trust_access_policy" "mysql_import_only" {
  count      = var.enable_mysql_import ? 1 : 0
  account_id = var.account_id
  name       = "wp-mysql-import-a service token"
  decision   = "non_identity"
  include    = [{ service_token = { token_id = cloudflare_zero_trust_access_service_token.mysql_import[0].id } }]
}

resource "cloudflare_zero_trust_access_application" "mysql_import" {
  count            = var.enable_mysql_import ? 1 : 0
  account_id       = var.account_id
  name             = "wp-mysql-import-a"
  type             = "self_hosted"
  domain           = var.mysql_import_hostname
  session_duration = "1h"
  policies         = [{ id = cloudflare_zero_trust_access_policy.mysql_import_only[0].id, precedence = 1 }]
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
