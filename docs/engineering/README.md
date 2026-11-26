# Engineering

This page is for you if you want the research behind Pagefeather. It indexes those pages at their current paths. Nothing listed here has moved.

The [guide](../guide/README.md) helps you pick a path and run a site. The [docs map](../README.md) lists both sides. [Prior art](../prior-art.md) credits the projects this work builds on.

**Names used below.** The built-in database option is `b-dosql` (PHP and its SQLite database in one Durable Object). The MySQL option is approach A (PHP-WASM in a Worker, MySQL through Hyperdrive). Deploy commands and every setting are in the [deploy reference](../../deploy/README.md).

## The approaches

| Id | Approach | WordPress database | PHP runs in |
| --- | --- | --- | --- |
| A | PHP-WASM in a Worker, database outside Cloudflare | MySQL through Hyperdrive | Worker |
| B | PHP-WASM in a Worker, database on Cloudflare | SQLite on D1 or a Durable Object | Worker |
| C | Stock WordPress image in a Container | SQLite on disk (snapshotted), or MySQL through Hyperdrive | Container |
| D | Headless: a Worker serves the store, WordPress is the back office | Any of A, B, C, or a normal host | Worker + WordPress |

## What runs on which plan

Every claim carries a label: **measured** (we deployed it and ran a test in `tests/`, linked to [results.md](../results.md)), **docs** (Cloudflare documents it but we did not deploy it), **claimed** (a third party says so), **no** (a named limit blocks it), or **unbuilt**. These are short verdicts; the linked doc carries the numbers, dates, and caveats.

