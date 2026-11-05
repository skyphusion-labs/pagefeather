terraform {
  required_version = ">= 1.5.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.28"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

# Credentials: CLOUDFLARE_API_TOKEN in the environment (Workers Scripts, D1,
# and R2 if media is on). State is local unless deploy.sh is run with
# DEPLOY_STATE=r2, which writes backend_override.tf.
provider "cloudflare" {}
