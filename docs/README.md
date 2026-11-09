# Docs

This repository is two things: a **framework** you run on your own Cloudflare account, and the **research** that produced it. Start with the product map below.

## The product in one view

Two ways to run a site are current. Pick by how much traffic you expect and how much infrastructure you want to run.

| | **Approach A** (recommended to scale) | **b-dosql** (zero infrastructure) |
| --- | --- | --- |
| What it is | WordPress as PHP-WASM in a Worker, database on managed MySQL through Hyperdrive | WordPress as PHP-WASM with SQLite inside one Durable Object |
| Outside server | Yes: a MySQL you choose (PlanetScale, Azure, a VPS, or your own) | None |
| WooCommerce | 12 of 12, checkout included, under the 128 MiB isolate cap, no container | Works, checkout included |
| Under heavy load | Scales sideways: more Worker isolates as load rises | One object per site: requests queue behind it, and a loaded store can overload |
| Consistency | Whatever your MySQL gives | Strong, single writer |
| Best for | Stores and sites with real concurrent traffic | Blogs, low to moderate traffic, anyone who wants nothing to run |

The measured numbers behind this table are in [approach-a-overview.md](approach-a-overview.md) and in [results.md](results.md) (rows `A vs b-dosql (concurrency)` and `A vs b-dosql (fully loaded, 2608 products)`, 2026-11-09).

**Retired:** the container approaches (c1 and the B+C checkout) were retired in #214. They are kept as a record. See [Historical](#historical-spike-records-not-the-product) below.

## Use the product

1. [onboarding.md](onboarding.md) the flow for approach A: choose a MySQL provider, set up its Hyperdrive configuration, then add type-a sites. **Commands pending** (two pull requests in progress).
2. [framework.md](framework.md) the quickstart for the b-dosql kind and the one provisioning surface, including provisioning from a Worker.
3. [from-lamp-to-wfp.md](from-lamp-to-wfp.md) coming from a traditional LAMP WordPress host: your stack mapped one to one onto this one.
4. [operator.md](operator.md) the day-one walkthrough for running a couple of sites: scripts, Terraform, update and rollback, custom hostnames, teardown.
5. [reference-wfp.md](reference-wfp.md) the reference-deployment design for a Workers for Platforms operator (issue #35).

## Approach A (current)

- [approach-a-overview.md](approach-a-overview.md) **start here.** The story, why it fits in 128 MiB, and the database provider choice (Azure, PlanetScale, VPS, external) with the measured results.
- [approach-a.md](approach-a.md) the first measurements on a Vultr MariaDB box, and HostlessWP compared.
- [approach-a2.md](approach-a2.md) the PlanetScale variant (a2).
- [approach-a-objectcache.md](approach-a-objectcache.md) the write-aware object cache that cuts SQL round trips.

## b-dosql (current)

- [perf-dosql.md](perf-dosql.md) tuning b-dosql, the variant the framework runs for blogs and stores.
- [load-152.md](load-152.md) the measured b-dosql ceiling under concurrent multi-site load, and when to move to Approach A.
- [approach-b.md](approach-b.md) the long record of how WordPress on PHP-WASM was built. It starts with D1; the shipped variant is b-dosql (section 8j).

## Supporting

- [plugins.md](plugins.md) a standard plugin suite run against each setup.
- [wfp.md](wfp.md) the Workers for Platforms spike: dispatch Worker, one user Worker per site, per-tenant limits.
- [async-email-durable-retry.md](async-email-durable-retry.md) durable retry for outgoing email.

## Evidence

- [results.md](results.md) every deploy and test run that backs a measured cell, with the command, date and Wrangler version. Measurements are never deleted. A later row can correct an earlier one; read the whole table (see the note at its top).
- [prior-art.md](prior-art.md) the projects this builds on, credited.

## Historical spike records (not the product)

These pages record work that is retired or superseded. They stay because a failed or retired result is still a result. Do not build on them.

- [approach-c1.md](approach-c1.md) WooCommerce in a Container, SQLite on disk, Litestream to R2. **Retired (#214).** It worked, but b-dosql and approach A do checkout without a container.
- [approach-c-checkout.md](approach-c-checkout.md) checkout in a Container (B+C). **Retired (#214).** Never stable.
- The D1 variant inside [approach-b.md](approach-b.md): plain B on D1 is partial (checkout exceeds the memory limit). Use b-dosql.

The code: `deploy/provision` (the Worker-provisionable core), `deploy/wfp` (the Workers for Platforms reference deployment), `spikes/` (the research prototypes, see [spikes/README.md](../spikes/README.md)).
