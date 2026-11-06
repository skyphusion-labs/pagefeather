# Probe for issue #50 (variant a2: WordPress on PlanetScale MySQL through
# Hyperdrive). Two Hyperdrive configs to the SAME database, the same in all
# but the host, so tests/a2/probe can compare them from one Worker:
#   global  aws.connect.psdb.cloud            PlanetScale's "optimized" host (Route 53 latency routing to an edge)
#   direct  aws-us-east-2.connect.psdb.cloud  PlanetScale's "direct" host in the database's region
# Caching is off on both, as in deploy/terraform (WordPress reads its own writes).
# The probe's token is here too. Wrangler deploys the probe (tests/a2/probe.sh).

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
  # State in R2, like deploy/: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY for wp-on-cf-tfstate.
  backend "s3" {
    bucket                      = "wp-on-cf-tfstate"
    key                         = "a2probe/terraform.tfstate"
    region                      = "auto"
    endpoints                   = { s3 = "https://fabcb25d9c7eb087110ec474a03e50d2.r2.cloudflarestorage.com" }
    use_path_style              = true
    use_lockfile                = true
    skip_s3_checksum            = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
  }
}

# CLOUDFLARE_API_TOKEN from the environment (Hyperdrive edit, Workers Scripts edit).
provider "cloudflare" {}

variable "account_id" {
  type    = string
  default = "fabcb25d9c7eb087110ec474a03e50d2" # Skyphusion Labs (Workers Paid)
}

variable "mysql_user" { type = string }
variable "mysql_database" { type = string } # the same as wp-a2 (deploy/terraform sites/wp-a2.tfvars)
variable "mysql_password" {
  type      = string
  sensitive = true
}

variable "hosts" {
  description = "Hyperdrive origin host per probe binding."
  type        = map(string)
  default = {
    global = "aws.connect.psdb.cloud"
    direct = "aws-us-east-2.connect.psdb.cloud"
  }
}

resource "cloudflare_hyperdrive_config" "probe" {
  for_each   = var.hosts
  account_id = var.account_id
  name       = "wp-a2-probe-${each.key}"
  origin = {
    scheme   = "mysql"
    host     = each.value
    port     = 3306
    database = var.mysql_database
    user     = var.mysql_user
    password = var.mysql_password
  }
  caching = { disabled = true }
}

resource "random_password" "probe_token" {
  length  = 40
  special = false
}

output "hyperdrive_ids" { value = { for k, v in cloudflare_hyperdrive_config.probe : k => v.id } }
output "hosts" { value = var.hosts }
output "probe_token" {
  value     = random_password.probe_token.result
  sensitive = true
}
