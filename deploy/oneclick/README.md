# deploy/oneclick: the site manager (issue #414)

**Status: built and tested locally (unit tests and `wrangler dev`). Not deployed.** It is the "Add a site" half of the one-click path ([design](../../docs/design-401-one-click.md), issue #401). The Deploy to Cloudflare button is the next piece.

The site manager is a small Worker in the owner's own Cloudflare account. It looks like wp-admin. It makes WordPress sites through `deploy/provision` (the same `buildServerCfg` and `provisionSite` the operator path uses). Each site gets an address `https://wp-<name>.<your-subdomain>.workers.dev`.

## Screens

| Screen | What it does |
| --- | --- |
| Sites (`/`) | Lists the sites in the site map, with Log In and Visit. |
| Add New Site (`/add`) | A site name and "This site is a store". It warns about a bad or reserved name (for example `shop`) before you submit. It shows the username and the password once. |
| Import (`/import`) | How to move content with the WordPress importer. |
| Site Health (`/health`) | Checks the key, Workers for Platforms, the `workers.dev` name and the WordPress files. "Get WordPress files" downloads the pinned release (#405). |

## Who can open it

Only the owner, signed in through Cloudflare Access. The Worker reads `ctx.access`, which Cloudflare sets only when Access signed the request in. A request header cannot fake it. The signed-in email must equal `ADMIN_EMAIL`. Without `ADMIN_EMAIL`, nobody gets in. See `auth.mjs` and `deploy/provision/HARDENING.md`, "The one-click site manager key".

## Configuration

| Name | Kind | What it is |
| --- | --- | --- |
| `PAGEFEATHER_KEY` | secret | The account API token. Permissions: `deploy/provision/HARDENING.md`. |
| `ADMIN_EMAIL` | var | The owner's email. Required. |
| `CF_ACCOUNT_ID` | var, optional | Without it, the manager uses the one account the key reaches. |
| `ACCESS_AUD` | var, optional | The Access application audience; when set, it must match. |
| `BUNDLE_VERSION`, `BUNDLE_MANIFEST_SHA256` | vars | The WordPress release and the SHA-256 of its `manifest.json`. Empty until the first release. |
| `BUNDLES` | R2 | The WordPress files, under `bundles/b-dosql/<version>/`. |
| `DISPATCHER` | dispatch namespace | The sites (`pagefeather`). Install and WooCommerce go through it. |

## Test

```sh
node deploy/oneclick/tests/admin-test.mjs
```

The test runs offline with a stub Cloudflare API. To see the screens, run `wrangler dev` in this directory with `ADMIN_EMAIL` set and an `[access.dev]` block that holds a test identity. That block needs Wrangler 4.154.0 or later; the repo pin (`deploy/tools`, 4.107.0) does not read it, and without it every screen answers 403, as it should.

## Files

- `worker.mjs`: the Worker entry. It imports the front-door code (`deploy/wfp/dispatcher/worker.js`) as text.
- `admin.mjs`: the request handler. It checks the owner first, then routes the request.
- `auth.mjs`: the owner check and the same-page write check.
- `sites.mjs`: add a site, list sites, Site Health, and each site's front door.
- `bundle.mjs`: get the WordPress files from a release, checked against the pinned manifest.
- `ui.mjs`: the screens, the CSS and the one script. No library and no build step.
