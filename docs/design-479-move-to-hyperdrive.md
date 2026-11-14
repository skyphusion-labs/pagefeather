# Move a standard store to a Hyperdrive store (#479): design

Joan, 2026-11-14. Design only: nothing is built, and no account, site or database was touched. Each claim names the code it was read from on `main` at `7c9b450`. A claim with no source is marked **unmeasured**.

## The problem

A standard store (`wp`, b-dosql) keeps WordPress and WooCommerce in one Durable Object: PHP and the SQLite database together. It is fine for a few shoppers at once. It collapses at 50 concurrent checkouts (`docs/results.md`, 2026-11-09). A store that grows past the cut (#431) needs a way to the Hyperdrive store (`a`), and it must keep every order, customer, product and image.

Conrad's words: the "tier 2 to 3 move".

## What already exists (read on main)

| Piece | Where | What it does today |
| --- | --- | --- |
| SQLite export | `/_dbexport` (`spikes/b2-wordpress/index.js`, `dumpTo`) | NDJSON: the SQLite `CREATE TABLE` text, then one parameterized `INSERT` per row. SQLite dialect, not MySQL. |
| Row counts | `/_dbcounts` | `COUNT(*)` per table, bounded: it completes where a full `/_dbexport` does not (the code comment says so). |
| MySQL import | `/_sqlimport` (`spikes/b2-wordpress/sql-import.js`) + `deploy/import/mysql-prepare.py` | Takes a mysqldump, runs `DROP TABLE IF EXISTS` / `CREATE TABLE` / `INSERT` on the a site's MySQL. Takes only tables named `wp_*`. `replace=1` drops every `wp_*` table in the database first. |
| MySQL dialect on SQLite | the driver at `SQLITE_DI_REF=f05c1f9` (`packages/mysql-on-sqlite`) | Keeps a MySQL information schema (`class-wp-sqlite-information-schema-builder.php`) and answers `SHOW CREATE TABLE` in MySQL form (`class-wp-mysql-on-sqlite.php`). |
| Media | `mediaBucketName(name)` = `wp-wfp-<name>-media` for BOTH kinds (`deploy/provision/wp-site-config.mjs`) | The same bucket name, so the images do not move. |
| Object cache | `ocKvNamespaceName(name)` = `wp-wfp-<name>-oc` for both kinds | The same namespace, so it is flushed, not made again. |
| a code keeps the object class | `index-a-lean.js` re-exports `PhpRuntime` | An a upload over the same script can keep the Durable Object class, and with it the SQLite. |

## Design

### 1. The owner's view (GUI)

In **Sites**, a standard store gets a row action **Move to Hyperdrive store**. The screen asks for one thing: a connected database (from **Databases**, #431). It offers **Test the move** first (the dry run, section 6a), and the real move only after a dry run passed on the same store and database within the last 24 hours. It says what happens, in this order:

1. The store goes **read-only** for the move. Visitors see "Back soon" (HTTP 503 with `Retry-After`). The admin stays open for reading only: no save, no order edit.
2. The data is copied to the database, then every table is counted on both sides.
3. The store opens again on the Hyperdrive store. Same address, same logins, same images.
4. The old data stays in place as a way back for 7 days. **Move back** is a row action in that time.

A progress screen shows the step and the row counts. It is safe to leave and come back: the move runs on its own (section 3).

### 2. The data path: MySQL from the source's own PHP

> **Superseded 2026-11-14 by M1** (#479 issuecomment-6873675033): the driver's DDL matches native MySQL in structure, but its collation differs (52 tables) and one default really differs (`wp_wc_order_product_lookup.date_created`: native `CURRENT_TIMESTAMP`, driver `'1970-01-01 00:00:00'`). So the move does **not** create the target's tables from the source. The target Hyperdrive store already has WordPress's and WooCommerce's NATIVE tables (#431 b). The move copies **rows only, by column name**, with `/_mysqlexport` (raw SQLite, paged by rowid, no PHP; #535). Only a table the target lacks takes the driver's DDL, with the collation rewritten and its defaults checked, and it is listed on the screen. The text below is the original design, kept for the record.

The SQLite file is not converted on the laptop or in the manager. The **source site's own PHP**, with its own driver, writes the MySQL form:

- A new operator endpoint on b-dosql, `/_mysqlexport?table=<t>&after=<pk>&limit=<n>`, under the spike token like `/_dbexport`. For each table it returns `SHOW CREATE TABLE` (MySQL DDL from the driver's information schema), then the rows as MySQL `INSERT` statements, written through `$wpdb`, so the values are MySQL literals. It pages by primary key (`after`), not by OFFSET, so a large table stays bounded per request.
- The target is the a site's existing `/_sqlimport`, with two changes (section 5): it writes to the target's own prefix, and `replace` drops only that prefix.

**Why not reuse `/_dbexport` and convert it:** its `CREATE TABLE` is SQLite text with SQLite types. Mapping it back to MySQL by hand repeats what the driver already stores (the original MySQL column types, keys and charsets). **Unmeasured:** how faithful `SHOW CREATE TABLE` is at `f05c1f9` for every WooCommerce table (HPOS order tables, Action Scheduler, `wc_*` lookup tables). That is the first measurement (section 7).

### 3. Who runs it: a Workflow in the site manager

The move is long (tables by pages) and must survive a restart. It runs as a **Cloudflare Workflow** bound to the site manager. Each step is one bounded call with retries: freeze, one page of one table, count, cut over. The Workflow state holds only table names, page keys and counts, never row data. The rows pass from the source's response straight to the target's request in one step.

**Unmeasured:** that the Deploy to Cloudflare button makes a Workflow binding. The button docs list Workflows among the resources it can make (read 2026-11-13 for #401); confirm with the button test.

### 4. Freeze and cut-over

- **Freeze (read-only window).** The site map entry gets `moving: { since, workflowId }`. The front door (`deploy/wfp/dispatcher/worker.js`) answers 503 + `Retry-After: 120` to anything that is not a GET or HEAD from a signed-in admin while `moving` is set. Every write, admin writes included, stops at the edge, so the source data cannot change while it is copied. Checkout, cart, comments and REST writes all stop at the edge, so no order is placed mid-copy. The cron is held off on the source, as `/_dbimport` already does (`IMPORT_HOLD_KEY`).
- **Cut-over.** It uploads the a code over the SAME script `site-<name>`: main module `index-a-lean.js`, the a bindings, the connected Hyperdrive ID, and the table prefix. It **keeps the `PhpRuntime` class** and sends no `deleted_classes` migration, so the SQLite stays. It keeps the existing `WP_SALT` (logins stay valid), flushes `wp-wfp-<name>-oc`, and purges the page cache. The site map entry changes `kind` to `a`, sets `database` and `tablePrefix`, and moves the old values to `previous: { kind: 'wp', until }`. Then it clears `moving`.
- **Same names, nothing to move:** the hostname, the front door `wp-<name>`, the media bucket and the cache namespace all stay. Only the code and the bindings of `site-<name>` change.

### 5. Two changes to `/_sqlimport` (and one hazard they remove)

- **Prefix.** Today it takes only `wp_*` names and `mysql-prepare.py` renames to `wp_`. A Hyperdrive store from #431 has the prefix `wp_<name>_`. The import takes the target's prefix from the site's own `WP_TABLE_PREFIX`, never from the request. It accepts only tables under that prefix.
- **`replace` stays inside the prefix.** Today `replace=1` drops EVERY `wp_*` table in the database (`sql-import.js`). On a database shared by several stores, `wp_` also matches `wp_<other>_*`, so an import into one store would drop the others' tables. This is reachable now with `deploy/import.sh VARIANT=a` against a shared database, operator only (spike token). With the change, `replace` drops only the target's prefix. I report the hazard to the lead separately; it is not public-facing.

### 6. Check, then open

**The completeness rule (lead, 2026-11-14, from #519: on b-dosql a read can miss rows that exist, while the write was durable).** Every exported table is proved complete against an independent count: the rows of its pages must add up to its `COUNT(*)`, read before the export **and** again after it (`/_mysqlexport?stats=1`), and the last rowid must reach `MAX(rowid)`. Any shortfall is a **failed export**, never a partial success: the move stops before the cut-over, and the store opens again on the standard path. The same holds on the target after the load (`/_sqlimport?counts=1`).

**What must arrive intact (the integrity bar):**

| Data | Checked by |
| --- | --- |
| Orders | order count and highest order ID per order table (HPOS `wc_orders`, and `posts` of type `shop_order` if the store still has them); per order, a checksum of total, status, customer ID and item count, compared on both sides |
| Order items | row count of `woocommerce_order_items` and `woocommerce_order_itemmeta` |
| Customers | row counts of `users`, `usermeta` and `wc_customer_lookup`; per user, a checksum of login, email and password hash (so every login still works) |
| Products and stock | row counts of `posts` (type `product`, `product_variation`), `postmeta`, `wc_product_meta_lookup`; per product, a checksum of SKU, price and stock |
| Media | the R2 bucket is not touched (same name on both kinds); the `attachment` row count is equal; every `_wp_attached_file` value is the key of an object in the bucket (listed, not sampled) |
| Everything else | the row count of every table under the prefix |

The checksums run on both sides through SQL (`SELECT ... ORDER BY id`), page by page, and compare digests only. No row data is stored by the manager.

**6a. The dry run (Test the move).** It runs the whole copy and every check above into the target **without** the freeze and **without** the cut-over. The store stays open. Because the store keeps taking orders, counts may differ by the rows written during the run; the dry run reports those as "changed during the test" (rows with an ID above the snapshot's highest), never as a pass. It proves the dialect, the copy and the checks on this store's real data. Then it **removes what it wrote** (a prefix-scoped drop, #487) and says how long the real move will take (the copy time).

**6b. The real move.** After the freeze, the same copy and checks must be EXACTLY equal, with no "changed" rows, because nothing could write.

Before the cut-over:

- every check in the table is equal;
- a test login to the a site works (spike `/_install` answers `already`).

Any difference stops the Workflow **before** the cut-over, and the store opens again on the standard store, unchanged. The copied tables stay in the database, and the screen says how to remove them.

### 7. Move back, and the end of the old data

- **Move back** (7 days): upload the b-dosql code over `site-<name>` again, with the old bindings from `previous`. The SQLite is the state at the freeze. **Orders taken AFTER the move are not in it.** The screen says so in a line of its own and asks for the store name before it acts.
- After 7 days, a manager task removes the old SQLite by a migration that deletes `PhpRuntime`, then removes `previous`. **Unmeasured:** the exact migration form for a namespace script that keeps its name and drops a class. Measure on a throwaway before building.

### 8. Measurements before it ships (on a throwaway in our account)

1. **Dialect fidelity:** `/_mysqlexport` of a GUI-made standard store with WooCommerce plus a sample catalog and orders. Load it into a fresh Hyperdrive database, then compare `SHOW CREATE TABLE` per table with a native MySQL WooCommerce install of the same versions. Every column type, key and charset must match, or be listed with the reason.
2. **The move end to end:** 20 orders from 5 customers on the standard store, with product images. Dry run first (it must pass), then move, then `tests/woo.py` 12 of 12 three times on the moved store. All 20 orders are visible with their items, all 5 customers log in with their old passwords, and every image loads.
2a. **The dry run is honest:** place an order during a dry run. It must be reported as "changed during the test", and the dry run must not pass.
3. **The freeze holds:** a checkout started during the copy gets a 503 and no order row on either side.
4. **Move back:** after the move and one new order, move back. The old 20 orders are there. The new order is not, and the screen said so.
5. **Failure paths leave the store as it was:** a count mismatch (a row deleted on the target mid-run), the database unreachable, the Workflow stopped mid-copy. Each must end with the store open on the standard path and the inventory (scripts, buckets, map entries) unchanged.
6. **Shared database:** a move into a database that holds another store must leave the other store's tables and row counts unchanged.

### What it does not do

- It does not move an a store back to b after the 7 days.
- It does not merge two stores.
- It does not change the address: a custom domain stays a separate item (#401).

## Order of work (one PR each, design gate first)

1. `/_sqlimport`: target prefix and prefix-scoped `replace` (the hazard fix; useful on its own). Filed as #487 (Rollins).
2. `/_mysqlexport` on b-dosql, with the dialect measurement (8.1).
3. The front-door freeze (`moving`), with its test.
4. The manager Workflow, the GUI action and the progress screen.
5. Move back, and the 7-day removal.

## Open points for the lead

- **Who owns the parts:** `sql-import.js`, `/_mysqlexport` and the dispatcher are the backend lane (Rollins). The Workflow and the screens are mine.
- **7 days for Move back:** a guess at a safe window. The cost is the SQLite kept in the Durable Object for that time.
- **The dry-run gate:** the real move needs a passed dry run within 24 hours on the same store and database. 24 hours is a guess.
- **WP_SALT kept:** it keeps owners and customers logged in. Making it again is safer if the source was ever compromised; it would need a choice on the screen.
