# State is in R2 (bucket wp-on-cf-tfstate), like deploy/ and tests/bench-runner.
# Credentials: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (the state bucket key).
terraform {
  backend "s3" {
    bucket = "wp-on-cf-tfstate"
    key    = "wfp/terraform.tfstate"
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
