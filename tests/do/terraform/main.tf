# Placement test for PHP in a Durable Object (issue #28): where does an object
# land for each location hint, and how far is it from a D1 primary created
# with each hint? D1 databases are made here; the probe Worker (../probe) is
# deployed by Wrangler with these ids. Free test account (Workers Free).
# Conrad, 2026-11-05: "can we put the DO closer to D1, like if we can terraform
# that especially and test that out".

variable "free_api_token" {
  description = "Free test account token with D1 Write (file /Users/conrad/.cf-testing.token)"
  type        = string
  sensitive   = true
}

provider "cloudflare" {
  api_token = var.free_api_token
}

locals {
  account_id = "32ce15b8adb82f5a85b67d6c46b28177"
  # D1 primary hints to test. "enam" Eastern North America, "wnam" Western.
  primaries = ["enam", "wnam"]
}

resource "cloudflare_d1_database" "probe" {
  for_each              = toset(local.primaries)
  account_id            = local.account_id
  name                  = "do-probe-${each.key}"
  primary_location_hint = each.key
  read_replication      = { mode = "disabled" }
}

# The same as enam, with read replication on: reads through the Sessions API
# may go to a replica near the reader instead of the primary.
resource "cloudflare_d1_database" "probe_replicated" {
  account_id            = local.account_id
  name                  = "do-probe-enam-replicated"
  primary_location_hint = "enam"
  read_replication      = { mode = "auto" }
}

output "d1" {
  value = merge(
    { for k, v in cloudflare_d1_database.probe : k => v.id },
    { enam_replicated = cloudflare_d1_database.probe_replicated.id },
  )
}

# WordPress on wp-do-free (env do-free): its D1, with the same hint as the PHP
# object (PHP_LOCATION = "enam"). Measured 2026-11-05 with ../probe: an object
# and a D1 primary in the same region read in 14 to 20 ms per statement; in
# different regions, 38 to 60 ms. The first wp-do-free D1 was made with no
# hint and its primary landed near ORD, while the enam object landed in EWR.
resource "cloudflare_d1_database" "wp_do_free" {
  account_id            = local.account_id
  name                  = "wp-do-free-enam"
  primary_location_hint = "enam"
  read_replication      = { mode = "disabled" }
}

output "wp_do_free_d1" {
  value = cloudflare_d1_database.wp_do_free.id
}
