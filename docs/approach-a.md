# Approach A: WordPress in a Worker, MySQL outside Cloudflare through Hyperdrive

Measured 2026-11-05 on Workers Free and Workers Paid. Two implementations, on the same database:

- **Our A**: the approach B Worker with only the database changed. Same PHP build, same OPcache, same page cache, same R2 media. Code: `spikes/b2-wordpress/index-a.js`, `mysql-bridge.js`, `php/hyperdrive-db.php`, `ENGINE=a ./build.sh`, wrangler envs `a-free` and `a-paid`.
- **HostlessWP** ([hostlesswp/hostlesswp](https://github.com/hostlesswp/hostlesswp) at `739e8e7`), measured as it is: its own CLI made the Worker, the Hyperdrive config and the page cache. See [prior-art.md](prior-art.md).

Conrad asked for both on 2026-11-05: "spin up a vps on vultr and do the hyperdrive testing" and "test the public sql with ssl path ... i want to give this an honest look".

## The test database

`tests/a/terraform` (state in R2, CR issue #27): one Vultr box in Chicago (`ord`, `vc2-1c-2gb`), MariaDB 10.11 with SSL. Chicago because approach B's D1 primary measured near Chicago, so A and B see about the same distance. Two ways in:

| Path | How | Who can reach port 3306 |
| --- | --- | --- |
| Tunnel | Hyperdrive to `mysql-a.skyphusion.org`, a Cloudflare Tunnel, authenticated by an Access service token | No one: the box has no open port for it |
| Public | Hyperdrive to `mysql-a-public.skyphusion.org:3306` over SSL. HostlessWP documents this path. | Cloudflare's IPv4 ranges only (Vultr firewall group). The remote user requires SSL. |

The public path departs from the estate rule that a box is reached only through a tunnel. Conrad ordered it for this test. `terraform destroy` removes the box and every path.

Each site has its own table prefix in the one database: `wp_` and `wpf_` (our A), `hwpp_` and `hwpf_` (HostlessWP).

## Results

### Per query

`/_d1ping` on our A Paid Worker: 20 reads of one option, from the Worker (placement `remote-ORD` on every request).

| Path | Median per query | First query (opens the connection) |
| --- | --- | --- |
| Public, origin given as the host name | 6 to 11 ms | 20 to 54 ms |
| Public, origin given as the IP address | 41 to 48 ms | 62 to 178 ms |
| Tunnel and Access | 98 to 102 ms | 107 to 415 ms |
| (B, D1, for comparison) | 12 ms | |

Give Hyperdrive the database host **name**, not its address. With the address, every query was about 6 times slower. We found this when our A was 6 times slower than HostlessWP on the same database; our A on HostlessWP's Hyperdrive config measured 7 ms. The tunnel path costs about 90 ms more per query than the public path.

### Pages, uncached

`tests/a/bench.py`, 10 runs per page, each a fresh render (`?nocache=` and `Cache-Control: no-cache`), public path, run one target after the other. Median seconds, and database time per query from the response headers.

| Page | Our A, Paid | HostlessWP, Paid | HostlessWP, Free | Our A, Free |
| --- | --- | --- | --- | --- |
| Home | 0.92 | 0.85 | 0.84 | 3.21 (5 of 10 answered) |
| Post | 0.93 | 0.96 | 0.93 | 3.41 (7 of 10) |
| Search | 0.87 | 0.77 | 1.00 | 3.08 (7 of 10) |
| Dashboard | 0.97 | 1.26 | 1.05 | 3.72 (7 of 10) |
| New post (editor) | 1.67 | 1.39 | 1.66 | 4.45 (1 of 10) |
| Database time per query | about 9 ms | about 8 ms | about 10 ms | about 60 ms |

On Paid the two implementations are equal. HostlessWP claims about 1.2 s for a core home page and about 33 ms per query ([hostlesswp.com/benchmarks](https://hostlesswp.com/benchmarks)); measured here, it does better than its claim. Our A on Free fails at the CPU limit, like approach B on Free, and pays about 60 ms per query because a Free Worker has no region placement.

### Checks

| Check | Our A, Free | Our A, Paid | HostlessWP, Free | HostlessWP, Paid |
| --- | --- | --- | --- | --- |
| `e2e.sh` (17 checks) | fails: CPU limit | 17 of 17 | 17 of 17 | 17 of 17 |
| `tests/break.py` (27 checks) | not run | 27 of 27 | not run | not run |
| Plugin suite (18 plugins) | 0 of 18 | 17 of 18; All-in-One WP Migration passes since #29 (`wp-ref-a`, 2026-11-06), the other 17 not re-run on that build | 18 of 18 | 18 of 18 |
| `tests/woo.py` (WooCommerce, 12 checks) | 0 of 9 (activation: CPU limit) | 12 of 12 | 12 of 12 | 12 of 12 |
| Installer in the Worker | refused: 1102 after 7.7 s | 539 queries, 41 s (82 s on the tunnel path) | n/a (installs from the source site) | n/a |

`tests/break.py` checks our own endpoints (`/_install`, the spike token), so it does not apply to HostlessWP as written.

Our A on Paid runs WooCommerce checkout (393 queries, 8.4 s). Approach B with D1 on Paid does not: its checkout exceeds the isolate memory limit. (The b-dosql variant of B, with SQLite inside the Durable Object, does run checkout; see the README matrix.) Both run the same PHP build, and WebAssembly memory after a WooCommerce page is about the same (99 MiB in B, 83 to 99 MiB in A). B makes about 800 database calls for a checkout, A 393: the SQLite translator in B adds schema reads. Our working explanation is that the extra bridge traffic and translation push total isolate memory (JavaScript and WebAssembly together) over 128 MB. Not yet isolated: neither Worker reports JavaScript heap per request.

The one plugin that fails on our A Paid is All-in-One WP Migration: every wp-admin request answers 500 while it is active. The plugin has its own database client and picks it by the `wpdb` class. Approach B's `WP_SQLite_DB` gets a client that goes through `$wpdb`; any other class gets a client that calls `mysqli_real_query()` on `$wpdb->dbh`, on every admin page. In our A, `$wpdb->dbh` is not a mysqli link. HostlessWP ships a userland mysqli for this and passes. Issue #29.

**A userland mysqli (issue #29). Measured locally and on Paid 2026-11-06.** Our php-wasm has no mysqli extension: in a built tree, `extension_loaded('mysqli')` is false, the classes are absent, and the 18 `mysqli_*` functions checked are absent. So `spikes/b2-wordpress/php/hyperdrive-mysqli.php` declares them in PHP, following HostlessWP ([prior-art.md](prior-art.md)):
- `mysqli`, `mysqli_result`, `mysqli_sql_exception`, the `MYSQLI_` constants and the procedural `mysqli_*` functions;
- every query on the same bridge as `wpdb` (`skyphusion_hd_run()`, with the sql_mode handling of a strict server);
- `db_connect()` gives `$wpdb->dbh` a `mysqli` object and turns reporting off, as `wpdb::db_connect()` does. With reporting on (PHP 8.1's default), a failed query throws `mysqli_sql_exception`.
- Everything is declared inside one `class_exists('mysqli')` block. A PHP with the real extension (`php -l` on a Mac or in CI) declares nothing, and the real extension stays in use.
- Not covered: prepared statements and `multi_query` (both return an error), field types and lengths (every field is a string).

| Where | Test | Without the layer | With it |
| --- | --- | --- | --- |
| php-wasm, stub bridge | `tests/a/mysqli-surface.sh` (All-in-One WP Migration's calls, core's `flush()` and `bail()` paths, fetch modes, errors in both report modes) | - | 30 of 30; a mutation that never throws fails its check |
| local `a-local`, MariaDB 11.4.13 | `plugins.py all-in-one-wp-migration` | dashboard and admin page 500 | pass |
| local `a-local`, MariaDB 11.4.13 | `e2e.sh` | 17 of 17 | 17 of 17 |
| `wp-ref-a` (Paid, MariaDB 10.11 through Hyperdrive), deployed by `deploy/deploy.sh` with `PLUGINS=all-in-one-wp-migration` | `plugins.py all-in-one-wp-migration` | dashboard and admin page 500 (the plugin suite on A Paid before #29) | pass: activate, home, post, dashboard, admin page, deactivate all 200 |

The surface test proves the PHP side only: its bridge is a stub. The MariaDB rows and the `wp-ref-a` row are the real bridge. On Paid only this plugin was re-run; the other 17 of the suite were not re-run on this build. A2 (PlanetScale) uses the same `hyperdrive-db.php`, so it should pass too, but it was not re-run.

**Found on the way: admin pages with WooCommerce recycle the PHP runtime on A (issue #84). Measured locally 2026-11-06. Not measured on Cloudflare.** After a request whose WebAssembly memory passes `RECYCLE_WASM_BYTES` (100 MiB), the Worker drops the PHP runtime, and the next request boots a new one. Priming OPcache with the `wp-ref-a` settings (`a-local` on MariaDB 11.4.13, WooCommerce active, All-in-One WP Migration in the build) passed it 3 times, each at 119 MiB: on `post-new.php`, a REST posts request, and `/wp-admin/`.
- So on a live A site with WooCommerce active, each such admin page pays a runtime boot on the next request. The 100 MiB threshold is below the 128 MB isolate limit on purpose.
- The first two requests come from `e2e.sh`, before `plugins.py` activates All-in-One WP Migration. So WooCommerce alone reaches 119 MiB on those pages; the plugin's own share is not isolated.
- It is the same PHP build locally and on Cloudflare, so the memory is expected to be the same, but it is not measured there.
- Priming no longer recycles (`PHP_RECYCLE:off` in `opcache.sh`, approach-b.md 8e). Production keeps the recycle: `PHP_RECYCLE` is set nowhere in `deploy/` or `wrangler.toml`.

**Found on the way: binary SQL is stored doubled (issue #79).** SQL that is not valid UTF-8 goes to the Worker as `{mysql_b64}`. `mysql-bridge.js` decodes it as latin1, and mysql2 sends it as utf8mb4. On MariaDB 11.4, `e9 ff 80` was stored as `c3 a9 c3 bf c2 80`. Valid UTF-8 and bytes up to 0x7F are correct. The same result came without the mysqli layer.

**Fixed (issue #79). Measured 2026-11-06.** `php/hyperdrive-literals.php` rewrites each string literal that is not valid UTF-8 as a hex literal (`X'...'`), so the SQL on the bridge is valid UTF-8 and MySQL reads the same bytes. This is HostlessWP's approach ([prior-art.md](prior-art.md)).
- Literals are read as MySQL reads them without `NO_BACKSLASH_ESCAPES`, which is how `wpdb` escapes: backslash escapes, doubled quotes, and `\%` and `\_` keeping their backslash.
- Backticked names and comments are copied as they are. A charset introducer gets a space (`_binary X'...'`).
- SQL with such bytes outside any literal gets an error reply and is not sent.
- `mysql-bridge.js` refuses `{mysql_b64}` with an error instead of decoding it as latin1.
- The escape moved into the same file, so `tests/a/literals-test.php` tests the shipped one. CI runs that test.

| Test | Result |
| --- | --- |
| `php tests/a/literals-test.php`: 20 cases, plus 2000 random values escaped as `wpdb` escapes them | 21 of 21. Mutation (the NUL unescape removed): 2 fail, 143 of 2000 values wrong |
| local `a-local`, MariaDB 11.4.13, the probe: `$wpdb` writes into `VARBINARY`, read back with `HEX()` | `c3a9`, `e9ff80` and `007f80` stored as written; a mysqli write in All-in-One WP Migration's shape (`mysqli_real_query()` on `$wpdb->dbh`, `e9 ff 80 00 27`) stored as written |
| the same run: `e2e.sh`, `plugins.py all-in-one-wp-migration`, `break.py` | 17 of 17; pass; the same PASS/FAIL set as without the layer |

### HostlessWP on Workers Free

HostlessWP runs PHP in a Durable Object on the Free plan; a Durable Object request may use 30 s of CPU. The Worker answers from a page cache in Workers KV and forwards the rest. That is why every Free column for HostlessWP passes, and every Free column for our A and for approach B stops at the CPU limit. Issue #28 brings that design to approach B.

## What we found about HostlessWP

It works as its README says, on its documented path. Things a user should know:

- **The plugins in a deploy are the plugins active in the database at deploy time.** It bundles only active plugins. The source site and the Worker share one database, so a plugin turned off in wp-admin is left out of the next deploy, and turning it on again later fails until a new deploy.
- **All of the 18 suite plugins active at once do not fit.** With all of them active, the login request answered 1102 (Worker exceeded its resource limits) at 118 MB of WebAssembly memory, on Free and Paid. One at a time, all 18 pass. HostlessWP's compatibility list is also tested one plugin at a time.
- **Precompile is off on Node.js 26.** Its check runs `node --experimental-wasm-jspi`; Node.js 26 has JSPI on by default and removed that flag, so the check fails and the deploy skips OPcache precompile (slower cold starts). With Node.js 24 it precompiled 21,596 scripts.
- **It needs MySQL with SSL, also through a tunnel.** Its setup refuses a server with `have_ssl = DISABLED` before it asks how to connect. Its own tunnel mode needs a connector process that it starts on the database server; the process stops on reboot.
- **Deploys are imperative and kept on one machine.** State is in `~/.hostlesswp/sites/<name>/state.json` and in `hostlesswp-config.php` next to `wp-config.php`. There is no plan or diff, and a second environment is a second run of the wizard.
- **It takes the database port from `DB_HOST`.** The CLI uses one database setting for its own connection and for Hyperdrive, so it must run where the database answers on its real port (it is meant to run on the database server).

## Mistakes in our setup, recorded so no one repeats them

- Vultr's Ubuntu image has `ufw` on and allows only port 22. The Vultr firewall rule for 3306 was in place and the port was still closed, which looked like "Hyperdrive cannot connect from Cloudflare's ranges". It can; cloud-init now opens 3306 in ufw.
- A new DNS record: Hyperdrive answered "DNS lookup failed" for a few minutes after it was created, while 1.1.1.1 resolved it. Using the address instead made every query 6 times slower (see above). Wait for the record.
- `wp plugin activate --all` on the local PHP 8.5 stopped at an Elementor fatal error and left plugins inactive, so two HostlessWP deploys left plugins out. `active_plugins` is now written directly.
- A WordPress install where plugins make content first does not have post id 1. The harness now finds the first published post.

## Cost

The test box is $10 a month, billed by the hour, and is destroyed after the tests. Hyperdrive is included on both plans; Workers Free allows 100,000 Hyperdrive queries a day ([Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/), read 2026-11-03).
