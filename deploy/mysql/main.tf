# MySQL (MariaDB) for variant "a": WordPress in a Worker, database outside
# Cloudflare, reached through Hyperdrive. Port 3306 is open to Cloudflare's
# ranges only, and the database user must use SSL. There is no SSH: the box is
# rebuilt from this file, not changed by hand. Measured design and its traps:
# docs/approach-a.md.

resource "random_password" "db" {
  length  = 40
  special = false
}

# A Vultr firewall group with no rules allows all inbound traffic. The rules
# below are its only openings.
resource "vultr_firewall_group" "mysql" {
  description = "${var.name}-mysql: 3306 from Cloudflare only"
}

resource "vultr_firewall_rule" "mysql" {
  for_each          = toset(var.sources)
  firewall_group_id = vultr_firewall_group.mysql.id
  ip_type           = "v4"
  protocol          = "tcp"
  subnet            = split("/", each.value)[0]
  subnet_size       = tonumber(split("/", each.value)[1])
  port              = "3306"
  notes             = "Cloudflare (Hyperdrive)"
}

resource "vultr_instance" "mysql" {
  region            = var.region
  plan              = var.plan
  os_id             = 2284 # Ubuntu 24.04 LTS x64
  label             = "${var.name}-mysql"
  hostname          = "${var.name}-mysql"
  enable_ipv6       = false
  backups           = "disabled"
  activation_email  = false
  firewall_group_id = vultr_firewall_group.mysql.id
  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    db_password = random_password.db.result
  })
  depends_on = [vultr_firewall_rule.mysql]
}

resource "cloudflare_dns_record" "mysql" {
  zone_id = var.zone_id
  name    = var.hostname
  type    = "A"
  content = vultr_instance.mysql.main_ip
  proxied = false
  ttl     = 60
  comment = "WordPress database for ${var.name} (pagefeather deploy/mysql)"
}
