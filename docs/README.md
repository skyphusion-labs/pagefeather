# Docs

This page is the map. The repository holds a framework you run on your own Cloudflare account, and the research behind that framework. No file on this map has moved.

## Start here

- [Guide](guide/README.md). Which path is for you, what it costs, and the main limit. For a person who wants to run a site.
- [Engineering](engineering/README.md). The research pages, at their current paths. For a person who wants the measurements, the designs, and the results.

## Run a site

- [guide/start-here-mysql.md](guide/start-here-mysql.md). Start here for a real WooCommerce store: the MySQL option, step by step (pre-alpha, #1077).
- [guide/framework.md](guide/framework.md). The quickstart, the default integrations, and edge security.
- [guide/onboarding.md](guide/onboarding.md). Approach A, from a MySQL choice to a site.
- [guide/from-lamp.md](guide/from-lamp.md). A LAMP WordPress host, mapped onto this stack.
- [guide/operator.md](guide/operator.md). Day one on Workers for Platforms: scripts, updates, and teardown.
- [guide/byo-domain.md](guide/byo-domain.md). A customer's own domain.
- [guide/cost.md](guide/cost.md). Plan limits, and the monthly cost.
- [guide/limits.md](guide/limits.md). What does not work yet. The three memory figures are in [Memory limits: the three figures](guide/limits.md#memory-limits-the-three-figures).
- [support-matrix.md](support-matrix.md). Each WordPress and WooCommerce feature, per tier and per deploy path.

## Current paths

- [approach-a-overview.md](approach-a-overview.md). Approach A: the story, the write ceiling, and the database choice.
- [approach-a.md](approach-a.md). The first approach A measurements.
- [approach-a2.md](approach-a2.md). Approach A on PlanetScale.
- [approach-a-objectcache.md](approach-a-objectcache.md). The write-aware object cache, including the L2 KV tier.
- [approach-a-overflow.md](approach-a-overflow.md). The PHP overflow pool for approach A. It is off by default on `deploy/deploy.sh` since #1277.
- [admin-memory-matrix.md](admin-memory-matrix.md). Where WordPress admin runs out of memory. Measured 2026-11-14.
- [perf-dosql.md](perf-dosql.md). Where b-dosql spends its time.
- [load-152.md](load-152.md). The b-dosql ceiling under concurrent load.
- [approach-b.md](approach-b.md). The long record of WordPress on PHP-WASM. The shipped variant is b-dosql (section 8j). The D1 part of that file is the earlier record.

## Supporting pages

- [plugins.md](plugins.md). The plugin suite.
- [wfp.md](wfp.md). The Workers for Platforms spike.
- [reference-wfp.md](reference-wfp.md). A design draft from 2026-11-06 for a Workers for Platforms operator (issue #35).
- [async-email-durable-retry.md](async-email-durable-retry.md). Durable retry for outgoing email through Queues. It is opt-in.
- [vectorize-search.md](vectorize-search.md). Semantic search. It is opt-in.

## Evidence

- [results.md](results.md). Every deploy and test that backs a measured cell.
- [opcache-shm-610.md](opcache-shm-610.md). OPcache shared memory against the file-cache fallback.
- [prior-art.md](prior-art.md). Credit for the projects this work builds on.

## History

- [approach-c1.md](approach-c1.md). WooCommerce in a Container. Retired (#214).
- [approach-c-checkout.md](approach-c-checkout.md). Checkout in a Container. Retired (#214).

The code sits next to the tool: `deploy/provision`, `deploy/onboard`, `deploy/wfp`, `deploy/zone`, and `spikes/` ([spikes/README.md](../spikes/README.md)).
