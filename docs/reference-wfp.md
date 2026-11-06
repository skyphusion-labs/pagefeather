# Reference deployment for a Workers for Platforms user (issue #35)

Status: DESIGN DRAFT, 2026-11-06. Every claim names its measurement. Open items are listed at the end, not hidden in the text.

## Who this is for

An operator who runs WordPress sites for many customers on Cloudflare, with every part as code. The customers keep using the WordPress admin and their own theme to build their sites. A storefront rendered outside WordPress (headless) is out of scope: Conrad, 2026-11-06, "people want to use the wordpress cms, and make things look the way they want to make them look".

## The shape

1. **One dispatch Worker** for the platform. It maps a hostname to the customer's script in a dispatch namespace. Custom domains are data, not per-site configuration.
2. **One user Worker per site** in the namespace. The runtime of that Worker depends on the site (the routing rule below).
3. **One outbound Worker** for fetches that user Workers make. It does not see fetches made from a Durable Object (docs/wfp.md item 4), so the HTTP transport of `b-dosql` (#26) must hold its own allowlist and metering.
4. **One Terraform workspace per site** for its data plane (buckets, secrets, a container application if any), and the user script uploaded through the API into the namespace.

Measured (docs/wfp.md, the spike in #36, #42, #43):
- The real `b-dosql` build runs as a user Worker: install, `e2e.sh` 17 of 17, every bench page 10 of 10. Each tenant gets its own SQLite object.
- The dispatch hop adds about 5 ms at p50 and 3 ms at p95 (Vultr runner in ORD, N=300 each way).
- A container in a user Worker serves HTTP through the dispatcher, with two workarounds: the container application is made through the API, and its image is pushed by a normal Worker deploy. The first answer comes about 1.5 to 2 minutes after the application is made.

## The routing rule (which runtime per site)

| Site | Runtime | Why (measured) | Limit to state |
| --- | --- | --- | --- |
| WordPress without WooCommerce | `b-dosql`: PHP and its SQLite in one Durable Object | 0.36 s page at 1 user (load matrix); object cache -29 % CPU (#44); editor routes cache -11 to -23 % on post-new (#56); runs within Workers Free limits | One object per site: about 5 uncached requests a second (docs/perf-dosql.md). Logged-out readers are served by the page cache. **Transactions do not roll back today (#60).** |
| WooCommerce store | `c1`: WordPress in a Container, SQLite on disk, Litestream to R2 | 0.37 s page and 0.49 s checkout at 1 user, 0.78 s at 5 shoppers on `standard-2`; throughput about vCPU / 0.15 CPU s (docs/approach-c1.md); APCu default (+24 %); the queue runner drains order mail under load (#45) | One writer per store; a 13 to 30 s cold start after 15 idle minutes; sized by instance type. The storefront page cache is being fixed (#58). |
| Very high concurrency on one site | `a`: PHP in Workers, MySQL through Hyperdrive | The only variant that scales out (zero 1102 at 100 users; 128 MB is enough for WooCommerce) | Every query crosses the network: pages 2.4 to 6 s at any load. Not acceptable for a store (Conrad, 2026-11-06). The rate moved between runs (18.7 and 8.63 rps). |

`a2` (PlanetScale through Hyperdrive) works (#50, #52), at about 16 ms per query from ORD, and adds nothing over `a` for these sites.

## Per tenant, as code

- **Plain site (`b-dosql`)**: no database to provision. The Terraform workspace holds the media bucket (optional), the site secrets (salt, spike token, admin password) and the script metadata. Moving a site in or out: `/_dbexport`, `/_dbimport`, `dbmove.py` (approach-b.md section 8j); importing an existing site is #31.
- **Store (`c1`)**: the replica bucket, the media bucket, a scoped Litestream token, the container application (through the API), and the image pushed by one build Worker per image version (docs/wfp.md item 2).

## Per tenant limits

- `subRequests` set by the dispatcher is exact. `cpuMs` is enforced but loose: it does not bound a tenant below about 2 s (docs/wfp.md item 4). So CPU fairness between tenants comes from the runtime choice and the plan, not from `cpuMs` alone.
- Workers for Platforms pricing (docs/wfp.md, read 2026-11-05): $25 a month, 20 million requests and 60 million CPU ms included, 1000 scripts included.

## Correctness the operator must know

- **Transactions:** see the README section "Read this before the speed numbers". `b-dosql` gets real transactions in #60.
- **Page cache keys:** keying the cached page on the whole Cookie header gives about 0 hits for real browsers (found on `c1` in #58; `b` is #63). Decide cacheability by cookie name and cache without the Cookie header.
- **Purges:** a purge reaches only the cache of the entrypoint that calls it, and the purge rate limit is per account (5 a minute), shared by every tenant. Order activity must not purge (#58).
- **Headers that hide state:** the runtime takes its origin from configuration, not from the request that boots it (#33, #55).
- **Hyperdrive's default query cache** (60 s, not invalidated on writes) serves stale WordPress reads (#50).

## Open items

1. #58: the storefront page cache on `c1`, measured with real-browser cookies.
2. #60: real transactions on `b-dosql`.
3. #63: the page cache key on `b`.
4. #26: outbound HTTP from PHP in the object (with allowlist and metering, since the outbound Worker does not see it).
5. #33: the runtime's origin from configuration.
6. The dispatcher, the per-tenant Terraform and an upload path for user scripts are not built yet. This document is the design they follow.
7. Whether the Workers Cache works inside a namespace user Worker (docs/wfp.md marks it open). `b-dosql`'s page cache depends on it.
