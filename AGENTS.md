# Pagefeather

This file is the guide for any coding agent and any contributor. Follow it.

## What this project is

Pagefeather is a framework for WordPress and WooCommerce on Cloudflare. There are two supported paths. The product pages are [README.md](README.md) and [docs/README.md](docs/README.md).

**b-dosql.** PHP and SQLite run in one Durable Object.

- One site runs on Workers Paid or Workers Free. Deploy it with [deploy/deploy.sh](deploy/deploy.sh) and `VARIANT=b-dosql`.
- Many sites run on Workers for Platforms. Deploy them with [deploy/wfp](deploy/wfp/).

**Approach A.** PHP runs in a Worker. Your MySQL is reached through Hyperdrive. This path needs Workers Paid. Deploy it with [deploy/deploy.sh](deploy/deploy.sh) and `VARIANT=a`.

WooCommerce on b-dosql is a light storefront. A real store uses approach A ([#1022](https://github.com/skyphusion-labs/pagefeather/issues/1022)).

## Order of work

Work in this order. Fix errors first. Then make deployment easier. Then work on performance.

Conformance comes before performance. The upstream WordPress, WooCommerce, and Gutenberg test suites decide what "works" means. The run rules are in [docs/conformance.md](docs/conformance.md).

## Product truth

Do not make a test pass by softening the test. Do not make a test pass by softening the harness. Fix the engine or the install. You may exclude a case. Write the reason and the issue next to the exclusion.

## What measured means

A result is measured only after a real deploy on that plan and a test. A documentation page is not a measurement. A third-party claim is not a measurement.

Record the result in [docs/results.md](docs/results.md). Each row is one deploy and one test run. The columns are Id, Plan, Date (UTC), Wrangler, Command, and Result. Put the command, the date, the Wrangler version, and the result in that row.

A row with plan `local` ran in local workerd through `wrangler dev`. It is not a plan result. It does not change a README cell.

A failed deploy is a result. Keep the row. Do not delete a row because the deploy failed. A later row may correct an earlier row. The earlier row stays. Read the whole table.

Every plan limit names its Cloudflare documentation page and the date that page was read. The table is [docs/guide/cost.md](docs/guide/cost.md).

## Docs

State the limit next to every capability. Give the measured figure and its issue. [docs/guide/limits.md](docs/guide/limits.md) is the list of open limits.

Friendly never means selling. Say a limit in plain words. Do not turn a limit into a promise.

Write Simplified Technical English. Use short sentences. Do not use an em dash (U+2014) or an en dash (U+2013). Use a comma, a semicolon, parentheses, or two hyphens (`--`).

Do not name another project in the docs. Do not compare this project with another project in the docs. Credit prior art in [docs/prior-art.md](docs/prior-art.md).

## How to work

The pull request gate is [.github/workflows/ci.yml](.github/workflows/ci.yml); before a pull request, run every `run:` step that names a file you changed, copied from that file at your branch's head.

Always run the two quick checks, the "PHP syntax" and "Shell syntax" steps in that file.

A fix starts with a red test. Run the test command from that file. See it fail. Then fix the engine or the install. Run the same command and see it pass.

One pull request is for one issue.

The pull request flow is in [CONTRIBUTING.md](CONTRIBUTING.md). Read [Changing the base branch](CONTRIBUTING.md#changing-the-base-branch) before you change the base branch of a pull request.

## Safety

A test deploy goes to a `workers.dev` address only. Routing a zone needs a CR issue (a change request).

Do not put a secret in a tracked file. Do not put a secret in a log. Do not put a secret in a test trace. Do not put a secret in an issue. [docs/conformance.md](docs/conformance.md) says how a conformance run treats credentials and traces.

No funnel and no upsell. The reader's own Cloudflare account runs everything.

## Spike config

The spike config is [spikes/b2-wordpress/wrangler.toml](spikes/b2-wordpress/wrangler.toml).

`env.free` is the Workers Free deploy. The worker name is `wp-on-d1-spike`. The D1 database name is `wp-on-d1-spike`. The file records this env as Workers Free (measured 2026-11-03).

`env.paid` is the Workers Paid deploy. The worker name is `wp-on-d1-paid`. The D1 database name is `wp-on-d1-paid`.

[deploy/deploy.sh](deploy/deploy.sh) does not use `env.free` or `env.paid`. It builds a per-site config.

These envs are separate:

- `env.a-free`. The worker name is `wp-a-free`. It uses Hyperdrive. It has no D1 database.
- `env.a-paid`. The worker name is `wp-a-paid`. It uses Hyperdrive. It has no D1 database.
- `env.do-free`. The worker name is `wp-do-free`. The D1 database name is `wp-do-free-enam`.
- `env.dosql-free`. The worker name is `wp-dosql-free`. It has no D1 database.

The same file also has `env.a-local`, `env.a-paid-lean` (worker `wp-a-lean`), `env.a-paid-do-lean` (worker `wp-a-do-lean`), `env.do-local`, `env.a-shape-local`, and `env.dosql-local`.
