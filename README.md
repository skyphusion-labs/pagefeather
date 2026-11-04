# WordPress on Cloudflare

This repository records which ways of running WordPress on Cloudflare work, and on which Cloudflare plan.

Each claim has a source. A cell is one of these:

| Mark | Meaning |
| --- | --- |
| **measured** | We deployed it and ran the test in `tests/`. The result names the command and the date. |
| **docs** | Cloudflare documentation says it is possible. We did not deploy it. |
| **claimed** | A third party says it works. We did not deploy it. |
| **no** | A documented limit blocks it. The limit is named. |
| **unbuilt** | No known implementation exists. |

Cells marked **measured** link to a row in `docs/results.md`. Everything else is from documentation or a third party.

## The approaches

| Id | Approach | WordPress database | PHP runs in |
| --- | --- | --- | --- |
| A | PHP in WebAssembly in a Worker, database outside Cloudflare | MySQL through Hyperdrive | Worker |
| B | PHP in WebAssembly in a Worker, database on Cloudflare | SQLite on D1 or a Durable Object | Worker |
| C | Stock WordPress image in a Container | SQLite on the container disk, kept with snapshots; or MySQL through Hyperdrive | Container |
| D | Headless: a Worker serves the store, WordPress is the back office | Any of A, B or C, or a normal host | Worker for visitors, WordPress for admin |

## What runs on which plan

| Id | Workers Free | Workers Paid ($5 a month) | Main limit |
| --- | --- | --- | --- |
| A | **claimed** for cached pages (HostlessWP) | **claimed** (HostlessWP) | Free CPU time is 10 ms per request. A full WordPress page render uses more, so on Free only cached pages are safe. |
| B | **measured**: with the page cache, logged-out readers get cached pages (50 of 50 cache hits). With OPcache, most uncached renders fit under the CPU limit (11 of 12 cold `wp-login.php`). Logged-in and admin pages work in some runs (one `e2e.sh` run 17 of 17) and stop at the CPU limit in others. The installer does not fit. R2 must be turned on in the dashboard before the media library can use it. | **measured**: every page renders, the installer runs in one request, 17 of 17 checks pass. Media library on R2 works; image sizes from the Images binding; phone photos up to 20 MB. | CPU time. With OPcache, a page needs about 0.4 s of CPU on a warm isolate and about 1.2 s on a new one (median). Free stops a request at about 2 s; Paid allows 30 s by default. See [docs/approach-b.md](docs/approach-b.md) and [docs/results.md](docs/results.md). |
| B with WooCommerce | **measured: no.** Every request exceeds the CPU limit. | **measured: partly.** Shop, product page and cart work (2 to 5 s CPU each). Checkout exceeds the 128 MB memory limit. | WooCommerce asks for 256 MB of PHP memory; an isolate has 128 MB for everything. Next: checkout in a Container (#20). |
| C | **no** | **docs** | Containers are not on the Free plan. Container disk is ephemeral. A snapshot keeps files for 30 days from creation or last restore. |
| D | **docs** for the storefront Worker | **docs** | The back office needs one of A, B, C, or a normal host. |

## Plan limits that decide the table

Read from the Cloudflare documentation on 2026-11-03. Limits change. Check the source before you rely on a number.

| Resource | Workers Free | Workers Paid | Source |
| --- | --- | --- | --- |
| Worker requests | 100,000 a day | No limit | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Worker CPU time per HTTP request | 10 ms | 30 s default, up to 5 min | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Worker memory | 128 MB | 128 MB | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Worker size | 64 MiB (uncompressed; measured: 72 MB refused) | 64 MiB | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Subrequests per request | 50 | 10,000 | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Cron Triggers per account | 5 | 250 | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Static asset files per Worker version | 20,000 | 100,000 | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| D1 database size | 500 MB | 10 GB | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 rows read | 5 million a day | 25 billion a month included | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| D1 rows written | 100,000 a day | 50 million a month included | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| D1 queries per Worker invocation | 50 | 1,000 | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Durable Objects | SQLite storage only, 5 GB per account, 100,000 requests a day | 10 GB per object, no account limit | [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Hyperdrive queries | 100,000 a day | No limit | [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/) |
| Hyperdrive origin connections | About 20 per configuration | About 100 per configuration | [Hyperdrive limits](https://developers.cloudflare.com/hyperdrive/platform/limits/) |
| KV writes to different keys | 1,000 a day | No limit | [KV limits](https://developers.cloudflare.com/kv/platform/limits/) |
| KV reads | 100,000 a day | No limit | [KV limits](https://developers.cloudflare.com/kv/platform/limits/) |
| R2 (free tier, both plans) | 10 GB-month, 1 million Class A and 10 million Class B operations a month | Same free tier, then metered | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Images transformations (binding) | 5,000 unique a month; then new ones fail, no charge | 5,000 unique a month included with Images Paid, then $0.50 per 1,000 | [Images pricing](https://developers.cloudflare.com/images/pricing/) (read 2026-11-04) |
| Workers Cache (page cache in front of a Worker) | Yes. A cache hit runs no Worker code. Every request is billed as a Worker request, also static assets. Purges: 5 a minute, bursts of 25, per account. | Same (purges always have the Free-tier limits) | [Workers Cache](https://developers.cloudflare.com/workers/cache/) (read 2026-11-04) |
| Containers | Not available | 25 GiB-hours memory, 375 vCPU-minutes, 200 GB-hours disk a month included | [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/) |
| Container instance types | Not available | lite (1/16 vCPU, 256 MiB) to standard-4 (4 vCPU, 12 GiB) | [Containers limits](https://developers.cloudflare.com/containers/platform/limits/) |
| Container snapshots | Not available | 20 GB maximum, kept 30 days from creation or last restore | [Containers limits](https://developers.cloudflare.com/containers/platform/limits/), [snapshots](https://developers.cloudflare.com/containers/guides/snapshots/) |

## Prior art

See [docs/prior-art.md](docs/prior-art.md).

## How a cell becomes measured

1. Put a deploy script and a test for the approach in `tests/<id>/`.
2. Deploy it to an account on the plan named in the column. Our Free column runs on an account on Workers Free; our Paid column runs on an account on Workers Paid.
3. Run the test. Record the command, the date, the Wrangler version and the result in the cell's row in `docs/results.md`.
4. Change the mark to **measured**, and link the result.

## License

GPL-2.0. See [LICENSE](LICENSE).
