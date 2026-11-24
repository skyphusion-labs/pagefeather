# Guide

**New here? [Start here](start-here.md).** One page: how to install a site, how to log in, and what the limits are.

**Plugins and themes:** you add them when you deploy, not in wp-admin. [How to add, update and remove them](plugins-and-themes.md).

This page helps you pick a path. It is for you if you want to run a WordPress site, or a WooCommerce site, on Cloudflare. The research behind the figures lives on the [engineering pages](../engineering/README.md). The full list of pages is the [docs map](../README.md).

## Which path is for you

### One site (built-in database)

You want one site. It can be a WordPress site, or a light WooCommerce storefront. Deploy with `deploy/deploy.sh` on Workers Paid or on Workers Free. Set `VARIANT=b-dosql`.

- Workers Paid is $5 a month. Workers Free costs nothing, with lower limits ([cost](cost.md)).
- On Workers Free, shop, cart, and checkout work. Editing a WooCommerce store in wp-admin does not fit Free's memory ([#638](https://github.com/skyphusion-labs/pagefeather/issues/638)).
- One site handles about 5 uncached requests a second. Cached pages do not count toward that ([evidence](../perf-dosql.md#what-sets-b-dosqls-limit)).
- WooCommerce here is a light storefront. A real store uses the MySQL option ([#1022](https://github.com/skyphusion-labs/pagefeather/issues/1022); [limits](limits.md)).

Manual: [Start here](start-here.md). Every setting is in the [deploy reference](../../deploy/README.md).

### Many sites

You want more than one site on one account. Deploy with `deploy/wfp`, on Workers for Platforms. Each site is a built-in database site.

- A Workers for Platforms account costs $30 a month for two or more sites ([cost](cost.md#cost-of-a-pagefeather-workers-for-platforms-account)).
- Each site still has the same uncached rate and WooCommerce limits as one site above.

Manual: [Operator guide](operator.md). Framework detail (SaaS zone and the provisioning Worker): [framework](framework.md).

### Provisioning Worker (HTTP)

A Worker can mint sites over HTTP (`deploy/provision/worker.mjs`). This is not the Start here path. The poke invite uses the CLI paths above.

- Code can mint `kind: wp` and `kind: a` ([#1456](https://github.com/skyphusion-labs/pagefeather/pull/1456)).
- Free single-site through this Worker: **UNBUILT** (wrong surface).
- Measured HTTP Path A after hardening: **UNBUILT** ([#1458](https://github.com/skyphusion-labs/pagefeather/issues/1458)). A Worker-made site is not the measured `deploy/wfp` site ([#328](https://github.com/skyphusion-labs/pagefeather/issues/328)).
- Hyperdrive on Free: **Fail** (CPU limit).

Manual: [Provision from a Worker](framework.md#provision-from-a-worker).

### A real store (MySQL)

You want a real WooCommerce store. Use the MySQL option (approach A). PHP runs in a Worker. Your MySQL is reached through Hyperdrive. Deploy with `deploy/deploy.sh` and `VARIANT=a`.

- Workers Paid only ($5 a month), plus a managed MySQL host ([cost](cost.md)). Prefer Azure or PlanetScale.
- This path does not run on Workers Free. The installer stops at the 10 ms CPU limit.
- Checkout and admin screens have measured timing limits ([limits](limits.md)).

Manual: [Start here: MySQL](start-here-mysql.md). More notes: [Onboarding](onboarding.md).

## Day-2 pages

- A customer's own domain: [Bring your own domain](byo-domain.md).
- Coming from a LAMP host: [From a LAMP WordPress host](from-lamp.md).
- What does not work yet: [Known limitations](limits.md). Please read it before you build.
