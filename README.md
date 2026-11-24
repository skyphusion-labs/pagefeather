# Pagefeather

<p align="center">
  <img src="site/assets/logo.svg" alt="Pagefeather" width="96" height="96">
</p>

**WordPress and WooCommerce on Cloudflare, in your own Cloudflare account.**

This is for you if you build WordPress sites, for yourself or for clients, and you are tired of looking after a WordPress server. You keep your own Cloudflare account. There is no hosted Pagefeather service, and nothing here sells you one.

**New here?** Go to [Start here](docs/guide/start-here.md). That one page shows how to install a site, how to log in, and what the limits are. Please read the [known limitations](docs/guide/limits.md) before you build. If you come from cPanel or a LAMP host, read [From a LAMP host](docs/guide/from-lamp.md) first.

## Two ways to run a site

| | Workers Free | Workers Paid ($5 a month) |
| --- | --- | --- |
| **Built-in database.** The database lives next to the site inside Cloudflare. You need no MySQL server. | WordPress, and a light shop. Editing a WooCommerce store does not fit Free's memory ([#638](https://github.com/skyphusion-labs/pagefeather/issues/638)). | WordPress, and a light shop. [Start here](docs/guide/start-here.md). |
| **MySQL.** The site uses a MySQL server that you run somewhere else. Use this for a real WooCommerce store. | No. The installer stops at Free's CPU limit. | WordPress and a real store. [Start here: MySQL](docs/guide/start-here-mysql.md). You also pay for the MySQL server. |

Many sites on one account use Workers for Platforms: $30 a month for two or more sites ([cost](docs/guide/cost.md#cost-of-a-pagefeather-workers-for-platforms-account)).

With the built-in database option, one site handles about 5 requests a second for work the cache cannot answer ([evidence](docs/perf-dosql.md#what-sets-b-dosqls-limit)). Pages from the cache do not count toward that.

This is a young project. Some parts are measured and solid. Some are still being built. The pages below say which is which. Before 2026-11-13, the name of this repository was `wordpress-on-cloudflare`.

## What works today, and where it stops

- **Guest pages can come from the edge cache.** Logged-out pages often never reach PHP. In our load test, cached reads ran at about 26 to 30 requests a second per site, with a p50 near 200 ms ([evidence](docs/load-152.md), 2026-11-08). That figure is a lower bound set by the test client.
- **Built-in database WooCommerce is a light storefront.** Cart, checkout, admin, and logged-in pages run PHP every time. Under load the site can reset, and a write in flight can be lost ([#1022](https://github.com/skyphusion-labs/pagefeather/issues/1022); [limits](docs/guide/limits.md)). For a real store, use the MySQL option.
- **The MySQL option runs WordPress and a real store on Workers Paid.** It needs an external MySQL server. A first request on a cold isolate can cost 3 to 9 s more at the client ([#1169](https://github.com/skyphusion-labs/pagefeather/issues/1169)). Checkout and admin timing limits are on the [limits](docs/guide/limits.md) page.
- **How many plugins fit** is a per-request memory limit on the heaviest admin pages ([How many plugins fit](docs/guide/limits.md#how-many-plugins-fit)). You add plugins when you deploy, not from wp-admin ([plugins and themes](docs/guide/plugins-and-themes.md)).

A live example: [ggc.sh](https://ggc.sh) is a WooCommerce store on this framework. Guest storefront pages are cached at the edge. Cart, checkout, account, and logged-in pages are never cached.

## Pick a doc path

| Path | Who it is for | Start |
| --- | --- | --- |
| **WordPress / LAMP** | Install a site, log in, day-2 work, plain limits and cost | [Guide](docs/guide/README.md) |
| **Engineering** | Workers, Durable Objects, Hyperdrive, conformance, measured results, IaC | [Engineering](docs/engineering/README.md) |

The full map of every page is the [docs map](docs/README.md). Every setting for a deploy is in the [deploy reference](deploy/README.md).

## Cost (short)

- One built-in database site on Workers Paid: $5 a month ([cost](docs/guide/cost.md), read 2026-11-06).
- Many sites on Workers for Platforms: $30 a month for two or more sites (same page).
- MySQL option: Workers Paid ($5 a month) plus your MySQL server. A `MYSQL=vultr` box is $10 a month ([cost](docs/guide/cost.md#the-mysql-option-the-database-server)).

## Contributing

Contributions are welcome, from a typo fix to a newly measured cell. A failed deploy on a plan we have not tried is a useful result too. Start with [CONTRIBUTING.md](CONTRIBUTING.md). Accessibility goals and how to report a barrier: [ACCESSIBILITY.md](ACCESSIBILITY.md).

## License

GPL-2.0-or-later: the terms of the GNU General Public License version 2, or (at your option) any later version. See [LICENSE](LICENSE) for the version 2 text.

The pagefeather engine includes PHP and the Zend Engine. See [NOTICE](NOTICE) for the required acknowledgment lines and the list of linked components. The licence texts are in [engine/notices/LICENSES](engine/notices/LICENSES). Each GitHub Release that ships the engine carries `NOTICE`, `SOURCE`, and `LICENSES.tar.gz`. A version tag ships the pinned lean engine (`spikes/b2-wordpress/engine.lock`). `PHP_ENGINE=npm` builds the npm Playground engine instead. The custom engine (variant s1-lean) is a separate prerelease; its notices are `engine/notices/lean/`.
