# Docs

This page is the map. The repository holds a framework you run on your own Cloudflare account, and the research behind that framework.

## Two paths

| Path | Who it is for | Landing page |
| --- | --- | --- |
| **WordPress / LAMP** | Install a site, log in, day-2 work, plain limits and cost | [Guide](guide/README.md) |
| **Engineering** | Workers, Durable Objects, Hyperdrive, conformance, measured results, IaC | [Engineering](engineering/README.md) |

Friendly never means selling. Each capability states its limit next to it. Measured figures link to [results.md](results.md) or the evidence page they came from.

## WordPress / LAMP (easy path)

- [guide/start-here.md](guide/start-here.md). Install one site with the built-in database, log in, and know the limits.
- [guide/start-here-mysql.md](guide/start-here-mysql.md). The MySQL option for a real WooCommerce store (pre-alpha, #1077).
- [guide/from-lamp.md](guide/from-lamp.md). A LAMP WordPress host, mapped onto this stack.
- [guide/plugins-and-themes.md](guide/plugins-and-themes.md). How to add, update, and remove plugins and themes.
- [guide/operator.md](guide/operator.md). Day one on Workers for Platforms: scripts, updates, and teardown.
- [guide/byo-domain.md](guide/byo-domain.md). A customer's own domain.
- [guide/onboarding.md](guide/onboarding.md). Approach A notes, from a MySQL choice to a site.
- [guide/framework.md](guide/framework.md). The multi-tenant framework overview.
- [guide/cost.md](guide/cost.md). Plan limits, and the monthly cost.
- [guide/limits.md](guide/limits.md). What does not work yet.
- [support-matrix.md](support-matrix.md). Each WordPress and WooCommerce feature, per tier and per deploy path.

## Engineering path

The [engineering landing](engineering/README.md) indexes research, measurements, designs, results, and history. The pages stay at their current paths under `docs/`. Old paths that moved into `guide/` keep stubs at the old location.

Short pointers:

- [results.md](results.md). Every deploy and test that backs a measured cell.
- [conformance.md](conformance.md). How the WordPress and WooCommerce suites are run.
- [prior-art.md](prior-art.md). Credit for the projects this work builds on.
- [limits-engineering.md](limits-engineering.md). Limits for an engineer or operator only.

The code sits next to the tool: `deploy/provision`, `deploy/onboard`, `deploy/wfp`, `deploy/zone`, and `spikes/` ([spikes/README.md](../spikes/README.md)).
