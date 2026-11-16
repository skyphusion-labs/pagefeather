# Conformance: the upstream browser suites (#759)

These tools run the Playwright suites of WordPress, WooCommerce and Gutenberg against a THROWAWAY site, then compare the result with a stock upstream run. The output becomes the rows of `docs/support-matrix.md`. The inventory behind these choices is on #759.

**Never point them at a real site.** The suites delete all posts, pages and blocks, and the WooCommerce cleanup plugin resets the whole store. The runner refuses a site without the throwaway marker.

## The pins (`pins.env`)

Each suite is pinned to the versions our sites run (`spikes/b2-wordpress/build.sh`), by full commit sha:

| suite | upstream | pin |
|---|---|---|
| `wp` | `wordpress-develop` `tests/e2e` | 7.1.4 (`0afb74de8c3f`) |
| `wc` | `woocommerce` `plugins/woocommerce/tests/e2e`, core profile | 11.2.1 (`67e007c3c4cc`) |
| `gb` | `gutenberg` `test/e2e` | `8daba429215e` (23.6.0-rc.1): the sha that wordpress-develop 7.1.4 names |

## The files

| file | what it does |
|---|---|
| `prepare-content.sh` | Builds the extra content of a throwaway (test plugins, test themes, the marker) from the pinned repos. It prints one line of variables for `build.sh`. |
| `themes.txt`, `plugins.txt` | The wordpress.org themes and plugins for the throwaway, checked by SHA-256 (`tests/plugins/fetch.sh`). They are separate from the product lists. |
| `php/pf-conformance-throwaway.php` | The marker mu-plugin. Its REST route says "throwaway" and names the host. |
| `exclude/<suite>.txt` | The specs NOT run, each with its reason. Each one becomes a "not run" row of the matrix. |
| `runner.py` | `prepare`: checks the site, sets it up, writes `<run-dir>/env` (mode 600). `config`: writes the Playwright wrapper config. `summarize` and `compare`: the matrix rows. |
| `vps-run.sh` | Installs a suite at its pin, runs the stock baseline, and runs it on our throwaway. Run it on a Vultr VPS only. |
| `prepare-content-test.sh`, `runner_test.py` | The tests, against stub repos and a stub WordPress. No network. |

## One run, step by step

1. **The content.** Run `tests/conformance/prepare-content.sh <new dir> wp wc gb`. Keep the last line it prints.
2. **The site.** Build and deploy a throwaway with the lean engine. Put that line in front of the build. Turnstile must be OFF.
   - For the cache-on run, keep the default page cache.
   - For the cache-off run, deploy with `PAGE_CACHE_TTL=0`.
3. **Install the suite on the VPS:** `vps-run.sh install <suite> <work-dir>`.
4. **The baseline:** `vps-run.sh baseline <suite> <work-dir> <base-run>`. It runs the suite on stock upstream in Docker (wp-env), at the same pins.
5. **Prepare our site:** `WP_PASSWORD=<admin password> runner.py prepare --suite <suite> --base-url https://<site> --cache on|off --run-dir <our-run> --suite-dir <the suite e2e dir>`.
   - It STOPS before any change if a check fails. The checks: https; the marker for this host; the deny list; the form login; the cache matches `--cache`.
   - For `wc`, two more checks: HTTP Basic is 200 with the right password and 401 with a wrong one.
6. **Our run:** `vps-run.sh run <suite> <work-dir> <our-run>`.
7. **The rows:**
   - Run `runner.py summarize` on each `report.json`.
   - Then run `runner.py compare --baseline <base-run>/results.json --ours <our-run>/results.json`.
   - A test that fails on the baseline too is marked `upstream`. One that fails only on ours is marked `OURS`, and compare exits 1.

Run each suite twice on our site, once with the cache on and once with it off. A failure that happens only with the cache on is a cache effect, not a WordPress defect.

## Auth

The WordPress and Gutenberg suites log in through the `wp-login.php` form and a REST nonce.

The WooCommerce suite uses one `ADMIN_PASSWORD` for the form AND for HTTP Basic. So `prepare` does three things:

1. It creates an application password and checks Basic with it.
2. It sets the admin account password to that same string.
3. It writes it to `env`.

No Basic-Auth plugin is needed. A password is never printed.

On b2, Basic auth needs #761 (`PHP_AUTH_USER` is never set). Until #761 is fixed, `prepare --suite wc` stops at the Basic check. It stops before it changes the admin password.

## What is not run yet

- The WooCommerce blocks profile (102 specs). It restores the database per test (lead ruling on #759).
- Gutenberg's collaboration specs. They need a WebSocket provider.
- The specs in `exclude/`.

## Tests

    tests/conformance/prepare-content-test.sh
    python3 -I tests/conformance/runner_test.py

Each guard was checked by a mutation: with the guard removed, its own test case fails.
