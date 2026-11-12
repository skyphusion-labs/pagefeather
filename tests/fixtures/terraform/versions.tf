terraform {
  required_version = ">= 1.5.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.28"
    }
  }
}

# CLOUDFLARE_API_TOKEN from the environment: a token with R2 edit on this account.
provider "cloudflare" {}
