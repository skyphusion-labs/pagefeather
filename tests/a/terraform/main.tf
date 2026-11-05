# Approach A test origin (issue #1, CR #27): MariaDB on a Vultr box, reached by
# Hyperdrive through a Cloudflare Tunnel with an Access service token. Used by
# our approach A Worker (spikes/b2-wordpress, env a-free and a-paid) and by
# HostlessWP measured as-is (tests/a/hostlesswp.md). Destroy it when the A
# numbers are in docs/results.md: `terraform destroy` (see README.md).

locals {
  account_id      = "fabcb25d9c7eb087110ec474a03e50d2" # Skyphusion Labs (Workers Paid)
  free_account_id = "32ce15b8adb82f5a85b67d6c46b28177" # test account (Workers Free)
  zone_id         = "3b58b52bd324332fb56b3ab685588c76" # skyphusion.org
  host            = "mysql-a.skyphusion.org"
}

resource "random_password" "db" {
  length  = 40
  special = false
}

# ---- Tunnel and Access ------------------------------------------------------

resource "cloudflare_zero_trust_tunnel_cloudflared" "mysql" {
  account_id = local.account_id
  name       = "wp-a-mysql"
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "mysql" {
  account_id = local.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.mysql.id
  config = {
    ingress = [
      { hostname = local.host, service = "tcp://localhost:3306" },
      { service = "http_status:404" },
    ]
  }
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "mysql" {
  account_id = local.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.mysql.id
}

resource "cloudflare_dns_record" "mysql" {
  zone_id = local.zone_id
  name    = local.host
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.mysql.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
  comment = "wordpress-on-cloudflare approach A test origin (tests/a/terraform)"
}

resource "cloudflare_zero_trust_access_service_token" "hyperdrive" {
  account_id = local.account_id
  name       = "wp-a-hyperdrive"
  duration   = "8760h"
}

resource "cloudflare_zero_trust_access_policy" "hyperdrive_only" {
  account_id = local.account_id
  name       = "wp-a-hyperdrive-only"
  decision   = "non_identity"
  include = [
    { service_token = { token_id = cloudflare_zero_trust_access_service_token.hyperdrive.id } },
  ]
}

resource "cloudflare_zero_trust_access_application" "mysql" {
  account_id = local.account_id
  name       = "wp-a-mysql"
  type       = "self_hosted"
  domain     = local.host
  policies = [
    { id = cloudflare_zero_trust_access_policy.hyperdrive_only.id, precedence = 1 },
  ]
}

# ---- The box ----------------------------------------------------------------

# A Vultr firewall group with no rules allows ALL inbound. The sentinel rule
# (port 1 from a documentation address) makes it deny everything else.
resource "vultr_firewall_group" "mysql" {
  description = "wp-a-mysql: no inbound (sentinel rule only)"
}

resource "vultr_firewall_rule" "sentinel" {
  firewall_group_id = vultr_firewall_group.mysql.id
  ip_type           = "v4"
  protocol          = "tcp"
  subnet            = "192.0.2.1"
  subnet_size       = 32
  port              = "1"
  notes             = "sentinel: a group with no rules allows all"
}

resource "vultr_firewall_rule" "mysql_public" {
  for_each          = var.public_mysql ? toset(var.public_mysql_sources) : toset([])
  firewall_group_id = vultr_firewall_group.mysql.id
  ip_type           = "v4"
  protocol          = "tcp"
  subnet            = split("/", each.value)[0]
  subnet_size       = tonumber(split("/", each.value)[1])
  port              = "3306"
  notes             = "mysql public path (HostlessWP test)"
}

resource "vultr_instance" "mysql" {
  region            = var.region
  plan              = var.plan
  os_id             = 2284 # Ubuntu 24.04 LTS x64
  label             = "wp-a-mysql"
  hostname          = "wp-a-mysql"
  enable_ipv6       = false
  backups           = "disabled"
  activation_email  = false
  firewall_group_id = vultr_firewall_group.mysql.id
  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    db_password  = random_password.db.result
    tunnel_token = data.cloudflare_zero_trust_tunnel_cloudflared_token.mysql.token
    public       = var.public_mysql
  })
  depends_on = [vultr_firewall_rule.sentinel, cloudflare_zero_trust_tunnel_cloudflared_config.mysql]
}

# Hyperdrive checks the database when a config is made, so wait until the
# tunnel connector (installed last by cloud-init) is connected.
resource "terraform_data" "db_ready" {
  triggers_replace = [vultr_instance.mysql.id]
  provisioner "local-exec" {
    # Count only connections opened after this wait started: after a replace,
    # the old box's connections are still listed for a while (measured
    # 2026-11-05: the wait passed in 1 s and Hyperdrive got no database).
    command = <<-EOT
      start=$(date -u +%Y-%m-%dT%H:%M:%S)
      for i in $(seq 1 60); do
        n=$(curl -sf -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
          "https://api.cloudflare.com/client/v4/accounts/${local.account_id}/cfd_tunnel/${cloudflare_zero_trust_tunnel_cloudflared.mysql.id}" \
          | START=$start python3 -c 'import json,os,sys; c=json.load(sys.stdin)["result"].get("connections") or []; print(sum(1 for x in c if x.get("opened_at","")[:19] > os.environ["START"]))')
        [ "$${n:-0}" -gt 0 ] && exit 0
        sleep 10
      done
      echo "tunnel not connected after 10 minutes" >&2; exit 1
    EOT
  }
}

# ---- Hyperdrive -------------------------------------------------------------

