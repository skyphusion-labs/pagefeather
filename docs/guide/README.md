# Guide

**New here? [Start here](start-here.md).** One page: how to install a site, how to log in, and what the limits are. The rest of this page compares the paths.

It is fine to start small and move up a path later. This page is for you if you want to run a WordPress site, or a WooCommerce site, on Cloudflare.

The short version comes first. Three paths are open. Each one names its cost and its main limit, and every figure links to the page it comes from. When you want the research behind a figure, follow that link. The whole research index is on the [engineering pages](../engineering/README.md). The full list of pages is the [docs map](../README.md).

## Which path is for you

### One site

You want one site. It can be a WordPress site, or a light WooCommerce storefront. You deploy it with `deploy/deploy.sh` on Workers Paid or on Workers Free. Set `VARIANT=b-dosql`. The manual below has the steps.

Workers Paid is $5 a month. Workers Free costs nothing, with lower limits ([Plan limits and cost](cost.md)).

On Workers Free, the shop, the cart, and checkout work. Editing a WooCommerce store in wp-admin does not fit Free's memory ([the README](../../README.md)).

One Durable Object holds the site. That is one Cloudflare object, and it keeps the site's state. Work the cache cannot answer runs at about 5 requests a second. Past that, the queue grows, and at about 100 clients the object is overloaded and refuses the request ([What sets b-dosql's limit](../perf-dosql.md#what-sets-b-dosqls-limit)).

WooCommerce on this path is a light storefront. A real store uses approach A, with Hyperdrive and your own MySQL. Under load the site's one object runs out of memory and resets, and a write in flight can be lost ([WooCommerce on b-dosql: isolates reset under load, a tracked limit (#1022)](limits.md#woocommerce-on-b-dosql-isolates-reset-under-load-a-tracked-limit-1022)).

### Many sites

You want more than one site on one account. You deploy those sites with `deploy/wfp`, on Workers for Platforms. Each site is a b-dosql site. The manual below has the steps.

A Workers for Platforms account costs $30 a month for two or more sites. That is the Workers for Platforms Paid plan at $25, plus the Workers Paid plan at $5. The price includes 20 million requests, then $0.30 per million. It includes 60 million CPU ms, then $0.02 per million. It includes 1,000 namespace scripts, then $0.02 each. Another site at rest costs about $0, up to those 1,000 scripts. Traffic costs more ([Cost of a pagefeather Workers for Platforms account](cost.md#cost-of-a-pagefeather-workers-for-platforms-account)).

Each site is still one Durable Object. Work the cache cannot answer is still about 5 requests a second per site ([What sets b-dosql's limit](../perf-dosql.md#what-sets-b-dosqls-limit)). WooCommerce on these sites is a light storefront. A real store uses approach A.

### A real store

You want a real WooCommerce store. Use approach A. PHP runs in a Worker. Your MySQL is reached through Hyperdrive. You deploy with `deploy/deploy.sh`. The variant is `a`. The manual below has the steps.

This path runs on Workers Paid, at $5 a month ([Plan limits and cost](cost.md)). You also pay for your MySQL server. A database box from `MYSQL=vultr` is $10 a month ([Cost](../../README.md#cost)). Any other MySQL server is your own bill.

This path does not run on Workers Free. The installer stops at the 10 ms CPU limit ([Plan limits](cost.md#plan-limits)).

The figure that binds a site is the write ceiling, 117 to 119 MiB of wasm ([Memory limits: the three figures](limits.md#memory-limits-the-three-figures)). On a blocks checkout, the order POST takes 9.3 to 11.8 s ([WooCommerce checkout on Hyperdrive is slow](limits.md#woocommerce-checkout-on-hyperdrive-is-slow-1218)).

## The manual for your path

- One site, with `deploy/deploy.sh`: [Start here](start-here.md), step by step; every setting is in the [full reference](../../deploy/README.md).
- Many sites, with `deploy/wfp`: [Run WordPress sites on your own Workers for Platforms account](operator.md).
- A real store, approach A: [Onboarding: from "I want a site" to a running approach-A site](onboarding.md).
- A customer's own domain: [Bring your own domain](byo-domain.md).
- If you come from a LAMP host: [From a LAMP WordPress host to Workers for Platforms](from-lamp.md).

## What does not work yet

Please read [Known limitations](limits.md) before you build. Each item says what stops, and which issue tracks it. You can plan around it, and you can follow the issue if you want to help.
