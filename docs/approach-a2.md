# Variant a2: approach A on PlanetScale MySQL through Hyperdrive

Issue #50. The Worker and the drop-in of variant `a` (`index-a.js`, `mysql-bridge.js`, `php/hyperdrive-db.php`), with the database on PlanetScale (Vitess MySQL) instead of the MariaDB box on Vultr. The question is the time per query: `a` on Vultr measured 7 to 10 ms.

**Label: Cloudflare-provisioned, data on PlanetScale (AWS).** The bytes are not on Cloudflare.

## The database

- PlanetScale database `wp-on-cf-a2`: Vitess MySQL, plan PS-10, AWS `us-east-2` (Ohio), branch `main`. Made 2026-11-06T00:09Z with `pscale database create ... --cloudflare-billing` and the Cloudflare signature (`POST /accounts/{id}/hyperdrive/integrationsOperations/planetScale/createDatabaseSignature`). Conrad approved the spend: $39 a month (PS-10).
- **Billing:** the billing account is not verified yet (#50, "Verify first" item 3).
- The server reports `VERSION()` = `8.4.11-Vitess`.
- Hyperdrive config: made by our Terraform (`deploy/terraform`, caching off), not by the integration.

## How it was measured

`tests/a2/` is a probe: a Worker placed like wp-a2, with the same driver settings as `mysql-bridge.js` (mysql2, one connection per Worker request), and two Hyperdrive configs to the same database that differ only in the host (`tests/a2/terraform`, caching off). The result files are in `tests/a2/results/`. Every figure below is from those files.

## Result 1: time per query depends on the PlanetScale host

PlanetScale has two kinds of host name ([PlanetScale: network latency](https://planetscale.com/docs/vitess/connecting/network-latency), read 2026-11-06):

- `aws.connect.psdb.cloud`: the **optimized** host. Route 53 latency routing to the nearest PlanetScale edge, then PlanetScale's network to the database.
- `aws-us-east-2.connect.psdb.cloud`: the **direct** host in the database's region.

Hyperdrive puts its connection pool "in one or more regions closest to your origin database" ([How Hyperdrive works](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/)). Cloudflare's placement probes "do not work correctly for broadcast, anycast, multicast, or replicated resources" ([Placement](https://developers.cloudflare.com/workers/configuration/placement/)). The optimized host is that kind of resource.

Median ms per statement (`SELECT` of a constant), 50 statements per run, after one warm-up statement. Workers' clock moves only on I/O, in whole ms.

| Run (UTC, 2026-11-06) | Placement | Worker ran in | Optimized host | Direct host |
| --- | --- | --- | --- | --- |
| 00:26 (`probe-20261106T002616Z.json`) | region `aws:us-east-2` | ORD | 43, 45, 42 | 16, 15, 17 |
| 00:32 (`probe-20261106T003249Z.json`) | host `aws-us-east-2.connect.psdb.cloud:3306` | ORD | 43, 41, 45 | 16, 20, 15 |

- **The optimized host costs about 27 ms per query.** Use the direct host with Hyperdrive.
- **About 16 ms per query from ORD is the floor we measured** with the direct host. Both placement modes ran the Worker in ORD (the same as for `a`); the database is in Ohio. `a` on Vultr (box in Chicago) measured 7 to 10 ms.
- Opening a connection took 1 to 4 ms (Hyperdrive sets it up near the Worker).

## Result 2: PlanetScale is strict, and a session sql_mode does not hold through Hyperdrive

The first wp-a2 install failed: `Invalid default value for 'scheduled_date_gmt' (errno 1067)`, and the tables `wp_posts`, `wp_users`, `wp_comments`, `wp_links` and `wp_actionscheduler_actions` were not made. WordPress uses `DEFAULT '0000-00-00 00:00:00'` and zero-date values (the `post_date_gmt` of a draft). Stock `wpdb` relaxes `sql_mode` once per connection (`set_sql_mode()`). Our drop-in made that a no-op, because Hyperdrive pools connections.

**Finding: `SELECT @@SESSION.sql_mode` and `SELECT @@GLOBAL.sql_mode` return zero rows** through Hyperdrive and Vitess (`probe-20261106T003222Z.json`); `VERSION()` and `CONNECTION_ID()` answer. So the mode cannot be read back. The probe judges every case by **effect**: does a statement that strict mode refuses run? (`probe-20261106T003532Z.json`; relaxed mode tried: `ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION`.)

| Test | Result |
| --- | --- |
| Baseline, no change: zero-date `DEFAULT` in `CREATE TABLE` | refused, errno 1067 |
| Baseline: zero-date value in `INSERT` | refused, errno 1292 |
| Baseline: `GROUP BY` of a column not in the select list | refused, errno 1055 |
| `SET SESSION sql_mode`, then on the same client connection: the DDL, 5 `INSERT`s, the `GROUP BY` | **all refused** (1067, 1292 five times, 1055) |
| A second client connection after another client's `SET` | refused (1292): **no leak** between clients |
| `BEGIN`, `SET SESSION sql_mode`, `INSERT` zero date, `COMMIT` | ran |
| `BEGIN`, `SET SESSION sql_mode`, the zero-default `CREATE TABLE`, `COMMIT` | ran |
| `SET_VAR(sql_mode=...)` hint on `INSERT`, `UPDATE`, `SELECT ... GROUP BY`, `DELETE` | **all ran**: the hint goes through Vitess to MySQL |
| `datetime NOT NULL` with no `DEFAULT`, then an `INSERT` that leaves it out: plain / with the hint | 1364 / ran, value `0000-00-00 00:00:00` |

So, through Hyperdrive and Vitess, a `SET` does not hold from one statement to the next unless the statements are in one transaction. The probe cannot tell which of the two resets it. MySQL 8.0 documents that `sql_mode` accepts `SET_VAR` ("SET_VAR Hint Applies: Yes") and that hints are read only after the first keyword of `SELECT`, `UPDATE`, `INSERT`, `REPLACE` and `DELETE` ([optimizer hints](https://dev.mysql.com/doc/refman/8.0/en/optimizer-hints.html), [sql_mode](https://dev.mysql.com/doc/refman/8.0/en/server-system-variables.html#sysvar_sql_mode), read 2026-11-06). PlanetScale: "The global SQL mode can not be changed permanently" ([MySQL compatibility](https://planetscale.com/docs/vitess/troubleshooting/mysql-compatibility)).

## The design

`spikes/b2-wordpress/php/hyperdrive-sql-mode.php`, used by `hyperdrive-db.php`, on only when `HYPERDRIVE_SQL_MODE` is set:

- **`SELECT`, `INSERT`, `UPDATE`, `REPLACE`, `DELETE`:** the drop-in puts `/*+ SET_VAR(sql_mode='<mode>') */` right after the first keyword (after any leading space and comments; merged into an existing hint comment). No extra round trip. That matters: a round trip is about 16 ms here.
- **`CREATE` and `ALTER`:** `BEGIN`, `SET SESSION sql_mode = '<mode>'`, the statement, `COMMIT`. Three extra round trips, only for DDL (install, plugin activation, upgrades). The DDL text is not changed. `COMMIT` is sent whenever `BEGIN` ran, also when the DDL fails.
- WordPress's own query text stays in `last_query`, and one logical query counts once.
- **Not hinted:** a statement that starts with `(` (a `UNION` of parenthesized `SELECT`s) or `WITH`, because there the first `SELECT` is inside, where MySQL ignores `SET_VAR`. If such a query uses a zero date or a strict `GROUP BY`, it fails on PlanetScale. Record any such failure as a result.
- How it is set: `deploy.sh` `VARIANT=a HYPERDRIVE_SQL_MODE=...` writes a Worker var; the Worker writes it into `wp-runtime.php` as the PHP constant `HYPERDRIVE_SQL_MODE` (as it does for `WP_HOME`). Only mode names and commas are accepted. Unset, nothing changes: variant `a` on MariaDB is not affected.

Tests: `php tests/a2/sql-mode-test.php off|on|bad|const` (44 checks, with a fake Worker call; no database). Two mutations were run: without the `COMMIT` after a failed DDL, and without the skip of leading comments. Each made the matching checks fail.

## The site: wp-a2 with the fix

Deployed by the lead on 2026-11-06 from `6b1f1b5` on an empty database (all 38 tables of the first, failed install dropped first): `deploy.sh` `VARIANT=a MYSQL=external MYSQL_HOST=aws-us-east-2.connect.psdb.cloud PLACEMENT=aws:us-east-2 WOO_ACTIVE=1 HYPERDRIVE_SQL_MODE=ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION`. Result file: `deploy/results/wp-a2-20261106T004741Z.json`.

| Check | Result |
| --- | --- |
| Install | `installed`, user 1, 28.3 s |
| WooCommerce activation | active. One error during activation: a read of `wp_woocommerce_attribute_taxonomies` before activation made the table. The same error happens on `a` on Vultr. It is harmless: after activation, `GET /wc/v3/products/attributes` answers 200 (`[]`), so the table exists. |
| `/_d1ping` (per statement, from the Worker) | 20, 19, 16 ms |
| `e2e.sh` | 17 of 17 |
| `tests/woo.py` (setup, guest cart, cash on delivery checkout, order, stock) | **12 of 12** (`tests/a2/results/woo-wp-a2.txt`) |
| `tests/cache_check.py` (a price change, stock to 0 and a tagline change show on every next read) | **13 of 13** (`tests/a2/results/cache-check-wp-a2.txt`) |

Page times from the laptop (n=10, medians; not comparable with the runner): home 3.35 s (76 queries), post 3.15 s, search 2.94 s, dashboard 5.29 s (138), post-new 8.29 s (172), edit 6.55 s. At about 16 to 20 ms per query, a page of 76 to 172 queries spends 1.2 to 3.4 s in the database alone.

**Query cache.** Our Hyperdrive config has caching **off** (`deploy/terraform`, `caching = { disabled = true }`), so `cache_check.py` passing shows the site is correct as deployed. Hyperdrive's default is caching **on**: "Query caching is enabled by default", with `max_age` 60 s ([Query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/), read 2026-11-06), and "Hyperdrive does not purge or invalidate cached read query results when your application writes to your database." The PlanetScale integration's pages do not say which setting its own config uses. So a config made with the default (for example by the integration) would cache WordPress's reads for up to 60 s after a write. We did not deploy wp-a2 with caching on; keep it off for WordPress.

**In short:** Hyperdrive's default query cache (60 s, not invalidated on writes) serves stale WordPress reads; the deploy turns it off; check the integration's auto-created config before using it.

## Under load: the matrix from the runner

`deploy/results/bench-runner-20261106T010353Z-155691.json`: the Vultr runner in Chicago (`vc2-2c-4gb`, client load at most 0.9 of 2 CPUs), repository at `4f17d89`, `LOAD=1,5,10,25,50,100:60:0.2` (users per step, 60 s per step, 20% of users buy). wp-a2 ran first, then wp-ref-a (`a` on the Vultr MariaDB box). Times are medians in seconds.

| Users | wp-a2 rps | browse | checkout | checkouts ok | wp-ref-a rps | browse | checkout | checkouts ok |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.23 | 3.66 | 8.37 | 3 of 3 | 0.19 | 5.01 | 5.04 | 1 of 1 |
| 5 | 0.78 | 3.57 | 9.09 | 10 of 10 | 0.97 | 5.12 | 7.53 | 7 of 7 |
| 10 | 1.36 | 4.89 | 12.31 | 13 of 13 | 1.73 | 4.09 | 8.08 | 21 of 21 |
| 25 | 2.55 | 6.72 | 11.29 | 38 of 38 | 3.25 | 5.85 | 7.22 | 44 of 44 |
| 50 | 4.51 | 6.69 | 11.77 | 41 of 49 | 5.39 | 5.59 | 7.47 | 72 of 72 |
| 100 | 8.79 | 6.63 | 10.21 | 95 of 116 | 8.63 | 5.92 | 7.69 | 115 of 120 |

- **a2 scales like `a`:** about the same requests per second at 100 users (8.79 against 8.63), no Worker resource errors (1102), no isolate recycles.
- **a2 checkout is slower:** 10 to 12 s against 7 to 8 s. A checkout made 393 queries in `tests/woo.py` on wp-a2; at about 16 ms per query against about 10 ms, that is about 2.4 s more in the database. Browse is about 1 s slower at 25 users and up.
- **The a2 errors at 50 and 100 users are not a database result.** They come in pairs: add to cart answers **400 `woocommerce_rest_product_out_of_stock`**, then checkout answers **409 `woocommerce_rest_cart_empty`** (reproduced with `tests/a2/conflict-repro.py`, 30 users, 2 buys each: 50 buys ok, 10 pairs of 400 then 409, `tests/a2/results/conflict-repro-wp-a2.jsonl`). The product was the stock-managed "Edge Mug" that `tests/woo.py` made (stock 20). `tests/load/load.py` picked every purchasable product, and the Store API keeps an out-of-stock product purchasable, so once the matrix bought its stock out (during the 50-user step), about 1 buy in 6 (1 product of 6) went to it and failed: 8 of 49 at 50 users, 21 of 116 at 100. No Vitess, lock or transaction error was seen. `load.py` now buys only products that are in stock.
- **`a` is not stable from run to run.** wp-ref-a made 18.7 requests per second at 100 users in an earlier matrix, and 8.63 now. One run is not a measurement, for `a` too. A possible cause, not measured: the one-box MySQL on Vultr now holds hundreds of test orders. Its 15 errors at 100 users (5 answers 500, 10 answers 401) are a different kind and are not explained here.

## A variant a fault found by the plugin suite: a WebSocket request booted PHP

The first run of `tests/a2/plugin-suite.sh` (2026-11-06) refused all 7 groups: the local OPcache step failed. `e2e.sh` passed every request but failed its check that the home page links to its own address: the page linked to `http://127.0.0.1:<port>/` while the site (and `wp_options` `home`) was `http://localhost:<port>` (`tests/a2/opcache-diag.sh`). `deploy.sh` showed only the last line of the step, a passing row, so the failure was hidden; it now keeps the whole output in `build/opcache.log` and prints its last lines on a failure.

The cause: during `/_install`, PHP's socket layer opens a WebSocket to the site by IP address. After the install the Worker drops its PHP runtime, and that queued request booted the next one with its own origin, `http://127.0.0.1:<port>`, which became `WP_HOME` for every later page. The Worker refused such requests (426) only for PHP in a Durable Object (approach B, 8i), not for PHP in the Worker (variant `a`). Measured with `wrangler dev` (4.107.0) and `DEV_ENV=a-local`:

| Request | Before the fix | After the fix |
| --- | --- | --- |
| `GET /` with `Upgrade: websocket`, to `127.0.0.1` | 302, and the Worker logged `{"m":"req","path":"/","boot":true,"d1":15}`: the same line as the request that booted PHP in the failed runs | 426, logged `ws-refused`, no boot |

`wrangler dev` does not change `request.url`: it follows the `Host` header (`localhost`, `127.0.0.1` and `[::1]` each came back as sent). So the wrong origin came from the request, not from Wrangler. The guard now runs before the variant branch, for every variant, and every boot logs its origin. On Cloudflare the same request carries the site's own host on port 443 (8i); whether it ever pinned a wrong origin on a deployed variant `a` site is not measured (each isolate boots its own runtime).

Why the build with WooCommerce passed the same check is not proven: `opcache.sh` activates WooCommerce right after the install, and that request may boot the runtime first, from `localhost`.

## The plugin suite

`tests/a2/plugin-suite.sh` from `439d164` (with the WebSocket guard), 2026-11-06: all 7 groups deployed, and the restore deploy put WooCommerce back. Results: `tests/plugins/results/a2-paid.jsonl` (column "A2 (PlanetScale), Paid" in [plugins.md](plugins.md)).

- **17 of 18 pass**, and all 7 baselines (no suite plugin active) pass.
- **All-in-One WP Migration fails, the same as `a` on Vultr:** activate, home and post work; the dashboard and the plugin's admin page answer 500 ("WordPress › Error"). The steps match the `a` row step for step, and #29 describes this failure: the plugin calls `mysqli_*` on `$wpdb->dbh`, which the drop-in does not provide. The row does not carry PHP's error text, so this is a match of the failure's shape. It is not a Vitess result.
- No other plugin failed on PlanetScale's strict mode or on Vitess, with `HYPERDRIVE_SQL_MODE` set.

## Open

- A second load matrix with the `load.py` fix, for a2 and `a` both, to see the run-to-run spread (next sprint).
- The billing account for the database.
- Whether a Worker placement nearer Ohio than ORD exists for this account.
