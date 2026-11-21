# Known limitations

This page lists what does not work yet, or works only with care, so you can plan around it before you build. Each item names its issue, where you can follow it or help. The current paths still run: b-dosql for a store, approach A to scale out. The sb1120 items below are open limits on those paths. See the [docs map](README.md).

## Open from the sb1120 conformance runs (#759)

The rows are in [results.md](results.md), 2026-11-20 and 2026-11-21. The support matrix summary has the per-tier counts.

### WooCommerce checkout on Hyperdrive is slow (#1218)

On `cf759hl` at main `822ab24`, 6 of 10 blocks checkout tests miss the suite's 10 s thank-you wait (#1210). The order POST takes 9.3 to 11.8 s. The order is placed, and the page then answers 200. A query trace of one guest order shows 404 per-order transient DELETEs, 4.8 s of database time. #1206 added that cost. PR #1219 is open. The results row says that, locally, 364 transient DELETE statements per order become 1. The fix is in progress, not fixed.

### Order emails on Hyperdrive can be late (#1215)

#1215 is open. WooCommerce queues each order email. The approach A cron alarm ran those actions 12 to 122 s later, on `cf759hl` at main `822ab24` (row "wc email wait"). The suite polls for 30 s. A default deploy runs the queue (#1166). On this row the send can miss that poll, because the fixture deletes the order first. This row is from before #1176 merged. A second miss on that run is the harness (#1216). PR #1217 is open.

### The WooCommerce "development version" admin notice (#1221)

#1221 is open. Every WooCommerce admin page says the plugin is a development version and that its files must be built. The plugin is built. PHP does not see a file the static path serves. The issue records the live read on `cf759hl`, 2026-11-21. There is no results.md row for it yet.

### A hot b-dosql isolate can reset on an admin write (#1022, #1042)

#1022 is open. On Paid DO and on WfP, `post-new.php` on a hot isolate answers 500 with `x-isolate-reset: memory` and `x-write-loss`. The latest WfP wp row is 17 of 18 for that reason. The Paid DO local wp row missed one test the same way. The Paid DO and WfP wc rows (2026-11-20) also count this reset, in 23 tests and 16 tests.

#1042 is open. Parallel REST reads answer 503 with `x-sql-failure`. The same wc rows count that class: 2 tests on Paid DO, about 6 on WfP. No later wc row has re-run those tiers.

## b-dosql

### Cold-start write can return 1101 under a test seam (#213)

Under the `CRON_SIMULATE_COLD=1` test seam (a forced cold wake on every alarm), two runs right after a fresh redeploy hit a 1101 on an admin write (`create a product`). It was not seen in any warm run, and it does not happen with the seam off, which is production. The exact exception was never captured, and we treat it as low priority. If you see it in production, redeploy, then run `wrangler tail` while you repeat an admin write, to capture the error. Please add what you find to the issue.

### Deactivating WooCommerce can return 500 on a warm isolate (#219)

