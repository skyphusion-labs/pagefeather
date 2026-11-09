# Plan limits and cost

The per-plan Cloudflare limits that decide the matrix in the root [README](../README.md), and the at-rest cost of the reference deployment. Read from the Cloudflare documentation on the dates shown. Limits change; check the source before you rely on a number.

## Plan limits

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

## Cost of two idle sites

The reference deployment (`deploy/wfp/`, issue #35) hosts each site as a `b-dosql` user Worker in one dispatch namespace, on **Workers for Platforms Paid**. The figures are the published rates; the total is for two sites at rest (no visitor traffic), so every metered amount sits inside an included or free allotment.

| Item (two idle sites) | At-rest usage | Rate and allotment | Monthly | Source (read 2026-11-06) |
| --- | --- | --- | --- | --- |
| Workers for Platforms Paid subscription | the plan itself | $25 a month, flat | **$25.00** | [WfP pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/) |
| Requests | ~0 at rest (one charge across the dispatch chain) | 20 million included, then $0.30 per million | $0.00 | [WfP pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/) |
| CPU time | ~0 at rest | 60 million CPU ms included, then $0.02 per million | $0.00 | [WfP pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/) |
| Namespace scripts | 2 (one user Worker per site) | 1000 included, then $0.02 each | $0.00 | [WfP pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/) |
| Durable Object storage (each site's SQLite) | two small WordPress databases, well under the allotment | 5 GB-month included, then $0.20 per GB-month | $0.00 | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| R2 (each site's media bucket) | near-empty at rest | 10 GB-month free, no egress fee, first 100,000 buckets included | $0.00 | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| KV (the shared site map) | a few small keys | 1 GB and 10 million reads a month included, first 1000 namespaces included | $0.00 | [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) |
| **Total, two idle sites** | | | **about $25 a month** | |

Traffic is extra and metered (requests, CPU, Durable Object rows and duration, R2 and KV operations); the included tiers are per account, shared across all sites, not per site.

**Open, not a figure this records:** the per-site dispatcher (`wp-<name>`) and the shared outbound Worker are ordinary Workers, not namespace scripts. Whether their usage is covered by the Workers for Platforms Paid subscription, or whether a separate **Workers Paid** subscription ($5 a month, [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), read 2026-11-06) is also required, is not stated on the WfP pricing page. If required, the total is about $30 a month. This needs a word from Cloudflare or a billing check before it is stated as a figure.
