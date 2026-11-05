# State is in R2 (bucket wp-on-cf-tfstate), not in git: it holds the runner's
# R2 key. Same settings as tests/a/terraform/backend.tf. Credentials:
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (the R2 key for the state bucket).
terraform {
  backend "s3" {
    bucket = "wp-on-cf-tfstate"
    key    = "bench-runner/terraform.tfstate"
    region = "auto"

    endpoints = {
      s3 = "https://fabcb25d9c7eb087110ec474a03e50d2.r2.cloudflarestorage.com"
    }

    use_path_style              = true
    use_lockfile                = true
    skip_s3_checksum            = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
  }
}
