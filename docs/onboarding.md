# Onboarding: from "I want a site" to a running approach-A site

**Status: flow design. The exact commands are pending.** Two pieces are being built in parallel, and this page does not copy their syntax until their pull requests merge. Every place that needs a command is marked `TODO(commands)`.

This page is for a person who wants to run WordPress or WooCommerce sites on their own Cloudflare account, on the scalable path ([approach A](approach-a-overview.md)). If you want zero outside infrastructure instead, use the b-dosql kind in [framework.md](framework.md); it needs no onboarding step.

## The idea in one paragraph

Approach A needs a MySQL database. You choose where it lives. An onboarding step takes that choice and makes one Hyperdrive configuration for it. After that, you can make as many type-a sites as you want, and each one uses that configuration. You do the provider choice once; you make each site with one command.

## The flow

```
1. Choose a MySQL provider
        |
2. Onboarding: set up the Hyperdrive configuration for that provider
        |
3. Add a site of type "a" against that configuration   (repeat for each site)
        |
4. Check the site, then use it
```

### Step 1: choose a MySQL provider

You pick one. The choice table, with measured speed and cost, is in [approach-a-overview.md](approach-a-overview.md#choose-a-database-provider). In short:

| Choice | Pick it when |
| --- | --- |
| PlanetScale, billed through Cloudflare | You want one Cloudflare bill and the least to manage. |
| Azure Database for MySQL | You want the fastest measured checkout and have an Azure account or credit. |
| A VPS you run (MariaDB or MySQL) | You want the lowest cost and can look after a server. |
| An existing MySQL you already have | You have a database and want to reuse it. |

Before step 2, have these ready:

- A Cloudflare account on **Workers Paid** (our approach-A build does not run on Free).
- A Cloudflare API token that can edit Hyperdrive and Workers.
- For the provider you chose: its host name, a database name, a user and a password. A public server needs SSL. A server behind a Cloudflare Tunnel needs the Access service token instead.
- The database region, so the Worker can be placed next to it.

### Step 2: set up the Hyperdrive configuration

The onboarding step reads your provider choice and makes the Hyperdrive configuration. It does the parts that are easy to get wrong:

- It uses the database **host name**, not the IP address. By IP, every query measured about 6 times slower.
- It turns the Hyperdrive **query cache off**. The default cache serves stale WordPress reads.
- It sets the right `sql_mode` handling for a strict provider (PlanetScale, Azure MySQL 8.0). See [approach-a2.md](approach-a2.md).
- For PlanetScale it uses the direct host, not the optimized host.
- It places the Worker in the region of the database.

Output of this step: the name or id of one Hyperdrive configuration. Step 3 takes it as input.

`TODO(commands)`: the exact command and flags for the provider-to-Hyperdrive step. Pending Strummer's PR. Do not write the syntax here until that PR merges; link the PR and copy the final help text.

### Step 3: add a type-a site

A type-a site is a user Worker that runs WordPress and talks to the database through the Hyperdrive configuration from step 2. In the tests, each site used its own table prefix in a shared database; confirm how the final command handles this.

`TODO(commands)`: the exact command for `site add --kind a` and its flags (site name, domain, which Hyperdrive configuration to use). Pending Rollins's PR. Link the PR here when it merges.

Compare with the b-dosql kind, which is `add --kind wp` in [framework.md](framework.md).

### Step 4: check the site

After a site is added:

- The home page answers 200.
- The install ran: a user exists and the tables are in the database (the check `/_install` reports `installed: true` with `user_id: 1`; on a strict server a bad `sql_mode` shows `user_id: 0`).
- For a store, turn on WooCommerce in wp-admin, as on any WordPress host, and run a test checkout.

`TODO(commands)`: the exact check command, if the new CLI adds one.

## What can go wrong

| Symptom | Likely cause | Where it is explained |
| --- | --- | --- |
| Every query is slow (40 ms or more) | Hyperdrive was given an IP address, not a host name | [approach-a.md](approach-a.md) |
| "DNS lookup failed" just after you made the record | The new DNS record is not ready yet; wait a few minutes | [approach-a.md](approach-a.md) |
| Port 3306 is closed though the firewall rule exists | The server's own firewall (for example `ufw`) | [approach-a.md](approach-a.md) |
| Install says `installed` but there is no user | A strict `sql_mode` on the server | [approach-a2.md](approach-a2.md) |
| Edits show late or old data appears | The Hyperdrive query cache is on | [approach-a2.md](approach-a2.md) |
| First install or WooCommerce activation fails once on PlanetScale | Schema lag across pooled connections; run it again | [approach-a-overview.md](approach-a-overview.md) |

## Not in scope here

- Billing or a sign-up flow. This repository has no funnel; your own Cloudflare account runs everything (see the root `CLAUDE.md`).
- Moving a site between kinds. See `deploy/import/README.md` for importing a dump.

## Status of this page

Update this page when the two pull requests merge: replace each `TODO(commands)` with the real command, and link the PRs. Until then, treat the flow as the design and the commands as unknown.
