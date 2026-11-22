# Engineering

This page is for you if you want the research behind Pagefeather. It indexes those pages at their current paths. Nothing listed here has moved.

The [guide](../guide/README.md) helps you pick a path and run a site. The [docs map](../README.md) lists both sides. [Prior art](../prior-art.md) credits the projects this work builds on.

## Current paths

- [Approach A overview](../approach-a-overview.md). WordPress in a Worker, with MySQL through Hyperdrive: the story, the write ceiling, and the database choices that were measured.
- [Approach A](../approach-a.md). The first measurements of approach A, with MySQL outside Cloudflare through Hyperdrive.
- [Approach A2](../approach-a2.md). Approach A on PlanetScale MySQL through Hyperdrive.
- [Approach B](../approach-b.md). The long record of WordPress on PHP-WASM. It starts with D1. The shipped variant is b-dosql (section 8j).
- [Workers for Platforms spike](../wfp.md). What the spike verified: a dispatch Worker, and one user Worker per site.

## Measurements

- [b-dosql timing](../perf-dosql.md). Where the time goes on b-dosql, and what sets its limit.
- [Load ceiling](../load-152.md). The b-dosql ceiling under concurrent load on many sites (issue #152).
- [Admin memory matrix](../admin-memory-matrix.md). Where WordPress admin runs out of memory. Measured 2026-11-14.
- [Object cache](../approach-a-objectcache.md). A write-aware object cache for approach A, including the L2 KV tier.
- [PHP overflow](../approach-a-overflow.md). The PHP overflow pool for approach A. It is off by default on `deploy/deploy.sh` since #1277.
- [Plugin suite](../plugins.md). A standard set of plugins, run against each setup.
- [OPcache shared memory](../opcache-shm-610.md). OPcache shared memory against the file-cache fallback (#610).
- [OPcache remote packs](../opcache-remote-563.md). OPcache files served as remote packs, and the pause in open() (#563).
- [Site remote packs](../site-remote-569.md). site.zip served as remote packs, and the pause in open() (#569).
- [Bundle file trace](../m0-394-file-trace.md). Which bundle files one request reads (#394, step M0).
- [Request frames](../request-frames-352.md). An isolate reset rolls one request back (#352).
- [WP-CLI local spike](../spikes/wp-cli-1258.md). Whether WP-CLI runs in the local PHP runtime (issue #1258).

## Designs

- [Reference deployment](../reference-wfp.md). A design draft from 2026-11-06 for a Workers for Platforms operator (issue #35). The day-one steps are in [Run WordPress sites on your own Workers for Platforms account](../operator.md).
- [Durable email retry](../async-email-durable-retry.md). Durable retry for outgoing email through Queues. It is opt-in.
- [Vectorize search](../vectorize-search.md). Opt-in semantic search. It is not measured end to end.
- [Admin lever](../design-394-admin-lever.md). Design for the admin lever (#394).
- [Bundle and isolate memory](../design-394-bundle-out-of-memory.md). Design for the site bundle and isolate memory (#394).
- [One-click path](../design-401-one-click.md). Design notes for a one-click path (issue #401).
- [Plugin persistence](../design-407-plugin-persistence.md). Design so plugins and themes installed in wp-admin persist (#407).
- [Admin memory](../design-434-admin-memory.md). Where admin memory goes, and what can move out (#434, for #394).
- [Move to Hyperdrive](../design-479-move-to-hyperdrive.md). Design for moving a standard store to a Hyperdrive store (#479).

## Results

- [Results](../results.md). Every deploy and test run that backs a measured cell. A later row can correct an earlier one. Rows stay.
- [Support matrix](../support-matrix.md). What works on each tier and deploy path, what is limited, and why (#759).
- [Conformance](../conformance.md). How the WordPress and WooCommerce suites are run for that matrix (#759).

## History

- [Approach C1](../approach-c1.md). WooCommerce in a Container, with SQLite on disk and Litestream to R2. Retired (#214).
- [Checkout in a Container](../approach-c-checkout.md). Checkout in a Container. Retired (#214).