| Id | Workers Free | Workers Paid | Detail |
| --- | --- | --- | --- |
| **A** (external MySQL) | **no** (the installer is refused at the 10 ms CPU limit) | **measured: yes.** Full WordPress and WooCommerce, 12 of 12 checkout tests, under the 128 MiB cap with no container; scales out horizontally. Cost is per-query database latency (give Hyperdrive the host name, about 7 ms). | [approach-a.md](../approach-a.md) |
| **A2** (A on PlanetScale) | not tried | **measured: yes.** WooCommerce 12 of 12; about 16 ms a query; one Cloudflare bill. Set `HYPERDRIVE_SQL_MODE` and turn the Hyperdrive query cache off. | [approach-a2.md](../approach-a2.md) |
| **B** (D1 or Durable Object) | **measured: yes on b-dosql** (PHP in a Durable Object): the installer, the pages, the login, the dashboard and the editor, on both engines ([#638](https://github.com/skyphusion-labs/pagefeather/issues/638)). The D1 variant, with PHP in the Worker, is only partial (its CPU limit). | **measured: yes.** Every page renders, the installer runs, 18 of 18 plugins. Media library on R2 works (turn R2 on in the dashboard first). | [approach-b.md](../approach-b.md) |
| **B with WooCommerce** | **a light storefront only.** Shop, cart and checkout work on b-dosql ([#638](https://github.com/skyphusion-labs/pagefeather/issues/638)); editing the store does not fit Free's memory limit, so use Workers Paid. | **measured: yes, a light storefront only.** b-dosql (SQLite in a Durable Object) runs WooCommerce including checkout under the 128 MiB cap. Under load the isolate can reset, and a write in flight can be lost ([#1022](https://github.com/skyphusion-labs/pagefeather/issues/1022)). A real store uses approach A. Prefer b-dosql over plain D1, whose checkout exceeds the memory limit. | [results.md](../results.md) |
| **C1** (Container, SQLite, Litestream to R2) | **no** (Containers are Paid only) | **retired (#214).** It worked (12 of 12 store tests, 18 of 18 plugins), but b-dosql replaced the container store path, including the earlier in-container checkout (B+C), [approach-c-checkout.md](../approach-c-checkout.md). | [approach-c1.md](../approach-c1.md) |
| **C / D** | **no** / **docs** | **docs** | Containers are Paid-only with ephemeral disk; D needs one of A, B or C behind it. |

**Which to choose for a store:** **b-dosql** for a light storefront with no outside database ([#1022](https://github.com/skyphusion-labs/pagefeather/issues/1022)). **Approach A** (external MySQL) for a real store with concurrent traffic. The container store path is retired (#214).

## Conformance status (sprint sb1120, #759)

These are selected suite rows from [results.md](../results.md). The same summary, with the open items, is in [support-matrix.md](../support-matrix.md). The 12 of 12 figures in the table above are `tests/woo.py`. They are a different test from the upstream wc suite.

- **Hyperdrive WordPress** (`cf759hw`, WordPress only, WooCommerce not installed on that site): the wp suite is 18 of 18, and routes.py had 0 failures. The Worker is placed next to the database (#1054). On a Hyperdrive store (`cf759hl`) the latest wp row is 17 of 18. That row is from before #1167, and no later wp row re-measures it.
- **Hyperdrive WooCommerce** (`cf759hl`): the standalone comparison on November 23 recorded 207 expected and 22 unexpected at `be82396c` (row "#1407 wc"). The focused blocks checkout run on #1219 passed 10 of 10. The focused order email run on #1224 passed 6 of 6. The WooCommerce "development version" admin notice is fixed (#1221, PR #1227 merged). A live check on `cf759p` found it on 0 of 3 admin pages (row "#1227 live"). No conformance suite row tests the notice.
- **Standalone approach A WooCommerce** (2026-11-26, #1501): the suite rows are in [results.md](../results.md). The row ids are `#1501 (standalone wc-api)` and `#1501 (standalone wc)`. The targeted row ids are `#1501 (targeted standalone wc-api)` and `#1501 (targeted standalone wc)`. The same summary is in [support-matrix.md](../support-matrix.md). The support matrix states the open cases. The recorded suites use main `f4b84c8e`. Current main is later than `f4b84c8e`.
- **DO WordPress on Paid:** Browser Run wp on `cf759p` is 18 of 18. A local run on the same build was 17 of 18 because of a memory reset (#1022, open). WfP `cf759a` wp is 17 of 18, the same reset.
- **DO WooCommerce on Paid** (2026-11-20, no later wc row): Paid DO `cf759p` is 176 expected and 51 unexpected. WfP `cf759a` is 178 expected and 50 unexpected. The open engine classes are the memory reset (#1022) and parallel REST 503s (#1042).
- **DO WordPress on Free** (`cf759f`, no WooCommerce, media on): wp is 18 of 18, routes.py had 0 failures, and uploads persist (`media_probe.py`, 14 checks).

Browser Run is the default suite browser for wp and wc. It is not valid for the Gutenberg keyboard and clipboard specs. See [conformance.md](../conformance.md).

## Before you trust the speed numbers

- **Transactions.** `b-do` (D1) has no cross-call `ROLLBACK`; `b-dosql`, `c1`, `a` and `a2` do. Code that relies on `ROLLBACK` (WooCommerce, some plugins, upgrades) must not run on `b-do`. See [approach-b.md](../approach-b.md).
- **One run is not a number.** The same build moved up to 15% between runs, and `a` served 18.7 requests a second in one load matrix and 8.63 in another. So we bracket every comparison here (the same build with the change off, on, and off again) or repeat it across starts; we never quote a single run as the number for a variant.

## How a cell becomes measured

Put a deploy script and a test in `tests/<id>/`. Deploy to an account on the plan named in the column. Run the test and record the command, date, Wrangler version and result in [results.md](../results.md). Then change the mark and link the result.

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

- [Reference deployment](../reference-wfp.md). A design draft from 2026-11-06 for a Workers for Platforms operator (issue #35). The day-one steps are in [Run WordPress sites on your own Workers for Platforms account](../guide/operator.md).
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
- [Engineering limits](../limits-engineering.md). Limits for an engineer or operator only.

## History

- [Approach C1](../approach-c1.md). WooCommerce in a Container, with SQLite on disk and Litestream to R2. Retired (#214).
- [Checkout in a Container](../approach-c-checkout.md). Checkout in a Container. Retired (#214).
