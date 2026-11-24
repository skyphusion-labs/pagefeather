# Onboarding: from "I want a site" to a running site on the MySQL option

**Status: current.** Both pieces have merged: the onboarding step (PR #242) and `site add --kind a` (PR #243). The commands below are the real ones.

This page is for you if you want to run WordPress or WooCommerce sites on your own Cloudflare account, on the path that scales out: the MySQL option ([evidence and design](../approach-a-overview.md)). If you would rather have zero outside infrastructure, the b-dosql kind in [framework.md](framework.md) is simpler; it needs no onboarding step.

**Names on this page.** The MySQL option is approach A in the engineering docs (PHP in a Worker, MySQL through Hyperdrive), and a site of that kind is `--kind a`. The built-in database option is `b-dosql`.

**One store, with `deploy/deploy.sh`?** [Start here: the MySQL option](start-here-mysql.md) has the steps. This page is for many sites on Workers for Platforms.

**Plugins and themes:** you add them when you deploy, not in wp-admin. [How to add, update and remove them](plugins-and-themes.md).

## The idea in one paragraph

Approach A needs a MySQL database, and you choose where it lives. An onboarding step takes that choice and makes one Hyperdrive configuration for it. After that, you can make as many type-a sites as you want, and each one uses that configuration. So you make the provider choice once, and then each site is one command.

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

Pick the one that suits you. The short table below is enough to choose. The full table, with measured speed and cost, is the [evidence](../approach-a-overview.md#choose-a-database-provider).

| Choice | Pick it when |
| --- | --- |
| PlanetScale, billed through Cloudflare | You want one Cloudflare bill and the least to manage. |
| Azure Database for MySQL | You want the fastest measured checkout and have an Azure account or credit. |
| An existing managed MySQL you already have | You already run Azure, PlanetScale, or another managed host. |

Do not stand up a VPS only to host MySQL for approach A. Prefer a managed host.

Before step 2, have these ready:

- A Cloudflare account on **Workers Paid** (our approach-A build does not run on Free).
- A Cloudflare API token that can edit Hyperdrive and Workers.
- For the provider you chose: its host name, a database name, a user and a password. A public server needs SSL. A server behind a Cloudflare Tunnel needs the Access service token instead.
- The database region, so the Worker can be placed next to it.

### Step 2: set up the Hyperdrive configuration

The onboarding step reads your provider choice and makes the Hyperdrive configuration. It exists because a few settings are easy to get wrong by hand, and each one costs you speed or correct data. It handles them for you:

- It uses the database **host name**, not the IP address. By IP, every query measured about 6 times slower.
- It turns the Hyperdrive **query cache off**. The default cache serves stale WordPress reads.
- It sets the right `sql_mode` handling for a strict provider (PlanetScale, Azure MySQL 8.0). See the [details](../approach-a2.md).
- For PlanetScale it uses the direct host, not the optimized host.
- It places the Worker in the region of the database.

Output of this step: the id of one Hyperdrive configuration, plus the `SQL_MODE` the provider needs. Step 3 takes both as input.

Set your Cloudflare account id and an API token that can edit Hyperdrive, then run the onboarding step for your provider. `<provider>` is one of `azure`, `planetscale`, or `external`:

```sh
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
node deploy/onboard/onboard.mjs <provider> --name wpref-db --out onboard.env
```

It prints a JSON summary and writes `onboard.env` (mode 0600), which holds `HYPERDRIVE_ID` and `SQL_MODE` (the file carries no secret, only the config id and the mode string). `SQL_MODE` is set for PlanetScale only, whose Vitess engine is strict. Azure is relaxed at the server during onboarding, so its `SQL_MODE` stays empty, as it does for the other providers. Add `--dry-run` to print the plan without creating anything. See [deploy/onboard/onboard.mjs](../../deploy/onboard/onboard.mjs) (PR #242).

### Step 3: add a type-a site

A type-a site is a user Worker that runs WordPress and talks to the database through the Hyperdrive configuration from step 2. In the tests, each site used its own table prefix in a shared database.

Source the file from step 2 and add the site. Pass the Hyperdrive id, and the SQL mode for a strict provider. A type-a site is made by the provisioning core, which needs a SaaS zone: without `WFP_SAAS_ZONE_ID` the CLI refuses the site, because nothing would route to it (#294). `deploy/wfp/site` makes b-dosql sites only.

```sh
source onboard.env   # HYPERDRIVE_ID, SQL_MODE
export WFP_SAAS_ZONE_ID=<the SaaS zone id> WP_HOSTNAME=myshop.<your SaaS zone>
node deploy/provision/cli.mjs add --kind a myshop \
  --hyperdrive "$HYPERDRIVE_ID" --hyperdrive-sql-mode "$SQL_MODE" --placement azure:westus2
```

`--hyperdrive` is required for `--kind a` (it is the config id from onboarding). `--placement` is required too (#1063): the database's region as `<aws|gcp|azure>:<region>`, for example `azure:westus2`, so the Worker runs next to its database. Measured on #1054, a Worker across the country from its database was 2 to 5 times slower. `--placement none` places none, on purpose. `--hyperdrive-sql-mode` is only needed for a strict provider; leave it off when `SQL_MODE` is empty. There is no SQLite migration step: the database lives in your provider, not in a Durable Object. See [deploy/provision/cli.mjs](../../deploy/provision/cli.mjs) (PR #243).

Compare with the b-dosql kind, which is `site add --kind wp` in [framework.md](framework.md).

### Step 4: check the site

After a site is added:

- The home page answers 200.
- The install ran: a user exists and the tables are in the database (the check `/_install` reports `installed: true` with `user_id: 1`; on a strict server a bad `sql_mode` shows `user_id: 0`).
- For a store, turn on WooCommerce in wp-admin, as on any WordPress host, and run a test checkout.

`site add` reports the deployed Worker URL. Check the site by hand: `curl -sI https://<worker>.workers.dev/` for a 200, and open `/_install` to confirm `installed: true` with `user_id: 1`.

## If something goes wrong

| What you see | Likely cause | Where it is explained |
| --- | --- | --- |
| Every query is slow (40 ms or more) | Hyperdrive was given an IP address, not a host name | [details](../approach-a.md) |
| "DNS lookup failed" just after you made the record | The new DNS record is not ready yet; wait a few minutes | [details](../approach-a.md) |
| Port 3306 is closed though the firewall rule exists | The server's own firewall (for example `ufw`) | [details](../approach-a.md) |
| Install says `installed` but there is no user | A strict `sql_mode` on the server | [details](../approach-a2.md) |
| Edits show late or old data appears | The Hyperdrive query cache is on | [details](../approach-a2.md) |
| First install or WooCommerce activation fails once on PlanetScale | Schema lag across pooled connections; run it again | [details](../approach-a-overview.md) |

## What this page does not cover

- Billing or a sign-up flow. This repository has no funnel; your own Cloudflare account runs everything (see the root `CLAUDE.md`).
- Moving a site between kinds. See `deploy/import/README.md` for importing a dump.

## Status of this page

Current as of the merge of PR #242 (onboarding) and PR #243 (`site add --kind a`). The commands above are the real ones. If a flag changes, update this page from the two files it links.
