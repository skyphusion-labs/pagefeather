# Pagefeather

**WordPress and WooCommerce on Cloudflare's edge: no server, no database box, near zero at rest.**

Before 2026-11-13, the name of this repository was `wordpress-on-cloudflare`.

Welcome. If you build WordPress sites, for yourself or for clients, and you are tired of looking
after a WordPress VPS, this project is for you. It is also for edge and serverless developers who
want to see how far WordPress can go on Cloudflare.

Pagefeather is a framework you run on your own Cloudflare Workers for Platforms account. Each site
is WordPress with PHP and its SQLite database inside one Durable Object (one Cloudflare object that
keeps the site's state), made by one command or by a Worker. The repository also holds the research
behind that design (the matrix below), so you can see what we measured and what we did not.

This is a young project. Some parts are measured and solid, and some are still being built. This
page tells you which is which.

## What it does well today, and where it stops

- **WordPress sites, including high-traffic ones, served from the edge.** When a visitor is logged
  out, the page comes from the edge page cache and never reaches PHP. In our load test, cached
  reads ran at about 26 to 30 requests a second per site with a p50 near 200 ms. That figure is a
  lower bound set by the test client ([docs/load-152.md](docs/load-152.md), 2026-11-08), and it is
  20 to 100 times the uncached rate.
- **WooCommerce for low-to-moderate stores.** Cart, checkout, the admin and logged-in pages are
  never cached, so each of them runs PHP in the site's one Durable Object. That path handles about
  5 requests a second per site ([docs/perf-dosql.md](docs/perf-dosql.md), "What sets b-dosql's
  limit"). If your store has real concurrent traffic, approach A (external MySQL through
  Hyperdrive, below) is the better fit.

## A live example

If you want to see it running, [ggc.sh](https://ggc.sh) is an example WooCommerce store on this
framework. Since 2026-11-15, its guest storefront pages are cached at the edge. ggc#111 removed the
mu-plugin that turned the cache off. After its next update, its product, shop and category pages
stay fresh for 30 s (`PAGE_CACHE_PRODUCT_TTL`, #628). Its other guest pages stay fresh for 120 s.
Cart, checkout, account and logged-in pages are never cached, so they run PHP every time.

## Quickstart

> **We have not yet run this end to end from a fresh clone.** The commands below are the
> `deploy/wfp` flow in [docs/operator.md](docs/operator.md), the same flow the isolation proofs
> use. A measured run of `site add` and `site remove` from a fresh clone is next. If you try it
> first and something breaks, please open an issue; it helps us a lot. `deploy/wfp/site` is the
> one operator surface of this deployment
> ([#294](https://github.com/skyphusion-labs/pagefeather/issues/294)).
> `deploy/provision/cli.mjs` is for a site on a Cloudflare for SaaS zone only: without
> `WFP_SAAS_ZONE_ID` it refuses before any API call and names `deploy/wfp/site`.

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

Coming from a LAMP host? [docs/from-lamp-to-wfp.md](docs/from-lamp-to-wfp.md) is written for you:
it maps the jobs you already do onto this stack, so read it first. Every document is indexed in
[docs/](docs/README.md).

## Limits you should know about

We would rather you hear these from us before you build on the project than find them later.

- **One Durable Object per site:** one writer, one region, and one request at a time for anything
  the cache cannot answer. That is about 5 uncached requests a second; past that the queue grows,
  and at about 100 clients the object refuses ([docs/perf-dosql.md](docs/perf-dosql.md)).
- **A cached product page can show an old stock number.** A logged-out product page is cached for
  120 s (`PAGE_CACHE_TTL`). A checkout that lowers the stock number does not clear that copy. We
  measured it on a b-dosql store ([#628](https://github.com/skyphusion-labs/pagefeather/issues/628),
  2026-11-15). A guest saw "7 in stock" for 121 s after the stock fell to 6. After a quiet spell, the
  first visitor can get an older copy. It can be up to about 12 minutes old.
  When a product sells out, the page is cleared: it said "out of stock" within 23 s. The checkout
  always reads the real stock, so it never sells more than you have. If your pages show exact stock
  numbers, see [Stock numbers on cached pages](docs/from-lamp-to-wfp.md#stock-numbers-on-cached-pages)
  for the WooCommerce setting that avoids this. Since #628, a deploy/wfp store caches its product,
  shop and category pages for 30 s by default (`PAGE_CACHE_PRODUCT_TTL`). There, the number is at
  most about 30 s old.
- **On a WooCommerce store, bundle size is the first wall.** A Worker is limited to 64 MiB
  uncompressed, and the upload gate stops at 62 MiB. WooCommerce alone takes the bundle to 58.3
  MiB. Measured with WooCommerce (#279): Yoast SEO (67.9 MiB), All in One SEO (67.5) and Elementor
  (83.8) do not fit, and SEOPress (63.1) is over the gate. Rank Math fits the bundle but hits the
  memory wall (next item). The SEO Framework and Slim SEO fit the bundle; we have not measured
  their memory yet, because activation failed on the test store (#289). We are designing a way to
  move plugin and theme source out of the bundle. That is work in progress, not a promise that
  these plugins will fit ([#279](https://github.com/skyphusion-labs/pagefeather/issues/279)).
- **128 MiB of memory per request (the isolate).** A heavy plugin set can exceed it. A store with
  Rank Math reaches 119 MiB a request, and every other request answers 503; without it, the same
  store passes checkout ([docs/known-limitations.md](docs/known-limitations.md),
  [#279](https://github.com/skyphusion-labs/pagefeather/issues/279)).
- **Workers Free runs plain WordPress and a light storefront.** Editing a WooCommerce store needs
  Workers Paid: on Free its editor hits the memory limit
  ([#638](https://github.com/skyphusion-labs/pagefeather/issues/638); the plan table below).
- **Cost:** two idle sites cost about $25 a month, the Workers for Platforms Paid subscription
  ([docs/plan-limits.md](docs/plan-limits.md)).

## The research

Every claim in the tables below carries a label, so you can tell what we tested from what we only
read. A cell is **measured** (we deployed it and ran a test in `tests/`, linked to [docs/results.md](docs/results.md)), **docs** (Cloudflare documents it but we did not deploy it), **claimed** (a third party says so), **no** (a named limit blocks it), or **unbuilt**.

## The approaches

| Id | Approach | WordPress database | PHP runs in |
| --- | --- | --- | --- |
| A | PHP-WASM in a Worker, database outside Cloudflare | MySQL through Hyperdrive | Worker |
| B | PHP-WASM in a Worker, database on Cloudflare | SQLite on D1 or a Durable Object | Worker |
| C | Stock WordPress image in a Container | SQLite on disk (snapshotted), or MySQL through Hyperdrive | Container |
| D | Headless: a Worker serves the store, WordPress is the back office | Any of A, B, C, or a normal host | Worker + WordPress |

## What runs on which plan

These are short verdicts; the linked doc carries the numbers, dates and caveats.

| Id | Workers Free | Workers Paid | Detail |
| --- | --- | --- | --- |
| **A** (external MySQL) | **no** (the installer is refused at the 10 ms CPU limit) | **measured: yes.** Full WordPress and WooCommerce, 12 of 12 checkout tests, under the 128 MiB cap with no container; scales out horizontally. Cost is per-query database latency (give Hyperdrive the host name, about 7 ms). | [approach-a.md](docs/approach-a.md) |
| **A2** (A on PlanetScale) | not tried | **measured: yes.** WooCommerce 12 of 12; about 16 ms a query; one Cloudflare bill. Set `HYPERDRIVE_SQL_MODE` and turn the Hyperdrive query cache off. | [approach-a2.md](docs/approach-a2.md) |
| **B** (D1 or Durable Object) | **measured: yes on b-dosql** (PHP in a Durable Object): the installer, the pages, the login, the dashboard and the editor, on both engines ([#638](https://github.com/skyphusion-labs/pagefeather/issues/638)). The D1 variant, with PHP in the Worker, is only partial (its CPU limit). | **measured: yes.** Every page renders, the installer runs, 18 of 18 plugins. Media library on R2 works (turn R2 on in the dashboard first). | [approach-b.md](docs/approach-b.md) |
| **B with WooCommerce** | **a light storefront only.** Shop, cart and checkout work on b-dosql ([#638](https://github.com/skyphusion-labs/pagefeather/issues/638)); editing the store does not fit Free's memory limit, so use Workers Paid. | **measured: yes, this is the store path.** b-dosql (SQLite in a Durable Object) runs WooCommerce including checkout under the 128 MiB cap. Use it over plain D1, whose checkout exceeds the memory limit. | [results.md](docs/results.md) |
| **C1** (Container, SQLite, Litestream to R2) | **no** (Containers are Paid only) | **retired (#214).** It worked (12 of 12 store tests, 18 of 18 plugins), but b-dosql replaced the container store path, including the earlier in-container checkout (B+C), [approach-c-checkout.md](docs/approach-c-checkout.md). | [approach-c1.md](docs/approach-c1.md) |
| **C / D** | **no** / **docs** | **docs** | Containers are Paid-only with ephemeral disk; D needs one of A, B or C behind it. |

**Which to choose for a store:** **b-dosql** (zero outside infrastructure) for light-to-moderate traffic; **approach A** (external MySQL) to scale out to real concurrent traffic. The container store path is retired; a standard-LAMP VPS is the alternative for a store that outgrows b-dosql.

## Before you trust the speed numbers

- **Transactions.** `b-do` (D1) has no cross-call `ROLLBACK`; `b-dosql`, `c1`, `a` and `a2` do. Code that relies on `ROLLBACK` (WooCommerce, some plugins, upgrades) must not run on `b-do`. See [approach-b.md](docs/approach-b.md).
- **One run is not a number.** The same build moved up to 15% between runs, and `a` served 18.7 requests a second in one load matrix and 8.63 in another. So we bracket every comparison here (the same build with the change off, on, and off again) or repeat it across starts; we never quote a single run as the number for a variant.

## Cost

Two idle `b-dosql` sites cost about **$25 a month**, the Workers for Platforms Paid subscription, with every per-site resource (Durable Object storage, R2 media, KV) inside a free or included tier at rest. Traffic is metered on top. One question is still open: whether the per-site dispatcher and the shared outbound Worker need a separate Workers Paid subscription ($5 a month), which would make it about $30. The WfP pricing page does not say, and we still need to confirm it with a billing check.

Full cost line items and the per-plan limit table that decides the matrix above: [docs/plan-limits.md](docs/plan-limits.md).

## More

- Prior art: [docs/prior-art.md](docs/prior-art.md). This project builds on others' work, and we credit it there.
- **How a cell becomes measured:** put a deploy script and a test in `tests/<id>/`; deploy to an account on the plan named in the column; run the test and record the command, date, Wrangler version and result in [docs/results.md](docs/results.md); then change the mark and link the result.

## Contributing

Contributions are welcome, from a typo fix to a newly measured cell. A failed deploy on a plan we
have not tried is a useful result too. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## License

GPL-2.0-or-later: the terms of the GNU General Public License version 2, or (at your option) any later version. See [LICENSE](LICENSE) for the version 2 text.
