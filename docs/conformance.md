# Conformance runs: WordPress's and WooCommerce's own test suites (#759)

The support matrix (#759) comes from running the projects' own test suites against a site on each tier. Those suites
need three upstream test plugins that no real site may carry, so a switch turns them on, and only on a throwaway.

## The switch: `CONFORMANCE=on`

`CONFORMANCE=on` loads these plugins (`spikes/b2-wordpress/conformance/`, loaded by `php/conformance.php`):

| plugin | upstream | why the suite needs it | why it is throwaway only |
|---|---|---|---|
| JSON Basic Authentication | WP-API/Basic-Auth `9e9d526` | WooCommerce's API tests send the admin's **login password** over HTTP Basic auth; stock WordPress accepts Basic auth only for application passwords | the login password works on every REST route |
| WooCommerce E2E Test Helper | woocommerce `11.2.1` | site setup sets options over REST (`e2e-options/update`) | any option can be set or deleted over REST |
| WooCommerce Cleanup | woocommerce `11.2.1` | `GET wc-cleanup/v1/reset` before a run | **it deletes every order, product, coupon, term and media file, and truncates the tax and analytics tables** |

**The files are upstream byte for byte:** `conformance/PINS` holds each file's git blob sha (upstream's at the ref)
and sha256, and `tests/conformance-pins-test.sh` checks them. To move a pin, fetch the raw file at the new ref and
update its line.

**The gate is the FAULT_INJECT rule (`deploy/conformance.sh`), checked at the entry of every deploy command before
any step:** `deploy/deploy.sh`; and for Workers for Platforms, `site add`, `site update` (each site of
`update --all` too), `site.sh up`, `up.sh` and `render_user`. It is allowed only when ALL hold:

- `CONFORMANCE` is exactly `on`;
- `THROWAWAY=1`;
- the site is named and not live: neither `deploy/live-sites/<name>.env` nor `deploy/wfp/live-sites/<name>`
  exists. ggc and ggc-test are refused.

Any variant may use it: the matrix covers every tier. It is a measurement flag (`site_settings.py` MEASUREMENT), so
it is never recorded, and the next update without it turns it off. At runtime, `index.js` defines
`SKYPHUSION_CONFORMANCE` only for the var `CONFORMANCE = "on"`. Without that constant the loader returns at once and
the plugins are never read: Basic auth with the login password answers 401, and the test routes answer 404.

## What else a run needs

The run's seed does these. This list stays until the seed script lands.

- **Pretty permalinks.** The suites call `./wp-json/...`. A fresh install keeps plain permalinks (#760), and then
  `/wp-json/` answers the home page with 200. The seed sets `/%postname%/`, as WooCommerce's own setup does.
- **A `customer` user** (password `password`, unless `CUSTOMER_PASSWORD` is given), which the login step signs in.
- **Turnstile.** The suite's login step posts `wp-login.php` with no Turnstile token, so the login gate must be off
  on the throwaway (`TURNSTILE_LOGIN=off`). The checkout and comment gates stay on with Turnstile's always-pass test
  keys.
- **WooCommerce stays at the site's version:** leave `INSTALL_WC` unset.

## Measured (local b-dosql, `wrangler dev`, WordPress 7.1.4, WooCommerce 11.2.1, 2026-11-16)

| | switch off | `CONFORMANCE=on` |
|---|---|---|
| `wc/v3/system_status`, Basic auth, the login password | 401 | **200** |
| the same, a wrong password | 401 | 500 (upstream: the plugin returns the login error, which carries no status) |
| `e2e-options/update` (blogname) | 404 | 200, applied |
| `wc-cleanup/v1/reset`, no auth | 404 | 403 |
| `wc-cleanup/v1/reset`, Basic auth | n/a | 200: 2 products and 1 tax rate become 0 and 0 |

The reset's one database error is upstream's own: `DELETE FROM wp_woocommerce_tax_classes` names a table WooCommerce
has not created since 3.7 (tax classes live in `wc_tax_rate_classes`). It fails the same way on MySQL. The reset
goes on and answers 200, and `TRUNCATE TABLE` works on our SQLite.
