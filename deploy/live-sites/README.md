# deploy/live-sites

One file per live b-dosql site whose CODE is redeployed by `.github/workflows/deploy-workers.yml`
(fleet-chezmoi#2620). Each file pins the parameters that site was deployed with, read from the live
Worker's settings, so a redeploy renders the same bindings: `deploy/deploy.sh` runs with
`CODE_ONLY=1` (no Terraform, no secrets, no install). Only these keys are read: `VARIANT`, `LOCATION`,
`MEDIA`, `MEDIA_BUCKET`, `SITE_ORIGIN`, `HTTP_ALLOW_HOSTS`, and `WOO_ACTIVE` (0 or 1). No secret ever goes here.

`WOO_ACTIVE=1` builds the OPcache with WooCommerce primed. A site with WooCommerce active needs it, or every cold
request compiles WooCommerce inside the isolate (#313). The limit that compile can hit is the measured write ceiling (117 to 119 MiB of wasm; see [memory limits](../../docs/guide/limits.md#memory-limits-the-three-figures)). The workflow refuses the deploy when the live site's
Store API answers 200 and the file does not set `WOO_ACTIVE=1` (#373).

Before a deploy the workflow reads the live Worker and refuses unless its `MEDIA` bucket,
`SITE_ORIGIN` and `PHP_RUNTIME` Durable Object binding match this file.

Workers for Platforms sites are not listed here. `ggc` and `ggc-test` are namespace scripts, and
`deploy/wfp/site` is their operator surface (`deploy-workers.yml` says the per-site Workers are not
redeployed by this workflow). Their live marker is `deploy/wfp/live-sites/` (#693). A file here is a
b-dosql site that this workflow can redeploy with `CODE_ONLY=1`.