Deactivating WooCommerce in wp-admin, on an isolate that WooCommerce already warmed, can return 500. The cause is the 128 MiB isolate cap. A skip of WooCommerce, as the media-upload path uses, cannot apply, because the request is about WooCommerce itself. The lever is memory headroom, mainly lazy MEMFS nodes (`LAZY_NODES=on`, #218). The store Container (approach C) was retired (#214), so it is not the fix here. That is separate from the open question of where wp-admin runs (Workers or a Container), which is decided after the new engine is fully tested.

## The guest page cache

### A page that depends on a request header must say so

The guest page cache stores a page under its path and query string. It does not store a page for a request that has a
WordPress cookie (a logged-in user, a cart, a comment author), an `Authorization` header (Basic auth, application
passwords), or a path in the no-cache list (`/wp-admin`, `/wp-login.php`, `/wp-json`, `/cart`, `/checkout`,
`/my-account` and the others in `PAGE_CACHE_NO_PATH` in `spikes/b2-wordpress/index.js`).

For every other guest GET, the cache follows the response's own headers:

- `Cache-Control: private`, `no-store` or `no-cache`: the page is not stored.
- `Vary`: a page that sends `Vary: X-Something` is not served to a later request that has no `X-Something` header
  (measured). A request with a different `X-Something` value was not measured, so do not rely on `Vary` alone for a
  page that is different for each caller.
- No `Vary` and none of those `Cache-Control` values: the page is stored by URL, and every later guest at that URL gets
  the same copy for the cache time (`PAGE_CACHE_TTL`, 120 s by default).

So a theme or plugin that builds a different guest page from a request header (a custom header, a device or region
header, an API key in a header) must send `Vary` naming that header, or `Cache-Control: no-cache` (WordPress's
`nocache_headers()`) or `private`. For a page that is different for each caller, send `private` or `no-cache`
rather than rely on `Vary`. Without one of them, the first answer at that URL is the one that guests get. This is how any
cache that keys by URL behaves; a site behind a CDN has the same rule.

## Provisioning

### Durable email through Queues is not yet a default

The `async-email-queue` descriptor makes the per-site queue, the dead-letter queue and the `EMAIL_QUEUE` binding. It is opt-in. The queue consumer subscription (queue to the site Worker, with `max_retries` and the dead-letter queue) is a step after deploy, and the descriptor step before deploy does not do it. If the descriptor were on by default, order mail would go to a queue with no consumer and never be delivered. It can become a default only after that subscription is wired. See [async-email-durable-retry.md](async-email-durable-retry.md).

### Vectorize semantic search: the plugin side is closed upstream, not measured here

The `vectorize-search` descriptor is opt-in. It adds the `AI` and `SEARCH_INDEX` bindings and a per-site Vectorize index. The search engine is the skyphusion-ai plugin, which is not duplicated here. The Worker answers `aiEmbed` and `vectorize` on those bindings and writes `SKYPHUSION_AI_CF_BRIDGE` only when both are present (issue #330). A plugin build that has not taken the bridge still uses a stored token over the REST API. A tenant site holds no such token. For the token-free path, the plugin must prefer the WfP bridge when `SKYPHUSION_AI_CF_BRIDGE` is set. That change is closed upstream: [skyphusion-ai#193](https://github.com/skyphusion-labs/skyphusion-ai/issues/193) closed as completed on 2026-11-12 (skyphusion-ai PR #195). It is not measured here: no Pagefeather run has shown a search going through the bridge end to end. Cloudflare also caps the number of Vectorize indexes per account, which limits how many sites can opt in. See [vectorize-search.md](vectorize-search.md).

### Per-tenant limits and outbound metering are a future direction (#247)

Isolation today is one user Worker, one Durable Object and one R2 bucket per site, plus a KV site map and dispatch routing. Two Workers for Platforms features are not used yet: custom limits per tenant Worker (CPU time and subrequests), and an outbound Worker that records each tenant's egress. The outbound Worker does not see fetches made from inside a Durable Object. See [wfp.md](wfp.md) and [reference-wfp.md](reference-wfp.md).

### The per-site Terraform pins the zone to skyphusion.org (#157)

`deploy/wfp/terraform/site` sets the variable `zone_id` to the `skyphusion.org` zone by default. A bring-your-own apex (a domain on its own zone) must set `TF_VAR_zone_id` to its own zone id, or the site resources go to the wrong zone. This is a real gap for bring-your-own-domain use. See [byo-domain.md](byo-domain.md).

## Memory limits: the three figures

Three memory figures appear in these docs. They are not the same limit.

| Figure | What it is |
|---|---|
| 128 MB per isolate | Cloudflare's documented limit. The Workers limits page, as read in [design-394-bundle-out-of-memory.md](design-394-bundle-out-of-memory.md), 2026-11-13. That page includes the JavaScript heap. |
| about 255 MiB | Measured reachable size in an empty isolate (#394, [admin-memory-matrix.md](admin-memory-matrix.md), 2026-11-14). |
| 117 to 119 MiB of wasm | The measured write ceiling (#598). This is the figure that binds a site. |

`x-wasm-mib` is the PHP WebAssembly heap only, so the JavaScript heap is not in that header.

## A heavy plugin set: memory and bundle size (b-dosql, measured 2026-11-11)

Measured on a real store imported for skyphusion-labs/ggc#101. It runs WooCommerce 11.2.1, Rank Math 1.0.280, skyphusion-ai 0.6.2, MCP Adapter 0.7.1 and twentytwentyfive, on a site in `deploy/wfp`. The test was a guest probe: the home page, the Store API, the shop, a product, the cart and a cheque checkout.

| plugin set | PHP memory per request | result | bundle (the four files the size gate counts) |
|---|---|---|---|
| with Rank Math | 119 MiB, the runtime recycled on every request | every other request 503; no checkout completed | 61.46 MiB |
| without Rank Math | 99 MiB (the shop page alone reaches 119 MiB and recycles, still 200) | 24 of 24 checks pass over 3 runs; checkout works | 58.40 MiB |

So the 128 MiB isolate cap, not the code, decides whether a store this heavy runs on b-dosql. The bundle has a limit too: the Worker limit is 64 MiB uncompressed. `deploy/wfp/lib.sh bundle_size_check` stops an upload above `BUNDLE_MAX_MIB` (default 62), and `build_dosql`, `site.sh up` and `site update` all run it. If your store needs Rank Math, or a plugin set this heavy, approach A (MySQL through Hyperdrive) is the better fit, rather than b-dosql.

## How many plugins fit

The limit is memory per request. It shows up on the heaviest admin pages. It is not a count of installed plugins.

The isolate cap is 128 MiB. On the Durable Object tiers, writes fail at about 117 to 119 MiB of WebAssembly heap (an estimate from #598 and #1022).

PHP's heap tracks the compiled scripts a request loads. The cost is about 38 KiB per compiled script (an estimate from #1022's mem-trace and #1253).

`post-new.php` with WooCommerce is the heavy page. From a fresh runtime, local runs peak at 107 to 115 MiB (#1022). On an older live build, the median is 118 MiB (#598, #724 r3). That median sits where writes fail.

WooCommerce accounts for about 28 MiB of that page (an estimate from #1022's bisect). Its block registration accounts for about 11 MiB of the page (an estimate from the same bisect). Without WooCommerce, the same page is about 81 MiB (an estimate from the same bisect).

A WooCommerce store has little room for more plugins on `post-new.php` today. The local peak is already near the band where writes fail. The older live median is inside that band.

A WordPress-only site has room for several typical plugins (an estimate). That room is the gap from about 81 MiB up to the write failure band.

What does not fit:

- All 18 suite plugins at once. Each of the 18 passes on its own. With all 18 active, the login request answered 1102 (the Worker exceeded its resource limits) at 118 MB of WebAssembly memory ([approach-a.md](approach-a.md)).
- Rank Math on a WooCommerce store. Requests reach 119 MiB, and every other request answers 503 (#279). #279 measured that on ggc-test on 2026-11-11, with WooCommerce 11.2.1, Rank Math 1.0.280, skyphusion-ai 0.6.2, mcp-adapter 0.7.1 and twentytwentyfive.
- A page builder in the editor. Elementor's editor memory is not measured yet (#758). The block editor already reaches this ceiling (#598).

Yoast SEO (67.94 MiB), All in One SEO (67.53 MiB) and Elementor (83.84 MiB) were over the 64 MiB Worker bundle limit, and SEOPress (63.05 MiB) was over the 62 MiB upload gate. Those figures were measured before remote packs (#279); not re-measured under the default remote packs (#634). Remote packs (SITE_REMOTE) became the default in #595.

#1022 and #1253 are open. #1022 is the memory reset when `post-new.php` runs on a hot isolate. #1253 is the compiled-script set a cold boot opens.

