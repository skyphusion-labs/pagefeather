# WordPress on Cloudflare

A **framework** for running many WordPress sites and WooCommerce stores on your own Cloudflare Workers for Platforms account, each provisioned by one command or by a Worker, and the **research** that produced it: a matrix of which approaches work on which Cloudflare plan, every claim sourced.

- **Run sites:** start with the quickstart, [docs/framework.md](docs/framework.md). Coming from a LAMP host, read [docs/from-lamp-to-wfp.md](docs/from-lamp-to-wfp.md) first.
- **Read the research:** the matrix is below; every document is indexed in [docs/](docs/README.md).

A cell is **measured** (we deployed it and ran a test in `tests/`, linked to [docs/results.md](docs/results.md)), **docs** (Cloudflare documents it but we did not deploy it), **claimed** (a third party says so), **no** (a named limit blocks it), or **unbuilt**.

## The approaches

| Id | Approach | WordPress database | PHP runs in |
| --- | --- | --- | --- |
| A | PHP-WASM in a Worker, database outside Cloudflare | MySQL through Hyperdrive | Worker |
| B | PHP-WASM in a Worker, database on Cloudflare | SQLite on D1 or a Durable Object | Worker |
| C | Stock WordPress image in a Container | SQLite on disk (snapshotted), or MySQL through Hyperdrive | Container |
| D | Headless: a Worker serves the store, WordPress is the back office | Any of A, B, C, or a normal host | Worker + WordPress |

## What runs on which plan

Short verdicts here; the linked doc carries the numbers, dates and caveats.

| Id | Workers Free | Workers Paid | Detail |
| --- | --- | --- | --- |
| **A** (external MySQL) | **no** (the installer is refused at the 10 ms CPU limit) | **measured: yes.** Full WordPress and WooCommerce, 12 of 12 checkout tests, under the 128 MiB cap with no container; scales out horizontally. Cost is per-query database latency (give Hyperdrive the host name, about 7 ms). | [approach-a.md](docs/approach-a.md) |
| **A2** (A on PlanetScale) | not tried | **measured: yes.** WooCommerce 12 of 12; about 16 ms a query; one Cloudflare bill. Set `HYPERDRIVE_SQL_MODE` and turn the Hyperdrive query cache off. | [approach-a2.md](docs/approach-a2.md) |
| **B** (D1 or Durable Object) | **partial.** Cached pages hit; most renders fit with OPcache; the installer does not fit. | **measured: yes.** Every page renders, the installer runs, 18 of 18 plugins. | [approach-b.md](docs/approach-b.md) |
| **B with WooCommerce** | **no** (CPU limit) | **measured: yes, this is the store path.** b-dosql (SQLite in a Durable Object) runs WooCommerce including checkout under the 128 MiB cap. Use it over plain D1, whose checkout exceeds the memory limit. | [results.md](docs/results.md) |
| **C1** (Container, SQLite, Litestream to R2) | **no** (Containers are Paid only) | **retired (#214).** It worked (12 of 12 store tests, 18 of 18 plugins), but b-dosql replaced the container store path. | [approach-c1.md](docs/approach-c1.md) |
| **C / D** | **no** / **docs** | **docs** | Containers are Paid-only with ephemeral disk; D needs one of A, B or C behind it. |

**Which to use for a store:** **b-dosql** (zero outside infrastructure) for light-to-moderate traffic; **approach A** (external MySQL) when it must scale out; a VPS for sustained high-concurrency load. The container store path is retired.

## Before you trust the speed numbers

- **Transactions.** `b-do` (D1) has no cross-call `ROLLBACK`; `b-dosql`, `c1`, `a` and `a2` do. Code that relies on `ROLLBACK` (WooCommerce, some plugins, upgrades) must not run on `b-do`. See [approach-b.md](docs/approach-b.md).
- **One run is not a number.** The same build moved up to 15% between runs, and `a` served 18.7 requests a second in one load matrix and 8.63 in another. So every comparison here is bracketed (the same build with the change off, on, and off again) or repeated across starts; a single run is never quoted as the number for a variant.

## Cost

Two idle `b-dosql` sites cost about **$25 a month**, the Workers for Platforms Paid subscription, with every per-site resource (Durable Object storage, R2 media, KV) inside a free or included tier at rest. Traffic is metered on top. One open question: whether the per-site dispatcher and the shared outbound Worker need a separate Workers Paid subscription ($5 a month), which would make it about $30; this is not stated on the WfP pricing page and needs a billing check.

Full cost line items and the per-plan limit table that decides the matrix above: [docs/plan-limits.md](docs/plan-limits.md).

## More

- Prior art: [docs/prior-art.md](docs/prior-art.md).
- **How a cell becomes measured:** put a deploy script and a test in `tests/<id>/`; deploy to an account on the plan named in the column; run the test and record the command, date, Wrangler version and result in [docs/results.md](docs/results.md); then change the mark and link the result.

## License

GPL-2.0. See [LICENSE](LICENSE).
