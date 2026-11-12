terraform {
  required_version = ">= 1.5.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.29.0" # exact: the version wp-test-fixtures was applied with (#314 lock); the lock carries darwin_arm64 and linux_amd64
    }
  }
}

# CLOUDFLARE_API_TOKEN from the environment: a token with R2 edit on this account.
provider "cloudflare" {}
