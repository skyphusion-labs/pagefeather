# The data plane of one WordPress site on Cloudflare. Wrangler deploys the
# code; deploy.sh makes its config from the outputs of this file, so no id is
# copied by hand.

resource "cloudflare_d1_database" "wp" {
  count                 = var.variant == "b-do" ? 1 : 0
  account_id            = var.account_id
  name                  = var.name
  primary_location_hint = var.location
  read_replication      = { mode = "disabled" }
}

# c1 always has a media bucket: its Worker serves uploads from R2.
resource "cloudflare_r2_bucket" "media" {
  count      = var.media || local.c1 ? 1 : 0
  account_id = var.account_id
  name       = "${var.name}-media"
}

# Secrets for the Worker. They live in Terraform state (keep it private) and
# reach the Worker through `wrangler secret bulk` in deploy.sh.
resource "random_password" "wp_salt" {
  length  = 64
  special = false
}

resource "random_password" "spike_token" {
  length  = 48
  special = false
}

resource "random_password" "admin_password" {
  length  = 24
  special = false
}

# Variant "a": Hyperdrive to the MySQL server. Caching off: WordPress reads its
# own writes. Hyperdrive checks the connection when it makes the config, so the
# database must answer first (deploy.sh retries while a new box starts).
#
# Two origin shapes, chosen by whether an Access service token is given:
#   public (mysql_access_client_id empty): host on mysql_port, SSL required.
#     The deploy/mysql path, unchanged.
#   tunnel (CR #141): host with access_client_id and access_client_secret and
#     NO port. Hyperdrive reaches the box through its Cloudflare Tunnel behind
#     Access, so no inbound port is open. This is the tests/a/terraform shape.
locals {
  mysql_use_access = var.variant == "a" && var.mysql_access_client_id != ""
}

resource "cloudflare_hyperdrive_config" "wp" {
  count      = var.variant == "a" ? 1 : 0
  account_id = var.account_id
  name       = var.name
  origin = {
    scheme               = "mysql"
    host                 = var.mysql_host
    port                 = local.mysql_use_access ? null : var.mysql_port
    database             = var.mysql_database
    user                 = var.mysql_user
    password             = var.mysql_password
    access_client_id     = local.mysql_use_access ? var.mysql_access_client_id : null
    access_client_secret = local.mysql_use_access ? var.mysql_access_client_secret : null
  }
  caching = { disabled = true }
}

# The D1 resource got a count when variant "a" came in. Without this, sites
# made before would see their database destroyed and made again (empty).
moved {
  from = cloudflare_d1_database.wp
  to   = cloudflare_d1_database.wp[0]
}
