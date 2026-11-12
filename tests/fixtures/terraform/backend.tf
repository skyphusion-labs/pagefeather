# State is in R2 (bucket wp-on-cf-tfstate, made once by bootstrap.sh), not in
# git: a bucket root has no secret, but every root here keeps its state the same way.
# Same settings as skyphusion-labs/ggc terraform/backend.tf, which explains
# each one. Credentials: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (an R2 key
# for this bucket only), from /Users/conrad/.wp-on-cf-tfstate.env.
terraform {
  backend "s3" {
    bucket = "wp-on-cf-tfstate"
    key    = "fixtures/terraform.tfstate"
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
