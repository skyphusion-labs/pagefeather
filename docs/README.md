# Docs

This repository is two things: a **framework** you run on your own Cloudflare account, and the **research** that produced it. This page is the map of both. If this is your first visit, the table below shows the two current paths, and "Use the product" tells you where to start.

## The product in one view

Two paths are current. The right one for you depends on how much traffic you expect and how much infrastructure you want to run. Containers are retired for the store path (#214); a store that outgrows b-dosql goes to approach A or to a VPS.

| | **b-dosql** (the store path, zero infrastructure) | **Approach A** (the scale-out path) |
| --- | --- | --- |
| What it is | WordPress as PHP-WASM with SQLite inside one Durable Object | WordPress as PHP-WASM in a Worker, database on managed MySQL through Hyperdrive |
| Outside server | None | Yes: a MySQL you choose (PlanetScale, Azure, a VPS, or your own) |
| WooCommerce | Full WooCommerce, checkout included, under the measured write ceiling (117 to 119 MiB of wasm; see [memory limits](known-limitations.md#memory-limits-the-three-figures)). | 12 of 12 on `tests/woo.py`, checkout included, under the measured write ceiling (117 to 119 MiB of wasm; see [memory limits](known-limitations.md#memory-limits-the-three-figures)), no container. The upstream wc suite is a separate result: see the sb1120 summary in [support-matrix.md](support-matrix.md) |
| Under heavy load | One object per site: requests queue behind it | Scales sideways: more Worker isolates as load rises |
| Consistency | Strong, single writer | Whatever your MySQL gives |
| Best for | Blogs, and stores with light to moderate traffic | Stores and sites with real concurrent traffic |

Approach A on PlanetScale through the Cloudflare integration (A2) gives one Cloudflare bill. The measured numbers behind this table are in [approach-a-overview.md](approach-a-overview.md) and [results.md](results.md) (rows `A vs b-dosql (concurrency)` and `A vs b-dosql (fully loaded, 2608 products)`, 2026-11-09).

## How a site is made

A descriptor table in `deploy/provision` wires Cloudflare integrations for each site, as defaults or as opt-ins. Default on: base object cache, WP-Cron on a Durable Object alarm, and Images offload. The L2 KV object cache is on for b-dosql. On approach A it is off unless `OBJECT_CACHE_L2=1` (#1089, #1078). Opt-in: PDF invoices (Browser Rendering), durable email (Queues), AI alt-text (Workers AI), Analytics Engine, Vectorize semantic search, and zone cache purge. The table is in [framework.md](framework.md).

For approach A, onboarding is two commands: `node deploy/onboard/onboard.mjs <provider> --name <cfg> --out onboard.env`, then `node deploy/provision/cli.mjs add --kind a <name> --hyperdrive $HYPERDRIVE_ID --placement <the database region>` on a SaaS zone (`WFP_SAAS_ZONE_ID`). See [onboarding.md](onboarding.md).

Edge security works at the zone level: a WAF with rate limits on login, the zone edge cache with purge on publish, and optional Access on `/wp-admin`. See "Edge security" in [framework.md](framework.md).

## Use the product

1. [framework.md](framework.md): the quickstart for the b-dosql kind and the one provisioning surface: default integrations, edge security, provisioning from a Worker.
2. [onboarding.md](onboarding.md): the flow for approach A: choose a MySQL provider, set up its Hyperdrive configuration, then add type-a sites.
3. [from-lamp-to-wfp.md](from-lamp-to-wfp.md): if you come from a traditional LAMP WordPress host, this maps your stack one to one onto this one. A good first read.
4. [operator.md](operator.md): the day-one walkthrough for running a couple of sites: scripts, Terraform, update and rollback, custom hostnames, teardown.
5. [byo-domain.md](byo-domain.md): the self-service flow for a customer's own domain.
6. [reference-wfp.md](reference-wfp.md): the reference-deployment design for a Workers for Platforms operator (issue #35).
7. [known-limitations.md](known-limitations.md): what does not work yet, each item with its issue. Worth a read before you build.
8. [support-matrix.md](support-matrix.md): each WordPress and WooCommerce feature per tier and deploy path, with a citation for every "yes" and the reason for every limit (#759).

## Approach A (scale-out)

- [approach-a-overview.md](approach-a-overview.md) **start here.** The story, why it fits under the measured write ceiling (117 to 119 MiB of wasm; see [memory limits](known-limitations.md#memory-limits-the-three-figures)), and the database provider choice (Azure, PlanetScale, VPS, external) with the measured results.
- [approach-a.md](approach-a.md) the first measurements on a Vultr MariaDB box, and HostlessWP compared.
- [approach-a2.md](approach-a2.md) the PlanetScale variant (A2).
- [approach-a-objectcache.md](approach-a-objectcache.md) the write-aware object cache that cuts SQL round trips, including the L2 KV tier.
- [approach-a-overflow.md](approach-a-overflow.md) the PHP overflow pool for approach A. It is OFF by default on `deploy/deploy.sh` since #1277 (Conrad's ruling, 2026-11-21; it was on, #1119): the pool's objects run far from the database. `PHP_OVERFLOW=1` opts in. The measured table and the cost are on that page.
- [admin-memory-matrix.md](admin-memory-matrix.md) **where WordPress admin dies on Cloudflare** (2026-11-14): approach A in a Worker and in a Durable Object, HostlessWP and b-dosql with and without the arena, with the raw data. Whether admin pages run on Workers or in a Container is still open; it is decided after the new engine is fully tested.

## b-dosql (store path)

- [perf-dosql.md](perf-dosql.md) tuning b-dosql, the variant the framework runs for blogs and stores.
- [load-152.md](load-152.md) the measured b-dosql ceiling under concurrent multi-site load, and when to move to approach A or a VPS.
- [approach-b.md](approach-b.md) the long record of how WordPress on PHP-WASM was built. It starts with D1; the shipped variant is b-dosql (section 8j).

## Supporting

- [plugins.md](plugins.md) a standard plugin suite run against each setup.
- [wfp.md](wfp.md) the Workers for Platforms spike: dispatch Worker, one user Worker per site, per-tenant limits.
- [async-email-durable-retry.md](async-email-durable-retry.md) durable retry for outgoing email through Queues (opt-in).
- [vectorize-search.md](vectorize-search.md) semantic search through the skyphusion-ai plugin (opt-in).

## Evidence

- [results.md](results.md) every deploy and test run that backs a measured cell, with the command, date and Wrangler version. Measurements are never deleted. A later row can correct an earlier one; read the whole table (see the note at its top).
- [opcache-shm-610.md](opcache-shm-610.md) OPcache shared memory vs the file-cache fallback, re-measured after #582 M2b (#610).
- [prior-art.md](prior-art.md) the projects this builds on, credited.

## Historical (retired, not the product)

These pages record work that is retired or superseded. We keep them because a failed or retired result is still a result, but please do not build on them.

- [approach-c1.md](approach-c1.md) WooCommerce in a Container, SQLite on disk, Litestream to R2. **Retired (#214).** It worked, but b-dosql and approach A do checkout without a container.
- [approach-c-checkout.md](approach-c-checkout.md) checkout in a Container (B+C). **Retired (#214).** Never stable.
- The D1 variant inside [approach-b.md](approach-b.md): plain B on D1 is partial (checkout exceeds the memory limit). Use b-dosql.

The code: `deploy/provision` (the Worker-provisionable core), `deploy/onboard` (approach A onboarding), `deploy/wfp` (the Workers for Platforms reference deployment and its Terraform, including WAF and Access), `deploy/zone` (the zone edge cache), `spikes/` (the research prototypes, see [spikes/README.md](../spikes/README.md)).
