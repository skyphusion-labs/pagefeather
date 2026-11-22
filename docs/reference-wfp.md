# Reference deployment for a Workers for Platforms user (issue #35)

> **This is a design draft of 2026-11-06, not a how-to.** The deployment it led to is built: [deploy/wfp/README.md](../deploy/wfp/README.md) is its manual, and [guide/operator.md](guide/operator.md) the operator guide. The open items at the end are marked with what the code shows on 2026-11-22.

Status: DESIGN DRAFT, 2026-11-06. Every claim names its source: a result file, a doc of this repo, or a vendor page. A claim with no measurement says so. Open items are listed at the end.

## Who this is for

An operator who runs WordPress sites for many customers on Cloudflare, with every part as code. The customers keep using the WordPress admin and their own theme to build their sites. A storefront rendered outside WordPress (headless) is out of scope: Conrad, 2026-11-06, "people want to use the wordpress cms, and make things look the way they want to make them look".

## The shape

1. **One dispatch Worker** for the platform. It maps a hostname to the customer's script in a dispatch namespace. Custom domains are data, not per-site configuration. The spike's dispatcher routed by path (`/tenant-c/...`) and by a fixed SITE_SCRIPT. The built dispatcher routes by hostname (open item 3).
2. **One user Worker per site** in the namespace. Its runtime depends on the site (the routing rule below).
3. **One outbound Worker** for fetches that user Workers make. It does not see fetches made from a Durable Object (docs/wfp.md item 4), so for `b-dosql` the control point is its HTTP transport (#26, PR #67). That transport allowlists hosts (`HTTP_ALLOW_HOSTS`). Unset uses `.wordpress.org`, `.woocommerce.com` and `.gravatar.com`. An empty list denies every host. `*` allows every http(s) host. There is no metering yet (an open item). **Risk:** the outbound Workers page says user Workers behind an outbound Worker "will no longer be able to use the connect() API". Variant `a` reaches MySQL through Hyperdrive with a TCP socket (mysql2), so `a` behind the platform's outbound Worker may not reach its database at all. Not tested.
4. **One Terraform workspace per site** for its data plane, and the user script uploaded into the namespace.

Measured (docs/wfp.md; #36, #42, #43):
- The real `b-dosql` build runs as a user Worker: install, `e2e.sh` 17 of 17, every bench page 10 of 10, one SQLite object per tenant. It was uploaded with `wrangler deploy --dispatch-namespace` with its assets, secrets and migrations (96 s the first time, 28 s after).
- The dispatch hop adds about 5 ms at p50 and 3 ms at p95 (Vultr runner in ORD, N=300 each way, one run).
- A container in a user Worker serves HTTP through the dispatcher, with two workarounds: its application is made through the API, and its image is pushed by a normal Worker deploy. In one run (hand curls, 30 s apart, not in the result file) the first answer came about 1.5 to 2 minutes after the application was made. Only a minimal test container (busybox httpd) was measured this way, not `c1`.

## The routing rule (which runtime per site)

Measured as normal Workers, not as user Workers, except where the row says so.

| Site | Runtime | Source | Limit to state |
| --- | --- | --- | --- |
| WordPress without WooCommerce | `b-dosql`: PHP and its SQLite in one Durable Object | 0.36 s page at 1 user (load matrix, bench-runner-20261105T214231Z-230073.json); object cache -29 % CPU on home and -7 % on post-new (#44, docs/perf-dosql.md); editor routes cache -11 to -23 % on post-new (#56). Also measured as a user Worker (above). | One object per site: about 5 uncached requests a second (docs/perf-dosql.md). Transactions roll back: real SQL transactions through an undo log in the object (PR #75; #60 closed 2026-11-06), and a request frame rolls a writing request back on an isolate reset (PR #574). The page cache is keyed on the whole Cookie header today, so real browsers with analytics cookies miss (#63). The Workers Cache works inside a namespace user Worker (open item 4). |
| WooCommerce store | `b-dosql`, the same runtime as a plain site, with WooCommerce active. It runs checkout directly (README matrix; `tests/woo.py` green on Paid). The `c1` container store was retired in #214. | See the README matrix and docs/results.md for the checkout runs; the object cache and page cache notes are in docs/perf-dosql.md. | The same limit as a plain site: one Durable Object, 128 MiB, one writer, one region. A light-to-moderate store fits. A store with sustained, heavy concurrent load belongs on a VPS. |
| Very high concurrency on one site | `a`: PHP in Workers, MySQL through Hyperdrive | The only variant that spread across isolates (zero 1102 at 100 users; 128 MB is enough for WooCommerce). | **Not measured as a user Worker**, and see the connect() risk above. Every query crosses the network: browse p50 2.31 to 5.92 s across the steps of the three load runs (deploy/results/bench-runner-20261105T211919Z-cea397.json, bench-runner-20261105T214231Z-230073.json, bench-runner-20261106T010353Z-155691.json), not acceptable for a store (Conrad, 2026-11-06). Its rate at 100 users moved across three runs: 10.3, 18.73 and 8.63 rps. |

**Today:** a store with real concurrent traffic goes to approach `a` on an external scalable database. It runs full WooCommerce under 128 MiB with no container (#218) and scales sideways; `site add --kind a` provisions it (#241). A store that outgrows b-dosql can also go to a VPS. The row above for `a` records the earlier measurements, taken before the object cache and OPcache work of #218; see [approach-a-overview.md](approach-a-overview.md) for the current numbers.

`a2` (PlanetScale through Hyperdrive) works as a normal Worker (#50, #52), at about 16 ms per query from ORD, and adds nothing over `a` for these sites.

## Per tenant, as code

- **Plain site (`b-dosql`)**: no database to provision. The workspace holds the media bucket (optional), the site secrets (salt, spike token, admin password), `SITE_ORIGIN` (the site's address, #33, PR #65), and the script metadata. Moving a site in or out: `/_dbexport`, `/_dbimport`, `dbmove.py` (approach-b.md section 8j); importing an existing site is #31.
- **Store (`b-dosql`)**: the same as a plain site. WooCommerce is a plugin inside the site, so a store needs no extra resource. (The retired `c1` store needed a replica bucket, a Litestream token and a container application; see docs/approach-c1.md.)
- **Teardown deletes data.** Removing a `b-dosql` tenant's script removes its object and its SQLite (the spike used force). Export first.

## Rollout and limits

- `subRequests` set by the dispatcher was exact where measured, without an outbound Worker (not measured with one). `cpuMs` is enforced but loose: it does not bound a tenant below about 2 s (docs/wfp.md item 4). CPU fairness between tenants comes from the runtime choice and the plan, not from `cpuMs` alone.
- No gradual deployments for user Workers, and the API allows 1200 calls per 5 minutes per token (docs/wfp.md, pricing and limits). A fleet rollout is batched.
- Workers for Platforms is a Paid product. The Workers Free limits do not apply under it.
- A pagefeather Workers for Platforms account costs $30 a month for two or more sites ([guide/cost.md](guide/cost.md)). That is the Workers for Platforms Paid plan ($25) plus the Workers Paid plan ($5). The reference account runs both. The Workers for Platforms price includes 20 million requests, then $0.30 per million. It includes 60 million CPU ms, then $0.02 per million. It includes 1,000 namespace scripts, then $0.02 each. Another site at rest costs about $0, up to the 1,000 included scripts. Durable Object storage, R2, and KV sit inside an included or free tier at rest. Cloudflare's WfP pricing page does not say whether Workers Paid is strictly required, so plan for both. Per-tenant traffic cost (Durable Object duration and rows for `b-dosql`) is still per workload, not worked out here.

## Correctness the operator must know

- **Transactions:** `b-dosql` has real SQL transactions, through an undo log in the object (PR #75; #60 closed). A request frame rolls a writing request back on an isolate reset (PR #574). See also the README section "Read this before the speed numbers".
- **Page cache keys:** keying the cached page on the whole Cookie header gives about 0 hits for real browsers (measured on `c1` in #58 and on `b` in #63). Decide cacheability by cookie name and cache without the Cookie header.
- **Purges:** the purge rate limit is per account (5 a minute, 25 at once), shared by every tenant, so order activity must not purge and bursts are coalesced (#58). Measured in the #58 gates (strummer, `tests/edge_check.py`, 2026-11-06; the build was the retired `c1` store, and no result file for it is in the repo): on the build that purged from the container's outbound path, a price, stock and tagline change were all still stale after 20 s; on the build that purges through the cached entrypoint, the same changes showed in 1.3 to 1.9 s.
- **The site's origin:** the runtime takes its origin from configuration (`SITE_ORIGIN`), not from the request that boots it (#33, #55).
- **Hyperdrive's default query cache** (60 s, not invalidated on writes) serves stale WordPress reads (#50).

## Open items

1. The connect() risk for `a` behind an outbound Worker: test it. **2026-11-22: still not tested.** `deploy/wfp` deploys `b-dosql` sites only (`site-<name>` user Workers). Approach `a` sites come from `deploy/provision` (`site add --kind a`), outside the namespace, so no `a` site runs behind the outbound Worker today.
2. `a` as a user Worker: provisioned by `site add --kind a` (#241). Per-tenant limits and metering are a future direction (#247, see [guide/limits.md](guide/limits.md)). (`c1` was retired in #214.)
3. Hostname routing in the dispatcher. **2026-11-22: built and tested.** The dispatcher keys its site map on the request's hostname (`deploy/wfp/dispatcher/worker.js`; test `deploy/wfp/tests/dispatcher-test.mjs`). Phase A runs one copy per site on its `wp-<name>` host. Phase B is one `wp-dispatch` with a Custom Domain per site (#138).
4. Whether the Workers Cache works inside a namespace user Worker. `b-dosql`'s page cache depends on it. **Answered: yes** ([wfp.md](wfp.md), 2026-11-06, `deploy/wfp/results/day1-20261106T213116Z.json`).
5. The Durable Object namespace name collision (namespaces are named `<script>_<class>`). **2026-11-22: not tested** ([wfp.md](wfp.md)). `deploy/wfp` avoids it by its names: user Workers are `site-<name>` in the namespace, and its normal Workers are `wp-*` (`deploy/wfp/lib.sh`).
6. #58 (the storefront cache, first built for the retired `c1`), #60 (b-dosql transactions, closed: PR #75), #63 (b cache key), #31 (import).
7. Cost per tenant under traffic. The at-rest price and its limits are in [guide/cost.md](guide/cost.md).
8. Metering of outbound HTTP from PHP in the object (#26 built the transport and an optional allowlist; the outbound Worker does not see these fetches). **2026-11-22: not built.** The outbound Worker passes requests on unchanged (`deploy/wfp/outbound/worker.js`). The PHP transport has a host allowlist (`HTTP_ALLOW_HOSTS`) but no metering.
9. The dispatcher, the per-tenant Terraform and the upload pipeline. **2026-11-22: built.** The dispatcher is `deploy/wfp/dispatcher`, the Terraform is `deploy/wfp/terraform/site` (per site) and `deploy/wfp/terraform/shared`, and the upload is `deploy/wfp/site.sh` and `up.sh`. This document is the design they followed.
