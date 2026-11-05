# Paid account (Skyphusion Labs): CLOUDFLARE_API_TOKEN from the environment.
provider "cloudflare" {}

# Free test account (32ce15b8...). Two tokens, because the account's general
# test token cannot call the Hyperdrive API (code 10000, measured 2026-11-05):
#   free_hyperdrive  token "wp-a-hyperdrive" (Hyperdrive Read and Write only)
#   free_admin       the general test token (creates the HostlessWP deploy token)
provider "cloudflare" {
  alias     = "free_hyperdrive"
  api_token = var.free_hyperdrive_token
}

provider "cloudflare" {
  alias     = "free_admin"
  api_token = var.free_admin_token
}

# VULTR_API_KEY from the environment.
provider "vultr" {}
