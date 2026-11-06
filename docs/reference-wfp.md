# Reference deployment for a Workers for Platforms user (issue #35)

Status: DESIGN DRAFT, 2026-11-06. Every claim names its source: a result file, a doc of this repo, or a vendor page. A claim with no measurement says so. Open items are listed at the end.

## Who this is for

An operator who runs WordPress sites for many customers on Cloudflare, with every part as code. The customers keep using the WordPress admin and their own theme to build their sites. A storefront rendered outside WordPress (headless) is out of scope: Conrad, 2026-11-06, "people want to use the wordpress cms, and make things look the way they want to make them look".

## The shape

1. **One dispatch Worker** for the platform. It maps a hostname to the customer's script in a dispatch namespace. Custom domains are data, not per-site configuration. **Not measured:** the spike's dispatcher routed by path (`/tenant-c/...`) and by a fixed SITE_SCRIPT; routing by hostname is not tested.
2. **One user Worker per site** in the namespace. Its runtime depends on the site (the routing rule below).
3. **One outbound Worker** for fetches that user Workers make. It does not see fetches made from a Durable Object (docs/wfp.md item 4), so the HTTP transport of `b-dosql` (#26, PR #67) holds its own allowlist and metering. **Risk:** the outbound Workers page says user Workers behind an outbound Worker "will no longer be able to use the connect() API". Variant `a` reaches MySQL through Hyperdrive with a TCP socket (mysql2), so `a` behind the platform's outbound Worker may not reach its database at all. Not tested.
4. **One Terraform workspace per site** for its data plane, and the user script uploaded into the namespace.

Measured (docs/wfp.md; #36, #42, #43):
- The real `b-dosql` build runs as a user Worker: install, `e2e.sh` 17 of 17, every bench page 10 of 10, one SQLite object per tenant. It was uploaded with `wrangler deploy --dispatch-namespace` with its assets, secrets and migrations (96 s the first time, 28 s after).
- The dispatch hop adds about 5 ms at p50 and 3 ms at p95 (Vultr runner in ORD, N=300 each way, one run).
- A container in a user Worker serves HTTP through the dispatcher, with two workarounds: its application is made through the API, and its image is pushed by a normal Worker deploy. In one run (hand curls, 30 s apart, not in the result file) the first answer came about 1.5 to 2 minutes after the application was made. Only a minimal test container (busybox httpd) was measured this way, not `c1`.

## The routing rule (which runtime per site)

Measured as normal Workers, not as user Workers, except where the row says so.

| Site | Runtime | Source | Limit to state |
| --- | --- | --- | --- |
| WordPress without WooCommerce | `b-dosql`: PHP and its SQLite in one Durable Object | 0.36 s page at 1 user (load matrix, bench-runner-20261105T214231Z-230073.json); object cache -29 % CPU on home and -7 % on post-new (#44, docs/perf-dosql.md); editor routes cache -11 to -23 % on post-new (#56). Also measured as a user Worker (above). | One object per site: about 5 uncached requests a second (docs/perf-dosql.md). **Transactions do not roll back today (#60).** The page cache is keyed on the whole Cookie header today, so real browsers with analytics cookies miss (#63). Whether the Workers Cache works inside a namespace user Worker is not tested. |
| WooCommerce store | `c1`: WordPress in a Container, SQLite on disk, Litestream to R2 | 0.37 s page and 0.49 s checkout at 1 user, 0.78 s at 5 shoppers on `standard-2`; throughput about vCPU / 0.15 CPU s (docs/approach-c1.md); APCu default; the queue runner drains order mail under load (#45). | **Not measured as a user Worker** (its outbound handler and Workers Cache use are untested in a namespace). One writer per store. Cold start after 15 idle minutes: 11 to 22 s measured (docs/approach-c1.md; cold_start_s 13, 14, 18 and 22 s in deploy/results/wp-c1-*.json). Sized by instance type. Storefront cache: #58. |
| Very high concurrency on one site | `a`: PHP in Workers, MySQL through Hyperdrive | The only variant that spread across isolates (zero 1102 at 100 users; 128 MB is enough for WooCommerce). | **Not measured as a user Worker**, and see the connect() risk above. Every query crosses the network: pages 2.4 to 6 s at any load, not acceptable for a store (Conrad, 2026-11-06). Its rate at 100 users moved across three runs: 10.3, 18.73 and 8.63 rps. |

`a2` (PlanetScale through Hyperdrive) works as a normal Worker (#50, #52), at about 16 ms per query from ORD, and adds nothing over `a` for these sites.

## Per tenant, as code

- **Plain site (`b-dosql`)**: no database to provision. The workspace holds the media bucket (optional), the site secrets (salt, spike token, admin password), `SITE_ORIGIN` (the site's address, #33, PR #65), and the script metadata. Moving a site in or out: `/_dbexport`, `/_dbimport`, `dbmove.py` (approach-b.md section 8j); importing an existing site is #31.
- **Store (`c1`)**: the replica bucket, the media bucket, a scoped Litestream token, the container application (through the API), and the image pushed by one build Worker per image version (docs/wfp.md item 2). The application holds the image by digest, so a teardown resolves the tag by name before it deletes the image.
- **Teardown deletes data.** Removing a `b-dosql` tenant's script removes its object and its SQLite (the spike used force). Export first.

## Rollout and limits

- `subRequests` set by the dispatcher is exact. `cpuMs` is enforced but loose: it does not bound a tenant below about 2 s (docs/wfp.md item 4). CPU fairness between tenants comes from the runtime choice and the plan, not from `cpuMs` alone.
- No gradual deployments for user Workers, and the API allows 1200 calls per 5 minutes per token (docs/wfp.md, pricing and limits). A fleet rollout is batched.
- Workers for Platforms is a Paid product: the Workers Free limits do not apply under it. Pricing (docs/wfp.md, read 2026-11-05): $25 a month, 20 million requests and 60 million CPU ms included, 1000 scripts included.
- Cost per tenant is not worked out yet: Durable Object duration and storage for `b-dosql`; container awake hours for `c1` (docs/approach-c1.md has the instance rates).

## Correctness the operator must know

- **Transactions:** see the README section "Read this before the speed numbers". `b-dosql` gets real transactions in #60.
- **Page cache keys:** keying the cached page on the whole Cookie header gives about 0 hits for real browsers (measured on `c1` in #58 and on `b` in #63). Decide cacheability by cookie name and cache without the Cookie header.
- **Purges:** the purge rate limit is per account (5 a minute, 25 at once), shared by every tenant, so order activity must not purge and bursts are coalesced (#58). In #58's first live gate, purges sent from the container's outbound path did not clear the pages, and purges sent through the cached entrypoint did; that is the measurement, not a documented rule found by us.
- **The site's origin:** the runtime takes its origin from configuration (`SITE_ORIGIN`), not from the request that boots it (#33, #55).
- **Hyperdrive's default query cache** (60 s, not invalidated on writes) serves stale WordPress reads (#50).

## Open items

1. The connect() risk for `a` behind an outbound Worker: test it.
2. `c1` and `a` as user Workers: not measured.
3. Hostname routing in the dispatcher: not tested.
4. Whether the Workers Cache works inside a namespace user Worker (docs/wfp.md marks it open). `b-dosql`'s page cache depends on it.
5. The Durable Object namespace name collision (docs/wfp.md open item: namespaces are named `<script>_<class>`).
6. #58 (c1 storefront cache), #60 (b-dosql transactions), #63 (b cache key), #31 (import).
7. Cost per tenant.
8. The dispatcher, the per-tenant Terraform and the upload pipeline are not built. This document is the design they follow.
