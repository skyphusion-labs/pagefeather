# deploy/live-sites

One file per live b-dosql site whose CODE is redeployed by `.github/workflows/deploy-workers.yml`
(fleet-chezmoi#2620). Each file pins the parameters that site was deployed with, read from the live
Worker's settings, so a redeploy renders the same bindings: `deploy/deploy.sh` runs with
`CODE_ONLY=1` (no Terraform, no secrets, no install). Only these keys are read: `VARIANT`, `LOCATION`,
`MEDIA`, `MEDIA_BUCKET`, `SITE_ORIGIN`, `HTTP_ALLOW_HOSTS`. No secret ever goes here.

Before a deploy the workflow reads the live Worker and refuses unless its `MEDIA` bucket,
`SITE_ORIGIN` and `PHP_RUNTIME` Durable Object binding match this file.
