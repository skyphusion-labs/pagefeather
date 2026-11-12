# The test fixture bucket

One private R2 bucket, `wp-test-fixtures`, for the WooCommerce sample store that every WordPress
test loads (fleet-chezmoi#2575). Each fixture version is one object:
`sample-store/<YYYYMMDD>-<sha12>.sql.gz`.

## Why its own root

`deploy/wfp/down.sh` destroys `deploy/wfp/terraform/shared`. A fixture bucket there would go with
every reference teardown, and the destroy would fail because R2 does not delete a bucket that holds
objects. This root has its own state key, `fixtures/terraform.tfstate`, in `wp-on-cf-tfstate`.

## What it declares

- `cloudflare_r2_bucket.fixtures`, `wp-test-fixtures`, with `prevent_destroy`.
- `cloudflare_r2_managed_domain.fixtures` with `enabled = false`. The public `r2.dev` URL is off,
  stated rather than assumed, so a dashboard toggle is drift in the next plan.
- No custom domain, no CORS, no lifecycle rule. Old fixtures are deleted by hand when no test pins
  them.

Access is two R2 tokens scoped to this bucket only, read for test loaders and write for the
uploader. They are minted outside this root (CR step 2) and never stored here.

## Apply

```sh
cd tests/fixtures/terraform
export CLOUDFLARE_API_TOKEN=...      # R2 edit on the account
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...   # the wp-on-cf-tfstate key
export TF_VAR_account_id=...         # the account to create the bucket in
terraform init
terraform plan                        # want: 2 to add, 0 to change, 0 to destroy
terraform apply
```

## Read back (GET only)

With `A=/accounts/<account id>/r2/buckets/wp-test-fixtures`:

- `GET $A`: the bucket exists.
- `GET $A/domains/managed`: `enabled` is false.
- `GET $A/domains/custom`: no domains.
- `GET $A/cors`: no rules.
- An object list is empty, 0 objects, before the first upload.

## Rollback

Delete the `prevent_destroy` block in a reviewed change, empty the bucket, `terraform destroy`, and
revoke both tokens.
