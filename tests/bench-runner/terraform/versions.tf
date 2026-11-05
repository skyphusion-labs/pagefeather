terraform {
  required_version = ">= 1.5.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.28"
    }
    vultr = {
      source  = "vultr/vultr"
      version = "~> 2.33"
    }
  }
}

# Paid account (Skyphusion Labs): CLOUDFLARE_API_TOKEN from the environment.
# It must be able to make R2 buckets and account API tokens.
provider "cloudflare" {}

# VULTR_API_KEY from the environment.
provider "vultr" {}
