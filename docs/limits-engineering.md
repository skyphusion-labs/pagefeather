# Engineering and operator-only limits

These limits are for an engineer or an operator. A site owner does not meet them in normal use. They moved here from [Known limitations](guide/limits.md) (#1305), unchanged, so each keeps its issue number and its figures. The limits a site owner meets are on that page.

## WP-CLI operator route (#1258)

`POST /_pf/wp-cli` is off unless `WP_CLI_ENDPOINT=on`. It needs Cloudflare Access and a custom domain (#1264, #1260). The #1260 Access application is not created by IaC yet. The wall cap is 25 s. One run at a time holds per isolate, not per site: on approach A many isolates can run a command at once. A command drops that isolate's warm runtime, so the next page request boots cold. After the wall the route answers 124, and `php.exit` drops the JS heap handle, but the in-flight `php.cli` keeps running until the command finishes. The next request is not held behind that run. On dosql-local an allowed command slowed by 8 s answered 124 in 0.980 s (`ms` 962), and the next command answered 124 in 0.808 s (`ms` 794). Turning the endpoint on adds `wp-cli.phar` (7,142,777 bytes, about 7 MB) to `site.zip`, against the 64 MiB Worker limit (the upload gate is 62 MiB). With the endpoint unset, the bundle does not contain the phar. Long jobs (search-replace, import) are refused until step 5. The allowlist is the code lock: WP-CLI ignores `DISALLOW_FILE_MODS`. `user_pass` and `user_activation_key` are never printed. The full limits are in [../spikes/wp-cli-1258.md](spikes/wp-cli-1258.md).

## The built-in database option

### Cold-start write can return 1101 under a test seam (#213)

Under the `CRON_SIMULATE_COLD=1` test seam (a forced cold wake on every alarm), two runs right after a fresh redeploy hit a 1101 on an admin write (`create a product`). It was not seen in any warm run, and it does not happen with the seam off, which is production. The exact exception was never captured, and we treat it as low priority. If you see it in production, redeploy, then run `wrangler tail` while you repeat an admin write, to capture the error. Please add what you find to the issue.

## Provisioning

### Durable email through Queues is not yet a default

The `async-email-queue` descriptor makes the per-site queue, the dead-letter queue and the `EMAIL_QUEUE` binding. It is opt-in. The queue consumer subscription (queue to the site Worker, with `max_retries` and the dead-letter queue) is a step after deploy, and the descriptor step before deploy does not do it. If the descriptor were on by default, order mail would go to a queue with no consumer and never be delivered. It can become a default only after that subscription is wired. See [../async-email-durable-retry.md](async-email-durable-retry.md).

### Vectorize semantic search: the plugin side is closed upstream, not measured here

The `vectorize-search` descriptor is opt-in. It adds the `AI` and `SEARCH_INDEX` bindings and a per-site Vectorize index. The search engine is the skyphusion-ai plugin, which is not duplicated here. The Worker answers `aiEmbed` and `vectorize` on those bindings and writes `SKYPHUSION_AI_CF_BRIDGE` only when both are present (issue #330). A plugin build that has not taken the bridge still uses a stored token over the REST API. A tenant site holds no such token. For the token-free path, the plugin must prefer the WfP bridge when `SKYPHUSION_AI_CF_BRIDGE` is set. That change is closed upstream: [skyphusion-ai#193](https://github.com/skyphusion-labs/skyphusion-ai/issues/193) closed as completed on 2026-11-12 (skyphusion-ai PR #195). It is not measured here: no Pagefeather run has shown a search going through the bridge end to end. Cloudflare also caps the number of Vectorize indexes per account, which limits how many sites can opt in. See [../vectorize-search.md](vectorize-search.md).

### Per-tenant limits and outbound metering are a future direction (#247)

Isolation today is one user Worker, one Durable Object and one R2 bucket per site, plus a KV site map and dispatch routing. Two Workers for Platforms features are not used yet: custom limits per tenant Worker (CPU time and subrequests), and an outbound Worker that records each tenant's egress. The outbound Worker does not see fetches made from inside a Durable Object. See [../wfp.md](wfp.md) and [../reference-wfp.md](reference-wfp.md).

### The per-site Terraform pins the zone to skyphusion.org (#157)

`deploy/wfp/terraform/site` sets the variable `zone_id` to the `skyphusion.org` zone by default. A bring-your-own apex (a domain on its own zone) must set `TF_VAR_zone_id` to its own zone id, or the site resources go to the wrong zone. This is a real gap for bring-your-own-domain use. See [byo-domain.md](guide/byo-domain.md).
