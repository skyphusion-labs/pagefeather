# Pagefeather

**WordPress and WooCommerce on Cloudflare's edge.** Approach A uses your MySQL. b-dosql needs no database box.

Before 2026-11-13, the name of this repository was `wordpress-on-cloudflare`.

Welcome. If you build WordPress sites, for yourself or for clients, and you are tired of looking
after a WordPress VPS, this project is for you. It is also for edge and serverless developers who
want to see how far WordPress can go on Cloudflare.

Pagefeather is a framework for WordPress on Cloudflare. There are two supported ways to run a site.

**Approach A.** PHP-WASM (PHP compiled to WebAssembly) runs in a Worker. The database is an external
MySQL server, reached through Hyperdrive. This path runs on the Workers Paid plan. You deploy it
with `deploy/deploy.sh`.

**b-dosql.** PHP and its SQLite database run inside one Durable Object (one Cloudflare object that
keeps the site's state). You can run one site on a Workers Paid or Workers Free account. You deploy
that site with `deploy/deploy.sh` (`VARIANT=b-dosql`). You can also run many sites on Workers for
Platforms. You deploy those sites with `deploy/wfp`. Workers for Platforms adds many sites in one
namespace, and the site manager (`deploy/wfp/site`). A Workers for Platforms account costs $30 a
month for two or more sites ([docs/plan-limits.md](docs/plan-limits.md)). That is the Workers for
Platforms Paid plan ($25) plus the Workers Paid plan ($5).

On Workers Free, b-dosql runs plain WordPress and a light storefront only. Editing a WooCommerce store does not
fit Free's memory
([#638](https://github.com/skyphusion-labs/pagefeather/issues/638); the **B with WooCommerce** row
below). One Durable Object per site means one writer, one region, and about 5 requests a second
for work the cache cannot answer
([docs/perf-dosql.md](docs/perf-dosql.md), "What sets b-dosql's limit").

The repository also holds the research behind both designs (the matrix below), so you can see what
we measured and what we did not.

This is a young project. Some parts are measured and solid, and some are still being built. This
page tells you which is which.

## What it does well today, and where it stops

- **WordPress sites, including high-traffic ones, served from the edge.** When a visitor is logged
  out, the page comes from the edge page cache and never reaches PHP. In our load test, cached
  reads ran at about 26 to 30 requests a second per site with a p50 near 200 ms. That figure is a
  lower bound set by the test client ([docs/load-152.md](docs/load-152.md), 2026-11-08), and it is
  20 to 100 times the uncached rate.
- **WooCommerce on b-dosql is for a light storefront; real stores use approach A on Hyperdrive.**
  Cart, checkout, the admin and logged-in pages are never cached, so each of them runs PHP in the
  site's one Durable Object. Under load, that object's isolate runs out of memory and resets: 43
  resets and 49 lost writes per 1000 server requests (perf lines) under our load harness (`cf759a`, 2026-11-22). The levers tried so far
  did not fix it, so it is a tracked limit
  ([docs/known-limitations.md](docs/known-limitations.md), #1022).
- **Approach A runs WordPress and WooCommerce on Workers Paid, and it scales out across isolates.**
  The WordPress wp suite is 18 of 18, and routes.py had 0 failures, on `cf759hw`
  ([docs/results.md](docs/results.md), the `cf759hw` wp and routes rows, 2026-11-20). WooCommerce
  `tests/woo.py` is 12 of 12, three runs in a row (row `A (12/12, the full stack, #218)`, 2026-11-09). At 50 concurrent
  users, Cloudflare started up to 118 isolates (row `A vs b-dosql (concurrency)`, 2026-11-09). You
  need an external MySQL server. A first request on a cold isolate is slow: it costs 3 to 9 s more
  at the client
  ([#1169](https://github.com/skyphusion-labs/pagefeather/issues/1169)). Blocks checkout is slow
  because one order deletes its transients one by one
  ([#1218](https://github.com/skyphusion-labs/pagefeather/issues/1218)).
  [PR #1219](https://github.com/skyphusion-labs/pagefeather/pull/1219) is open, so that fix is in
  progress, not fixed. Order emails can be late
  ([#1215](https://github.com/skyphusion-labs/pagefeather/issues/1215), open).
  [PR #1224](https://github.com/skyphusion-labs/pagefeather/pull/1224) is open. The WooCommerce
  "development version" admin notice is fixed
  ([#1221](https://github.com/skyphusion-labs/pagefeather/issues/1221),
  [PR #1227](https://github.com/skyphusion-labs/pagefeather/pull/1227) merged). A live check on `cf759p`
  after the merge found it on 0 of 3 admin pages (results.md row "#1227 live"). No conformance suite
  row tests the notice.
- **How many plugins fit** is a per-request limit on the heaviest admin pages
  ([How many plugins fit](docs/known-limitations.md#how-many-plugins-fit)).

## A live example

If you want to see it running, [ggc.sh](https://ggc.sh) is an example WooCommerce store on this
framework. Since 2026-11-15, its guest storefront pages are cached at the edge. ggc#111 removed the
mu-plugin that turned the cache off. After its next update, its product, shop and category pages
stay fresh for 30 s (`PAGE_CACHE_PRODUCT_TTL`, #628). Its other guest pages stay fresh for 120 s.
Cart, checkout, account and logged-in pages are never cached, so they run PHP every time.

## Quickstart

### b-dosql on Workers Paid or Free, with deploy/deploy.sh

You need a Cloudflare account on **Workers Paid** or **Workers Free**. Workers Paid is $5 a month
([docs/plan-limits.md](docs/plan-limits.md), read 2026-11-06). The commands below are the
`VARIANT=b-dosql` flow in [deploy/README.md](deploy/README.md). One command makes the site,
installs WordPress and measures it. b-dosql has no D1 database. The database is the Durable
Object's own SQLite ([deploy/README.md](deploy/README.md), variant `b-dosql`).

On Workers Free, b-dosql runs plain WordPress and a light storefront only. Shop, cart and checkout work.
Editing a WooCommerce store does not fit Free's memory, so use Workers Paid to edit a store
([#638](https://github.com/skyphusion-labs/pagefeather/issues/638); the **B with WooCommerce** row
in [What runs on which plan](#what-runs-on-which-plan)).

One Durable Object holds the site. That is one writer, one region, and about 5 requests a second
for work the cache cannot answer
([docs/perf-dosql.md](docs/perf-dosql.md), "What sets b-dosql's limit").

DO WordPress on Paid (`cf759p`) and DO WordPress on Free (`cf759f`), in the results below, are
`deploy/deploy.sh` sites ([docs/results.md](docs/results.md), the 2026-11-20 rows). `cf759a` is
the Workers for Platforms site.

```sh
export CLOUDFLARE_API_TOKEN=...   # Workers Scripts (and R2 if MEDIA=1)
export ACCOUNT_ID=...

# One site. Set VARIANT=b-dosql. The default VARIANT is b-do.
# MEDIA=1 makes an R2 bucket for uploads. Turn R2 on for the account first.
# Without MEDIA=1, uploads do not persist.
# Pass MEDIA=1 again on every later deploy of a site that has media.
VARIANT=b-dosql MEDIA=1 NAME=my-site ./deploy/deploy.sh

# Remove the site. Same token and account.
NAME=my-site ./deploy/destroy.sh
```

The script prints the site address. The admin password is a Terraform output
([deploy/README.md](deploy/README.md)):

```sh
cd deploy/terraform && terraform workspace select my-site && terraform output -raw admin_password
```

A later deploy that would delete the media bucket is refused. To delete that bucket and every
upload in it on purpose, set `DESTROY_MEDIA=1`
([deploy/README.md](deploy/README.md), `MEDIA` and `DESTROY_MEDIA`).

### b-dosql on Workers for Platforms, with deploy/wfp

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

### Approach A, with deploy/deploy.sh

You need a Cloudflare account on the **Workers Paid** plan, and an external MySQL server. On
Workers Free this path stops at the CPU limit. The commands below are the variant `a` flow in
[deploy/README.md](deploy/README.md). One command makes the site, installs WordPress and measures
it. The Workers Paid plan is $5 a month
([docs/plan-limits.md](docs/plan-limits.md), read 2026-11-06). You also pay for the MySQL server.
A `MYSQL=vultr` box is $10 a month ([deploy/README.md](deploy/README.md)).

```sh
export CLOUDFLARE_API_TOKEN=...   # Workers Scripts, D1 (and R2 if MEDIA=1)
export ACCOUNT_ID=...

# Your own MySQL. A public server must have SSL.
# PLACEMENT is required. Use the database region, for example azure:westus2 (#1054).
VARIANT=a MYSQL=external \
  MYSQL_HOST=mysql.example.com \
  MYSQL_USER=wp \
  MYSQL_PASSWORD=... \
  MYSQL_DATABASE=wordpress \
  PLACEMENT=azure:westus2 \
  NAME=my-site ./deploy/deploy.sh

# Or let deploy/mysql make a MariaDB box. PLACEMENT defaults to aws:us-east-2.
VARIANT=a MYSQL=vultr VULTR_API_KEY=... MYSQL_ZONE_ID=<zone> MYSQL_HOST=mysql-mysite.example.com NAME=my-site ./deploy/deploy.sh

# Remove the site. Same token and account.
NAME=my-site ./deploy/destroy.sh
```

The script prints the site address. The admin password is a Terraform output
([deploy/README.md](deploy/README.md)):

```sh
cd deploy/terraform && terraform workspace select my-site && terraform output -raw admin_password
```

## Limits you should know about

We would rather you hear these from us before you build on the project than find them later.

The [support matrix](docs/support-matrix.md) lists each WordPress and WooCommerce feature per tier and deploy path: supported, limited (and why), not supported, or not measured yet.

- **On b-dosql, one Durable Object per site:** one writer, one region, and one request at a time for anything
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
  for the WooCommerce setting that avoids this. Since #628, a store caches its product,
  shop and category pages for 30 s by default (`PAGE_CACHE_PRODUCT_TTL`). There, the number is
  usually at most about 30 s old. After a quiet spell, the first visitor can get a copy up to 60 s
  old. That is the 30 s, plus a 30 s stale-while-revalidate window (#699).
- **On a WooCommerce store, bundle size is the first wall.** A Worker is limited to 64 MiB
  uncompressed, and the upload gate stops at 62 MiB. WooCommerce alone takes the bundle to 58.3
  MiB. Measured with WooCommerce (#279): Yoast SEO (67.9 MiB), All in One SEO (67.5) and Elementor
  (83.8) do not fit, and SEOPress (63.1) is over the gate. Rank Math fits the bundle but hits the
  memory wall (next item). The SEO Framework and Slim SEO fit the bundle; we have not measured
  their memory yet, because activation failed on the test store (#289). We are designing a way to
  move plugin and theme source out of the bundle. That is work in progress, not a promise that
  these plugins will fit ([#279](https://github.com/skyphusion-labs/pagefeather/issues/279)).
- **The measured write ceiling** (117 to 119 MiB of wasm; see [memory limits](docs/known-limitations.md#memory-limits-the-three-figures)). A heavy plugin
  set can pass that ceiling. A store with Rank Math reaches 119 MiB a request, and every other request
  answers 503. Without Rank Math, the same store passes checkout
  ([docs/known-limitations.md](docs/known-limitations.md),
  [#279](https://github.com/skyphusion-labs/pagefeather/issues/279)).
- **On b-dosql, Workers Free runs plain WordPress and a light storefront.** Editing a WooCommerce
  store needs Workers Paid: on Free its editor hits the memory limit
  ([#638](https://github.com/skyphusion-labs/pagefeather/issues/638); the plan table below).
  Approach A does not run on Workers Free. The installer is refused at the 10 ms CPU limit (the
  plan table).
- **Cost, on b-dosql:** One site on Workers Paid is $5 a month
  ([docs/plan-limits.md](docs/plan-limits.md)). A pagefeather Workers for Platforms account costs $30 a month for two
  or more sites (same page). That is the Workers for Platforms
  Paid plan ($25) plus the Workers Paid plan ($5). The reference account runs both. The Workers
  for Platforms price includes 20 million requests, then $0.30 per million. It includes 60 million
  CPU ms, then $0.02 per million. It includes 1,000 namespace scripts, then $0.02 each. Another
  site at rest costs about $0, up to the 1,000 included scripts. Approach A is Workers Paid ($5 a month
  on that page) plus the MySQL server you run.

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

**Which to choose for a store:** **b-dosql** (zero outside infrastructure) for light-to-moderate traffic; **approach A** (external MySQL) to scale out to real concurrent traffic. The container store path is retired (#214).

## Conformance status (sprint sb1120, #759)

These are the latest suite rows in [docs/results.md](docs/results.md), from 2026-11-20 and 2026-11-21. The same summary, with the open items, is in [docs/support-matrix.md](docs/support-matrix.md). The 12 of 12 figures in the table above are `tests/woo.py`. They are a different test from the upstream wc suite.

- **Hyperdrive WordPress** (`cf759hw`, WordPress only, WooCommerce not installed on that site): the wp suite is 18 of 18, and routes.py had 0 failures. The Worker is placed next to the database (#1054). On a Hyperdrive store (`cf759hl`) the latest wp row is 17 of 18. That row is from before #1167, and no later wp row re-measures it.
- **Hyperdrive WooCommerce** (`cf759hl`): the latest full wc suite is 169 expected, 57 unexpected, 3 skipped (Browser Run, build `b27cd3c`). Held-block 503s in that run (#1177) are gone on the 8 files that hit them (#1180). Blocks checkout is slow: the order takes 9.3 to 11.8 s because of per-order transient deletes (#1218, #1210). PR #1219 is open, so that fix is in progress, not fixed. Order emails can wait 12 to 122 s (#1215, open). PR #1224 is open, so that fix is in progress, not fixed. The WooCommerce "development version" admin notice is fixed (#1221, PR #1227 merged). No later suite row re-measures that notice.
- **DO WordPress on Paid:** Browser Run wp on `cf759p` is 18 of 18. A local run on the same build was 17 of 18 because of a memory reset (#1022, open). WfP `cf759a` wp is 17 of 18, the same reset.
- **DO WooCommerce on Paid** (2026-11-20, no later wc row): Paid DO `cf759p` is 176 expected and 51 unexpected. WfP `cf759a` is 178 expected and 50 unexpected. The open engine classes are the memory reset (#1022) and parallel REST 503s (#1042).
- **DO WordPress on Free** (`cf759f`, no WooCommerce, media on): wp is 18 of 18, routes.py had 0 failures, and uploads persist (`media_probe.py`, 14 checks).

Browser Run is the default suite browser for wp and wc. It is not valid for the Gutenberg keyboard and clipboard specs. See [docs/conformance.md](docs/conformance.md).

## Before you trust the speed numbers

- **Transactions.** `b-do` (D1) has no cross-call `ROLLBACK`; `b-dosql`, `c1`, `a` and `a2` do. Code that relies on `ROLLBACK` (WooCommerce, some plugins, upgrades) must not run on `b-do`. See [approach-b.md](docs/approach-b.md).
- **One run is not a number.** The same build moved up to 15% between runs, and `a` served 18.7 requests a second in one load matrix and 8.63 in another. So we bracket every comparison here (the same build with the change off, on, and off again) or repeat it across starts; we never quote a single run as the number for a variant.

## Cost

One b-dosql site on Workers Paid is $5 a month
([docs/plan-limits.md](docs/plan-limits.md), read 2026-11-06). You deploy that site with
`deploy/deploy.sh`. The bill below is a Workers for Platforms account, for many sites.

A pagefeather Workers for Platforms account costs $30 a month for two or more sites. That is the Workers for Platforms Paid plan ($25) plus the Workers Paid plan ($5). The reference account runs both. The Workers for Platforms price includes 20 million requests, then $0.30 per million. It includes 60 million CPU ms, then $0.02 per million. It includes 1,000 namespace scripts, then $0.02 each. Another site at rest costs about $0, up to the 1,000 included scripts. Durable Object storage, R2 media, and KV stay inside a free or included tier at rest. Traffic is metered on top. Cloudflare's WfP pricing page does not say whether Workers Paid is strictly required, so plan for both.

Approach A is a different bill. It runs on Workers Paid, which is $5 a month
([docs/plan-limits.md](docs/plan-limits.md), read 2026-11-06). You also pay for the MySQL server.
A `MYSQL=vultr` box is $10 a month ([deploy/README.md](deploy/README.md)). Any other MySQL server
is your own bill.

Full cost line items and the per-plan limit table that decides the matrix above: [docs/plan-limits.md](docs/plan-limits.md).

## More

- What works on each tier and deploy path, and what is limited: [docs/support-matrix.md](docs/support-matrix.md).
- Prior art: [docs/prior-art.md](docs/prior-art.md). This project builds on others' work, and we credit it there.
- **How a cell becomes measured:** put a deploy script and a test in `tests/<id>/`; deploy to an account on the plan named in the column; run the test and record the command, date, Wrangler version and result in [docs/results.md](docs/results.md); then change the mark and link the result.

## Contributing

Contributions are welcome, from a typo fix to a newly measured cell. A failed deploy on a plan we
have not tried is a useful result too. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## License

GPL-2.0-or-later: the terms of the GNU General Public License version 2, or (at your option) any later version. See [LICENSE](LICENSE) for the version 2 text.

The pagefeather engine includes PHP and the Zend Engine. See [NOTICE](NOTICE) for the required acknowledgment lines and the list of linked components. The licence texts are in [engine/notices/LICENSES](engine/notices/LICENSES), and each GitHub Release that ships the engine carries `NOTICE`, `SOURCE` and `LICENSES.tar.gz`. A version tag ships the pinned lean engine (`spikes/b2-wordpress/engine.lock`). `PHP_ENGINE=npm` builds the npm Playground engine instead. The custom engine (variant s1-lean) is a separate prerelease; its notices are `engine/notices/lean/`.
