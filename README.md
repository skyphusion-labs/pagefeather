# WordPress on Cloudflare

**WordPress and WooCommerce on Cloudflare's edge: no server, no database box, near zero at rest.**

This is for edge and serverless developers, and for anyone tired of looking after a WordPress VPS.
It is a framework you run on your own Cloudflare Workers for Platforms account. Each site is
WordPress with PHP and its SQLite database inside one Durable Object, made by one command or by a
Worker. It also holds the research behind that design (the matrix below).

## What it handles well, and where the ceiling is

- **WordPress sites, including high-traffic ones, served from the edge.** Logged-out pages come from
  the edge page cache and never reach PHP. Measured: cached reads ran at about 26 to 30 requests a
  second per site with a p50 near 200 ms, a lower bound set by the test client
  ([docs/load-152.md](docs/load-152.md), 2026-11-08). That is 20 to 100 times the uncached rate.
- **WooCommerce for low-to-moderate stores.** Cart, checkout, the admin and logged-in pages are
  never cached, so every one of them runs PHP in the site's one Durable Object. That path is about
  5 requests a second per site ([docs/perf-dosql.md](docs/perf-dosql.md), "What sets b-dosql's
  limit"). For real concurrent store traffic, use approach A (external MySQL through Hyperdrive),
  below.

## A live example

[ggc.sh](https://ggc.sh) is an example WooCommerce store on this framework. It is slower than a
cached site on purpose: its `ggc-cache.php` sends `Cache-Control: private, no-store` on every
storefront page, because those pages carry the live catalog and the order-attribution decision. So
what you see on ggc.sh is the uncached path, not the cached one.

## Quickstart

> **Not yet run end to end from a fresh clone.** The commands below are the `deploy/wfp` flow in
> [docs/operator.md](docs/operator.md), the one the isolation proofs use. A measured run of
> `site add` and `site remove` is next. Do not use `deploy/provision/cli.mjs add` as a quickstart
> yet: measured 2026-11-11, it makes the site's parts but no dispatcher, so the site answers 404 on
> `workers.dev`, and the CLI has no `remove` or `list`.

You need a Cloudflare account on the **Workers for Platforms Paid** plan, an API token and the tools
listed in [docs/operator.md](docs/operator.md) ("What you need": Node, Wrangler 4.107.0 or later,
Terraform 1.5 or later). Then:

```sh
export CLOUDFLARE_API_TOKEN=<the token>
export ACCOUNT_ID=<your Cloudflare account id>   # set it: the scripts default to an account that is not yours
export SITES="blog"                              # your site names; a blog or a WooCommerce store
./deploy/wfp/up.sh                # once: builds b-dosql, the namespace, KV site map, outbound Worker, SITES
./deploy/wfp/site add shop        # one more site; refuses if any part of "shop" exists already
./deploy/wfp/site list            # the sites you have
./deploy/wfp/site remove shop     # checks that every part is gone
```

Each site answers at `https://wp-<name>.<your-subdomain>.workers.dev` and installs WordPress on
first boot. The admin user is `admin`; its password is a Terraform output (docs/operator.md shows
the command).

Coming from a LAMP host? Read [docs/from-lamp-to-wfp.md](docs/from-lamp-to-wfp.md) first. Every
document is indexed in [docs/](docs/README.md).

## Honest limits

- **One Durable Object per site:** one writer, one region, and one request at a time for anything
  the cache cannot answer. That is about 5 uncached requests a second; past that the queue grows,
  and at about 100 clients the object refuses ([docs/perf-dosql.md](docs/perf-dosql.md)).
- **On a WooCommerce store, bundle size is the first wall.** A Worker is limited to 64 MiB
  uncompressed, and the upload gate stops at 62 MiB. WooCommerce alone takes the bundle to 58.3
  MiB. Measured with WooCommerce (#279): Yoast SEO (67.9 MiB), All in One SEO (67.5) and Elementor
  (83.8) do not fit, and SEOPress (63.1) is over the gate. Rank Math fits the bundle but hits the
  memory wall (next item). The SEO Framework and Slim SEO fit the bundle; their memory is not
  measured yet, because activation failed on the test store (#289). A way to move plugin and theme
  source out of the bundle is being designed; it is not a promise that these plugins will fit
  ([#279](https://github.com/skyphusion-labs/wordpress-on-cloudflare/issues/279)).
- **128 MiB of memory per request (the isolate).** A heavy plugin set can exceed it. A store with
  Rank Math reaches 119 MiB a request, and every other request answers 503; without it, the same
  store passes checkout ([docs/known-limitations.md](docs/known-limitations.md),
  [#279](https://github.com/skyphusion-labs/wordpress-on-cloudflare/issues/279)).
- **Workers Free only partly works.** Cached pages hit and most renders fit, but the installer and
  WooCommerce do not (the plan table below).
- **Cost:** two idle sites cost about $25 a month, the Workers for Platforms Paid subscription
  ([docs/plan-limits.md](docs/plan-limits.md)).

## The research

A cell in the tables below is **measured** (we deployed it and ran a test in `tests/`, linked to [docs/results.md](docs/results.md)), **docs** (Cloudflare documents it but we did not deploy it), **claimed** (a third party says so), **no** (a named limit blocks it), or **unbuilt**.

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
| **B** (D1 or Durable Object) | **partial.** Cached pages hit; most renders fit with OPcache; the installer does not fit. | **measured: yes.** Every page renders, the installer runs, 18 of 18 plugins. Media library on R2 works (turn R2 on in the dashboard first). | [approach-b.md](docs/approach-b.md) |
| **B with WooCommerce** | **no** (CPU limit) | **measured: yes, this is the store path.** b-dosql (SQLite in a Durable Object) runs WooCommerce including checkout under the 128 MiB cap. Use it over plain D1, whose checkout exceeds the memory limit. | [results.md](docs/results.md) |
| **C1** (Container, SQLite, Litestream to R2) | **no** (Containers are Paid only) | **retired (#214).** It worked (12 of 12 store tests, 18 of 18 plugins), but b-dosql replaced the container store path, including the earlier in-container checkout (B+C), [approach-c-checkout.md](docs/approach-c-checkout.md). | [approach-c1.md](docs/approach-c1.md) |
| **C / D** | **no** / **docs** | **docs** | Containers are Paid-only with ephemeral disk; D needs one of A, B or C behind it. |

**Which to use for a store:** **b-dosql** (zero outside infrastructure) for light-to-moderate traffic; **approach A** (external MySQL) to scale out to real concurrent traffic. The container store path is retired; a standard-LAMP VPS is the alternative for a store that outgrows b-dosql.

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
