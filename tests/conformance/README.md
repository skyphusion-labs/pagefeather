# Conformance: the upstream browser suites (#759)

These tools run the Playwright suites of WordPress, WooCommerce and Gutenberg against a THROWAWAY site. Then they compare the result with a stock upstream run. The output becomes the rows of `docs/support-matrix.md`. The inventory behind these choices is on #759.

**Never point them at a real site.** The suites delete all posts, pages and blocks. The WooCommerce cleanup plugin resets the whole store. The runner refuses a site without the throwaway marker.

## The pins (`pins.env`)

Each suite is pinned to the versions our sites run (`spikes/b2-wordpress/build.sh`), by full commit sha:

| suite | upstream | pin |
|---|---|---|
| `wp` | `wordpress-develop` `tests/e2e` | 7.1.4 (`0afb74de8c3f`) |
| `wc` | `woocommerce` `plugins/woocommerce/tests/e2e`, core profile | 11.2.1 (`67e007c3c4cc`) |
| `wc-api` | the same checkout, its `tests/api-tests` (the API half, Rollins, #785) | 11.2.1 (`67e007c3c4cc`) |
| `gb` | `gutenberg` `test/e2e` | `8daba429215e` (23.6.0-rc.1): the sha that wordpress-develop 7.1.4 names |

## The files

| file | what it does |
|---|---|
| `prepare-content.sh` | Builds the extra content of a throwaway (test plugins, test themes, the marker) from the pinned repos. It prints one line of variables for `build.sh`. |
| `themes.txt`, `plugins.txt` | The wordpress.org themes and plugins for the throwaway, checked by SHA-256 (`tests/plugins/fetch.sh`). They are separate from the product lists. |
| `php/pf-conformance-throwaway.php` | The marker mu-plugin. Its REST route says "throwaway" and names the host. |
| `exclude/<suite>.txt` | The specs NOT run, each with its reason. Each one becomes a "not run" row of the matrix. |
| `areas.txt` | The map from each spec file to a row of `docs/support-matrix.md`. The first matching line wins; a spec no line maps is reported as unmapped. |
| `gaps.py`, `php/pf-conformance-gaps.php` | Our stand-ins for upstream specs that write on the runner's disk. Today: wordpress-develop's `fatal-error-handler` (upstream's own fatal line, on `?pf_conformance=fatal`, only beside the throwaway marker). Writes `results-gaps-<on\|off>.json`; `gaps.py baseline` writes the outcome the upstream spec asserts. |
| `matrix.py` | `cells`: turns a run's `results.json` files (ours and the stock baseline, per suite) and the route runner's result into matrix cells, each with its citation. `--apply` writes them into the matrix. |
| `assert-login.mjs` | The WordPress and Gutenberg `globalSetup` step that calls `runner.py check-state`. |
| `runner.py` | `prepare`: CHECKS the site and the seed setup (it never writes), then writes `<run-dir>/env` (mode 600). `check-state`: asserts a saved login is real. `config`: writes the Playwright wrapper config. `summarize` and `compare`: the matrix rows. |
| `vps-run.sh` | Installs a suite at its pin, runs the stock baseline, and runs it on our throwaway. Run it on a Vultr VPS only. |
| `prepare-content-test.sh`, `runner_test.py` | The tests, against stub repos and a stub WordPress. No network. |

## One run, step by step

1. **The content.** Run `tests/conformance/prepare-content.sh <new dir> wp wc gb`. Keep the last line it prints.
2. **The site.** Build and deploy a throwaway with the lean engine. Put that line in front of the build. Deploy it with `TURNSTILE_LOGIN=off`. WooCommerce `auth.setup.ts` logs in with an API POST to `wp-login.php`, which carries no Turnstile token. Our login gate fails closed without one. The checkout and comment gates stay ON with Turnstile's always-pass test keys. Our own test in the matrix covers Turnstile on login.
   - For the cache-on run, keep the default page cache.
   - For the cache-off run, the site needs `PAGE_CACHE_TTL=0`. Only the c1 variant renders that setting today, and it refuses 0. Rollins is adding it to `deploy/wfp` as a recorded setting. Until then, `prepare --cache off` STOPs on a cached answer, so the pass cannot run mislabelled.
3. **Install the suite on the VPS:** `vps-run.sh install <suite> <work-dir>`.
4. **The baseline:** `vps-run.sh baseline <suite> <work-dir> <base-run>`. It runs the suite on stock upstream in Docker (wp-env), at the same pins.
5. **Check our site:** first, Rollins' seed sets the site up. It owns ALL setup, and it reruns before each suite. The seed writes `WP_USERNAME`, `WP_PASSWORD`, `CUSTOMER_USERNAME` and `CUSTOMER_PASSWORD` to `<seed out>/creds.env`, mode 600. Run `. <seed out>/creds.env`, then `runner.py prepare --suite <suite> --base-url https://<site> --cache on|off --run-dir <our-run>`.
   - It never writes to the site: one owner (the seed), one checker (the runner).
   - It STOPS if a check fails. The checks: https; the marker for this host; the deny list; the admin form login; the cache matches `--cache`.
   - For `wc`, more checks:
     - Basic is 200 with `WP_PASSWORD` and 401 with a wrong one;
     - the customer (`CUSTOMER_USERNAME`, default `customer`) exists, with the role customer and a working form login;
     - blogname;
     - pretty permalinks: `/wp-json/` must answer the REST index (#760);
     - the 3 test images, matched by stem: upstream `image-01.png` is a JPEG, so WordPress stores it as `image-01.jpg`, on stock WordPress too.
     - the active theme is `twentytwentythree`, as upstream's external setup leaves it. The wp and gb setups switch to `twentytwentyone`, so the seed resets it before each wc or wc-api pass;
     - `woocommerce_allow_tracking` is `yes` (the WooCommerce settings API). Do not deploy the throwaway with `WOO_EXTRAS=off`, which forces it off.
6. **Our run:** `vps-run.sh run <suite> <work-dir> <our-run>`. The login is ASSERTED before any test (lead ruling), because upstream auth setup never checks its response. An empty login would otherwise read as hundreds of test failures.
   - WordPress and Gutenberg: `assert-login.mjs` runs after the upstream `globalSetup`.
   - WooCommerce: the setup projects run first. Then `runner.py check-state` checks `.state/admin.json` and `.state/customer.json`. Then the tests run with `--no-deps`.
   - `check-state` sends each saved login to `/wp-admin/`. A redirect to `wp-login.php`, or the login form, STOPS the run.
   - WooCommerce's upstream `reset` project is NOT run: `woocommerce-cleanup` would wipe the seed. The seed is the reset.
7. **The rows:**
   - Run `runner.py summarize` on each `report.json`.
   - Then run `runner.py compare --baseline <base-run>/results.json --ours <our-run>/results.json`.
   - A test that fails on the baseline too is marked `upstream`. One that fails only on ours is marked `OURS`, and compare exits 1.
8. **The gap tests:** in each cache pass, after the suites, run `gaps.py run --base-url <site> --out results-gaps-<on|off>.json`. Run `gaps.py baseline --out baseline-gaps.json` once. A failing gap check is a result; a site without the marker is a stop.
9. **The matrix:** for each tier and cache pass, run `matrix.py cells`. It takes the run's identity as arguments and never reads a run's `env`.

       python3 -I tests/conformance/matrix.py cells --tier "Paid DO" --run-tag <tag> --date <YYYY-MM-DD> \
           --build <the site's /_build> --cache on \
           --suite wp=<our-run>/results.json:<base-run>/results.json --suite wc=... --suite gb=... --suite wc-api=... \
           --routes <routes.json> --apply docs/support-matrix.md --strict

   - Each cell cites the run tag, date, build and cache mode. A cell is `yes` only when a test passed and none failed only here. One that fails only here makes it `limited` (or `no`, if every test that ran did). A result that needs a look stays `not measured`.
   - A cell that already holds measured text (a citation, or a known limit such as #768's memory ceiling) is KEPT. A run never UPGRADES a cell: a passing run is appended after it as `; conformance run: ...`, so it never erases a limit it does not test.
   - A run MUST DOWNGRADE a cell. If it finds tests that fail only here (`OURS`) where the cell leads with `yes`, its `limited` (or `no`, if nothing passed) leads, naming the failing specs, and the old text follows `; before this run: `. An old `yes` never hides a regression. A later run replaces its own part, so a fixed regression lifts the downgrade.
   - The excluded specs are written as a "not run" block. `--strict` exits 1 on an unmapped spec or an `OURS` test, so a run that needs a look is never quiet.
   - **For the first shared run** (`conf759-run.md`): its exports are `results-<suite>-<on|off>.json`, `baseline-<suite>.json` and `routes-<on|off>.json`, and its throwaway `cf759a` is a `deploy/wfp` site, so the tier is `WfP`. One call per cache pass, from the pulled `conf759/<RUN_ID>/` directory:

         python3 -I tests/conformance/matrix.py cells --tier WfP --run-tag <RUN_ID> --date <the run's date> \
             --build <cf759a's /_build> --cache on \
             --suite wp=results-wp-on.json:baseline-wp.json --suite wc=results-wc-on.json:baseline-wc.json \
             --suite gb=results-gb-on.json:baseline-gb.json --suite wc-api=results-wc-api-on.json:baseline-wc-api.json \
             --suite gaps=results-gaps-on.json:baseline-gaps.json \
             --routes routes-on.json --apply docs/support-matrix.md --strict

   - Arm B's files (`*-on-b.json`, `armb-verdict.json`) do NOT go into the matrix. They are #791's acceptance check against the main arm, not a measurement of a tier.

Run each suite twice on our site, once with the cache on and once with it off. A failure that happens only with the cache on is a cache effect, not a WordPress defect.

In each cache pass, run the API half first: wc-api, then the REST route check (`routes.py`). Then run wp, wc and gb. Reseed before EACH suite. The wp and gb setups delete all posts, pages and blocks, and they change the theme. This is the order of the lead script for the shared run (`conf759-run.md`).

## Auth

The WordPress and Gutenberg suites log in through the `wp-login.php` form and a REST nonce.

The WooCommerce suite uses one `ADMIN_PASSWORD` for the form AND for HTTP Basic. So the seed creates an application password and sets the admin ACCOUNT password to that same string. The unmodified suite then passes both. No Basic-Auth plugin is used (lead ruling on #759). `prepare` checks it: the form login works, and Basic answers 200 with that value and 401 with a wrong one. No password is printed.

Basic auth on b2 needs #761 (`PHP_AUTH_USER` was never set). Until that fix merges, `prepare --suite wc` stops at the Basic check.

## What is not run yet

- The WooCommerce blocks profile (102 specs). It restores the database per test (lead ruling on #759).
- Gutenberg's collaboration specs. They need a WebSocket provider.
- The specs in `exclude/`.

## Tests

    tests/conformance/prepare-content-test.sh
    python3 -I tests/conformance/runner_test.py
    python3 -I tests/conformance/matrix_test.py
    python3 -I tests/conformance/gaps_test.py
    bash tests/conformance/gaps-php-test.sh

Each guard was checked by a mutation: with the guard removed, its own test case fails.
