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
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

# CLOUDFLARE_API_TOKEN and VULTR_API_KEY come from the environment.
provider "cloudflare" {}
provider "vultr" {}
