# Pagefeather site manager

Make WordPress sites in your own Cloudflare account, from a page that looks like WordPress admin. You do not need to run a command.

> **Status: not released yet (issues #414 and #416).** The button below works only after the first Pagefeather release. Until then, this page is for review.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/skyphusion-labs/pagefeather/tree/main/deploy/oneclick)

Everything runs in your own Cloudflare account, and Cloudflare bills you directly. Pagefeather has no service of its own and no paid plan.

## Before you click

You need these things:

1. **A Cloudflare account** and **a GitHub or GitLab account.** The button copies this code into a new repository in your GitHub or GitLab account.
2. **Workers for Platforms.** Your sites run on this Cloudflare plan. It costs $25 a month. [Open this page in Cloudflare](https://dash.cloudflare.com/?to=/:account/workers-for-platforms) and buy it. Do this first, or the button fails.
3. **A key for the site manager.** [Create the key in Cloudflare](https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_kv_storage%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_r2%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%5D&name=Pagefeather%20site%20manager). The page is filled in for you. Select **Continue to summary**, then **Create Token**. Copy the key. Cloudflare shows it only once.

## Click the button

The setup page asks for two values:

- **ADMIN_EMAIL**: your email address.
- **PAGEFEATHER_KEY**: the key from step 3.

Keep the other names as they are. Select **Create and deploy**. Wait until the deploy is done.

## Turn on sign-in protection

The site manager refuses everyone until Cloudflare checks your email when you sign in. Do these steps one time:

1. Turn on Zero Trust. [Open Zero Trust in Cloudflare](https://one.dash.cloudflare.com/). Type a team name (your business name is fine). Choose the **Free** plan. Cloudflare asks for a card, but the Free plan costs nothing.
2. In Cloudflare, go to **Workers & Pages**. Select **pagefeather**. Select **Access**, then **Protect this Worker behind Access**. Choose **All traffic**. Let in only your email address. Select **Apply Access**.
3. Open your site manager at `https://pagefeather.<your-name>.workers.dev`. Sign in with your email. Cloudflare sends you a code.

## Make your first site

1. Open **Site Health**. If **WordPress files are ready** says **To do**, select **Get WordPress files**.
2. Open **Add New Site**. Type a site name. Select **This site is a store** if you want WooCommerce.
3. Select **Add New Site**. When it is done, copy the password. It is shown only once.
4. Select **Log In**. This is your new site's own WordPress admin.

## A busy store: the Hyperdrive store (optional)

A standard store keeps everything in Cloudflare. It gets slow at checkout when more than 5 people check out at the same moment. For a store that busy, choose the **Hyperdrive store**. It keeps its data in your own MySQL 8 database, through Cloudflare Hyperdrive.

1. Make a MySQL 8 database. We recommend Azure Database for MySQL (Flexible Server), and a separate database for each store (one server can hold many databases). On Azure, set the server parameter `sql_mode` to `ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION`, and keep SSL on.
2. In Cloudflare, make a Hyperdrive configuration for the database, with caching off. Cloudflare keeps the database password. The site manager never asks for it and never sees it.
3. Give the key the **Hyperdrive Read** permission: in Cloudflare, edit the key and add **Hyperdrive Read**. The key link in step 3 above does not add it for you. **Site Health** shows when the key can read Hyperdrive.
4. In the site manager, open **Databases**. Paste the configuration's ID. Then, in **Add New Site**, select **This site is a store**, then **Hyperdrive store**, then the database.

Each Hyperdrive store keeps its tables under its own prefix (`wp_<name>_`). A separate database per store is the recommended setup. Several stores can share one database (for a host that gives you only one), each under its own prefix. If the database already holds a WordPress site under the new store's prefix, the store is not made: choose another database or site name, or remove those tables first. If adding a store fails, the site manager removes what it made in Cloudflare. It never changes your database or your Hyperdrive configuration.

## What to know

- Each site has an address like `https://wp-<name>.<your-name>.workers.dev`. Your own domain is not available yet.
- Email from your sites is off until you connect a domain.
- Each site comes with its plugins and themes. You cannot add new ones from WordPress admin yet.
- To move content from another WordPress site, open **Import** in the site manager.

## For developers

This directory is self-contained, because the button builds only this directory. `vendor/` holds byte-identical copies of the Pagefeather code the site manager runs (`deploy/provision`, `deploy/release/bundle-manifest.mjs`, `deploy/wfp/dispatcher/worker.js`). After a change to one of those files, run `deploy/oneclick/sync-vendor.sh`; `tests/button-test.mjs` fails until you do.

| File | What it is |
| --- | --- |
| `worker.mjs` | The Worker entry. It imports the site front-door code as text. |
| `admin.mjs` | The request handler: the owner check first, then the screens and the API. |
| `auth.mjs` | Who may use it: `ctx.access` from Cloudflare Access, and `ADMIN_EMAIL`. |
| `sites.mjs` | Add a site through `vendor/provision`, list sites, Site Health, and each site's front door. |
| `bundle.mjs` | Get the WordPress files from a release, checked against the pinned `manifest.json` (and, when `A_BUNDLE_MANIFEST_SHA256` is set, the Hyperdrive store files, checked against the pinned `a.manifest.json`). |
| `ui.mjs` | The screens in the wp-admin look, the CSS and the one script. |
| `scripts/ensure-namespace.mjs` | Run by `npm run deploy`: makes the `pagefeather` dispatch namespace if it is missing. |
| `wrangler.toml`, `package.json`, `.dev.vars.example` | The Worker config, the pinned Wrangler, and the two values the setup page asks for. |

Configuration: `PAGEFEATHER_KEY` and `ADMIN_EMAIL` are secrets. `CF_ACCOUNT_ID` and `ACCESS_AUD` are optional vars. `BUNDLE_VERSION` and `BUNDLE_MANIFEST_SHA256` name the WordPress release and the SHA-256 of its `manifest.json`. The key's permissions and what the code does with them are in `deploy/provision/HARDENING.md`, "The one-click site manager key".

Tests (from the repository root):

```sh
node deploy/oneclick/tests/admin-test.mjs     # the site manager, with a stub Cloudflare API
node deploy/oneclick/tests/button-test.mjs    # vendor copies, self-containment, the pin, the setup values
deploy/oneclick/tests/dryrun-test.sh          # the front-door code is bundled as text (pinned Wrangler, no account)
```

To see the screens locally, run `wrangler dev` here with `ADMIN_EMAIL` set and an `[access.dev]` block that holds a test identity. That block needs Wrangler 4.154.0 or later; the pinned 4.107.0 does not read it. Without it, every screen answers 403, as it should.
