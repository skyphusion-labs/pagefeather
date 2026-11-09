# Docs

This repository is two things: a **framework** you run on your own Cloudflare account, and the **research** that produced it. Start with the product map below.

## The product in one view

Two paths are current. Pick by how much traffic you expect and how much infrastructure you want to run. Containers are retired for the store path (#214); a store that outgrows b-dosql goes to approach A or to a VPS.

| | **b-dosql** (the store path, zero infrastructure) | **Approach A** (the scale-out path) |
| --- | --- | --- |
| What it is | WordPress as PHP-WASM with SQLite inside one Durable Object | WordPress as PHP-WASM in a Worker, database on managed MySQL through Hyperdrive |
| Outside server | None | Yes: a MySQL you choose (PlanetScale, Azure, a VPS, or your own) |
| WooCommerce | Full WooCommerce, checkout included, under the 128 MiB isolate cap | 12 of 12, checkout included, under the 128 MiB isolate cap, no container |
| Under heavy load | One object per site: requests queue behind it | Scales sideways: more Worker isolates as load rises |
| Consistency | Strong, single writer | Whatever your MySQL gives |
| Best for | Blogs, and stores with light to moderate traffic | Stores and sites with real concurrent traffic |

Approach A on PlanetScale through the Cloudflare integration (A2) gives one Cloudflare bill. The measured numbers behind this table are in [approach-a-overview.md](approach-a-overview.md) and [results.md](results.md) (rows `A vs b-dosql (concurrency)` and `A vs b-dosql (fully loaded, 2608 products)`, 2026-11-09).

## How a site is made

A descriptor table in `deploy/provision` wires Cloudflare integrations for each site, as defaults or as opt-ins. Default on: base object cache, WP-Cron on a Durable Object alarm, Images offload, and the L2 KV object cache. Opt-in: PDF invoices (Browser Rendering), durable email (Queues), AI alt-text (Workers AI), Analytics Engine, Vectorize semantic search, and zone cache purge. The table is in [framework.md](framework.md).

For approach A, onboarding is two commands: `node deploy/onboard/onboard.mjs <provider> --name <cfg> --out onboard.env`, then `node deploy/provision/cli.mjs site add --kind a <name> --hyperdrive $HYPERDRIVE_ID`. See [onboarding.md](onboarding.md).

Edge security works at the zone level: a WAF with rate limits on login, the zone edge cache with purge on publish, and optional Access on `/wp-admin`. See "Edge security" in [framework.md](framework.md).

## Use the product

1. [framework.md](framework.md) the quickstart for the b-dosql kind and the one provisioning surface: default integrations, edge security, provisioning from a Worker.
2. [onboarding.md](onboarding.md) the flow for approach A: choose a MySQL provider, set up its Hyperdrive configuration, then add type-a sites.
3. [from-lamp-to-wfp.md](from-lamp-to-wfp.md) coming from a traditional LAMP WordPress host: your stack mapped one to one onto this one.
4. [operator.md](operator.md) the day-one walkthrough for running a couple of sites: scripts, Terraform, update and rollback, custom hostnames, teardown.
5. [byo-domain.md](byo-domain.md) the self-service flow for a customer's own domain.
6. [reference-wfp.md](reference-wfp.md) the reference-deployment design for a Workers for Platforms operator (issue #35).
7. [known-limitations.md](known-limitations.md) the open items, each with its issue.

## Approach A (scale-out)

- [approach-a-overview.md](approach-a-overview.md) **start here.** The story, why it fits in 128 MiB, and the database provider choice (Azure, PlanetScale, VPS, external) with the measured results.
- [approach-a.md](approach-a.md) the first measurements on a Vultr MariaDB box, and HostlessWP compared.
- [approach-a2.md](approach-a2.md) the PlanetScale variant (A2).
- [approach-a-objectcache.md](approach-a-objectcache.md) the write-aware object cache that cuts SQL round trips, including the L2 KV tier.

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
- [prior-art.md](prior-art.md) the projects this builds on, credited.

## Historical (retired, not the product)

These pages record work that is retired or superseded. They stay because a failed or retired result is still a result. Do not build on them.

- [approach-c1.md](approach-c1.md) WooCommerce in a Container, SQLite on disk, Litestream to R2. **Retired (#214).** It worked, but b-dosql and approach A do checkout without a container.
- [approach-c-checkout.md](approach-c-checkout.md) checkout in a Container (B+C). **Retired (#214).** Never stable.
- The D1 variant inside [approach-b.md](approach-b.md): plain B on D1 is partial (checkout exceeds the memory limit). Use b-dosql.

The code: `deploy/provision` (the Worker-provisionable core), `deploy/onboard` (approach A onboarding), `deploy/wfp` (the Workers for Platforms reference deployment and its Terraform, including WAF and Access), `deploy/zone` (the zone edge cache), `spikes/` (the research prototypes, see [spikes/README.md](../spikes/README.md)).
