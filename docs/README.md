# Docs

This repository is two things: a **framework** you run on your own Cloudflare account, and the **research** that produced it. Start by what you want to do.

## Use the framework

Run many WordPress sites and WooCommerce stores on your own Workers for Platforms account. One command or one Worker makes each site.

- [framework.md](framework.md) the quickstart: the site kind (b-dosql, for blogs and stores), the one provisioning surface, and how to provision from a Worker.
- [from-lamp-to-wfp.md](from-lamp-to-wfp.md) coming from a traditional LAMP WordPress host: your stack mapped one to one onto this one.
- [operator.md](operator.md) the day-one walkthrough for running a couple of sites: scripts, Terraform, update and rollback, custom hostnames, teardown.
- [reference-wfp.md](reference-wfp.md) the reference-deployment design for a Workers for Platforms operator (issue #35): the shape, each claim with its source.

## The research behind it

How each way of running WordPress on Cloudflare was built and measured. The top-level [README](../README.md) is the matrix these produced.

- [approach-a.md](approach-a.md) and [approach-a2.md](approach-a2.md) a Worker in front of WordPress with its database reached over a bridge (MySQL, then Hyperdrive).
- [approach-b.md](approach-b.md) WordPress as PHP compiled to WebAssembly in a Worker, database in D1. No server.
- [approach-c-checkout.md](approach-c-checkout.md) and [approach-c1.md](approach-c1.md) WordPress and WooCommerce in a Cloudflare Container. **Retired (#214), kept as a record:** b-dosql now does checkout directly, so a store needs no container.
- [perf-dosql.md](perf-dosql.md) tuning b-dosql (PHP and SQLite in one Durable Object). This is the variant the framework runs for blogs and stores.
- [load-152.md](load-152.md) the measured b-dosql ceiling under concurrent multi-site load (issue #152): cached reads scale, the single object limits uncached reads and checkout, and when to move to a VPS or Approach A.
- [plugins.md](plugins.md) a standard plugin suite run against each setup.
- [wfp.md](wfp.md) the Workers for Platforms spike: dispatch Worker, one user Worker per site, per-tenant limits.

## Evidence

- [results.md](results.md) every deploy and test run that backs a measured cell, with the command, date and Wrangler version.
- [prior-art.md](prior-art.md) the projects this builds on, credited.

The code: `deploy/provision` (the Worker-provisionable core), `deploy/wfp` (the Workers for Platforms reference deployment), `spikes/` (the research prototypes, see [spikes/README.md](../spikes/README.md)).