locals {
  origin = {
    scheme               = "mysql"
    host                 = local.host
    database             = "wordpress"
    user                 = "wp"
    password             = random_password.db.result
    access_client_id     = cloudflare_zero_trust_access_service_token.hyperdrive.client_id
    access_client_secret = cloudflare_zero_trust_access_service_token.hyperdrive.client_secret
  }
}

# Caching off: WordPress reads its own writes (HostlessWP makes its configs the
# same way).
resource "cloudflare_hyperdrive_config" "a_paid" {
  account_id = local.account_id
  name       = "wp-a-paid"
  origin     = local.origin
  caching    = { disabled = true }
  depends_on = [terraform_data.db_ready]
}

resource "cloudflare_hyperdrive_config" "a_free" {
  provider   = cloudflare.free_hyperdrive
  account_id = local.free_account_id
  name       = "wp-a-free"
  origin     = local.origin
  caching    = { disabled = true }
  depends_on = [terraform_data.db_ready]
}

# The public path (var.public_mysql). HostlessWP is not given a config: its
# own CLI creates "hostlesswp-<worker>" against this public name, as it does
# for any user (measured as-is). These two are for our approach A.
resource "cloudflare_dns_record" "mysql_public" {
  count   = var.public_mysql ? 1 : 0
  zone_id = local.zone_id
  name    = "mysql-a-public.skyphusion.org"
  type    = "A"
  content = vultr_instance.mysql.main_ip
  proxied = false
  ttl     = 60
  comment = "wordpress-on-cloudflare approach A test origin, public MySQL path (tests/a/terraform)"
}

locals {
  origin_public = {
    scheme = "mysql"
    # The name, not the address. Measured 2026-11-05 from the same Worker
    # (placement ORD) to the same database: origin as the IP, 44 ms median per
    # query and about 150 ms for the first; origin as this name, 7 ms and 20 ms.
    # (Right after the record was created, Hyperdrive answered "DNS lookup
    # failed" a few times; it resolved once the record had propagated.)
    host     = "mysql-a-public.skyphusion.org"
    port     = 3306
    database = "wordpress"
    user     = "wp"
    password = random_password.db.result
  }
}

resource "cloudflare_hyperdrive_config" "a_paid_public" {
  count      = var.public_mysql ? 1 : 0
  account_id = local.account_id
  name       = "wp-a-paid-public"
  origin     = local.origin_public
  caching    = { disabled = true }
  depends_on = [terraform_data.db_ready, vultr_firewall_rule.mysql_public, cloudflare_dns_record.mysql_public]
}

resource "cloudflare_hyperdrive_config" "a_free_public" {
  count      = var.public_mysql ? 1 : 0
  provider   = cloudflare.free_hyperdrive
  account_id = local.free_account_id
  name       = "wp-a-free-public"
  origin     = local.origin_public
  caching    = { disabled = true }
  depends_on = [terraform_data.db_ready, vultr_firewall_rule.mysql_public, cloudflare_dns_record.mysql_public]
}

# ---- Media and tokens -------------------------------------------------------

# Approach A Paid media (the Worker's R2 binding).
resource "cloudflare_r2_bucket" "a_paid_media" {
  account_id = local.account_id
  name       = "wp-a-paid-media"
  location   = "enam"
}

# HostlessWP media, both sites (prefixes paid/ and free/). R2 is not on for
# the Free test account, so the Free site uses this bucket through the S3 API.
resource "cloudflare_r2_bucket" "hwp_media" {
  account_id = local.account_id
  name       = "hostlesswp-media"
  location   = "enam"
}

# S3 key for hostlesswp-media only. Access key id = token id, secret = SHA-256
# of the token value (outputs).
resource "cloudflare_account_token" "hwp_media_s3" {
  account_id = local.account_id
  name       = "hostlesswp-media-s3"
  policies = [{
    effect = "allow"
    permission_groups = [
      { id = "6a018a9f2fc74eb6b293b0c548f38b39" }, # Workers R2 Storage Bucket Item Read
      { id = "2efd5506f9c8494dacb1fa10a3e7d5b6" }, # Workers R2 Storage Bucket Item Write
    ]
    resources = jsonencode({
      "com.cloudflare.edge.r2.bucket.${local.account_id}_default_hostlesswp-media" = "*"
    })
  }]
}

# The permissions HostlessWP's own check names (lib/cloudflare.mjs at 739e8e7).
locals {
  hwp_groups = [
    { id = "e086da7e2179491d91ee5f35b3ca210a" }, # Workers Scripts Write
    { id = "721b2f51fba74871bd361de65aeb7e03" }, # Hyperdrive Write
    { id = "f7f0eda5697f475c90846e879bab8666" }, # Workers KV Storage Write
    { id = "c1fde68c7bcc44588cbb6ddbc16d6480" }, # Account Settings Read
    { id = "05880cd1bdc24d8bae0be2136972816b" }, # Workers Tail Read
  ]
}

resource "cloudflare_account_token" "hwp_deploy_paid" {
  account_id = local.account_id
  name       = "hostlesswp-deploy"
  policies = [{
    effect            = "allow"
    permission_groups = local.hwp_groups
    resources         = jsonencode({ "com.cloudflare.api.account.${local.account_id}" = "*" })
  }]
}

resource "cloudflare_account_token" "hwp_deploy_free" {
  provider   = cloudflare.free_admin
  account_id = local.free_account_id
  name       = "hostlesswp-deploy"
  policies = [{
    effect            = "allow"
    permission_groups = local.hwp_groups
    resources         = jsonencode({ "com.cloudflare.api.account.${local.free_account_id}" = "*" })
  }]
}
