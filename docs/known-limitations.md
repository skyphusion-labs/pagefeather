# Known limitations

The open items of the final scope, kept as documented knowledge. Each one names its issue. None of them blocks the current paths: b-dosql for a store, approach A to scale out. See the [docs map](README.md).

## b-dosql

### Cold-start write can return 1101 under a test seam (#213)

Under the `CRON_SIMULATE_COLD=1` test seam (a forced cold wake on every alarm), two runs right after a fresh redeploy hit a 1101 on an admin write (`create a product`). It was not seen in any warm run, and it does not happen with the seam off, which is production. The exact exception was never captured. Low priority. If it appears in production, redeploy, then run `wrangler tail` while repeating an admin write to capture the error.

### Deactivating WooCommerce can return 500 on a warm isolate (#219)

Deactivating WooCommerce in wp-admin, on an isolate that WooCommerce already warmed, can return 500. The cause is the 128 MiB isolate cap. A skip of WooCommerce, as the media-upload path uses, cannot apply, because the request is about WooCommerce itself. The lever is memory headroom, mainly lazy MEMFS nodes (`LAZY_NODES=on`, #218). Containers are retired (#214), so a container is not the fix.

## Provisioning

### Durable email through Queues is not yet a default

The `async-email-queue` descriptor makes the per-site queue, the dead-letter queue and the `EMAIL_QUEUE` binding. It is opt-in. The queue consumer subscription (queue to the site Worker, with `max_retries` and the dead-letter queue) is a step after deploy, and the descriptor step before deploy does not do it. If the descriptor were on by default, order mail would go to a queue with no consumer and never be delivered. It can become a default only after that subscription is wired. See [async-email-durable-retry.md](async-email-durable-retry.md).

### Vectorize semantic search needs a plugin change (skyphusion-ai#193)

The `vectorize-search` descriptor is opt-in. It adds the `AI` and `SEARCH_INDEX` bindings and a per-site Vectorize index. The search engine is the skyphusion-ai plugin, which is not duplicated here. Today the plugin reaches Workers AI and Vectorize with a stored token over the REST API. A tenant site holds no such token. For the token-free path, the plugin must prefer the WfP bridge (the Worker op-bridge on `env.AI` and `env.SEARCH_INDEX`) when it is present. That change is tracked as [skyphusion-ai#193](https://github.com/skyphusion-labs/skyphusion-ai/issues/193). Cloudflare also caps the number of Vectorize indexes per account, which limits how many sites can opt in. See [vectorize-search.md](vectorize-search.md).

### Per-tenant limits and outbound metering are a future direction (#247)

Isolation today is one user Worker, one Durable Object and one R2 bucket per site, plus a KV site map and dispatch routing. Two Workers for Platforms features are not used yet: custom limits per tenant Worker (CPU time and subrequests), and an outbound Worker that records each tenant's egress. The outbound Worker does not see fetches made from inside a Durable Object. See [wfp.md](wfp.md) and [reference-wfp.md](reference-wfp.md).

### The per-site Terraform pins the zone to skyphusion.org (#157)

`deploy/wfp/terraform/site` sets the variable `zone_id` to the `skyphusion.org` zone by default. A bring-your-own apex (a domain on its own zone) must set `TF_VAR_zone_id` to its own zone id, or the site resources go to the wrong zone. This is a real gap for bring-your-own-domain use. See [byo-domain.md](byo-domain.md).

## A heavy plugin set: memory and bundle size (b-dosql, measured 2026-11-11)

Measured on a real store imported for skyphusion-labs/ggc#101. It runs WooCommerce 11.2.1, Rank Math 1.0.280, skyphusion-ai 0.6.2, MCP Adapter 0.7.1 and twentytwentyfive, on a site in `deploy/wfp`. The test was a guest probe: the home page, the Store API, the shop, a product, the cart and a cheque checkout.

| plugin set | PHP memory per request | result | bundle (the four files the size gate counts) |
|---|---|---|---|
| with Rank Math | 119 MiB, the runtime recycled on every request | every other request 503; no checkout completed | 61.46 MiB |
| without Rank Math | 99 MiB (the shop page alone reaches 119 MiB and recycles, still 200) | 24 of 24 checks pass over 3 runs; checkout works | 58.40 MiB |

So the 128 MiB isolate cap, not the code, decides whether a store this heavy runs on b-dosql. The bundle has a limit too: the Worker limit is 64 MiB uncompressed. `deploy/wfp/lib.sh bundle_size_check` stops an upload above `BUNDLE_MAX_MIB` (default 62), and `build_dosql`, `site.sh up` and `site update` all run it. A store that needs Rank Math, or a plugin set this heavy, is a fit for approach A (MySQL through Hyperdrive) rather than b-dosql.

