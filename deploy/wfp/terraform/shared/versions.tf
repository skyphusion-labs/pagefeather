terraform {
  required_version = ">= 1.5.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.28"
    }
  }
}

# CLOUDFLARE_API_TOKEN from the environment. State is local unless the scripts
# run with WFP_STATE=r2 (lib.sh writes backend_override.tf).
provider "cloudflare" {}
