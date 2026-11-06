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

## Open

- The #50 checks on the real site: `e2e.sh`, `tests/woo.py`, the plugin suite, the Hyperdrive query cache check (caching is off for this config; the check shows whether it may be on), and the load matrix from the runner.
- Billing: which account pays for the database.
- Whether a Worker placement nearer Ohio than ORD exists for this account.
