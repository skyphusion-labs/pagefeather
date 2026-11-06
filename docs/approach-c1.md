# Approach C1: WooCommerce in a Container, SQLite on local disk, Litestream to R2

Measured 2026-11-04 on Workers Paid. Code: `spikes/c1-woo-container`. Conrad's direction: WooCommerce entirely in the container, the whole environment on Cloudflare.

## Why

- In a Worker (approach B), WooCommerce checkout passes the 128 MB isolate limit. WooCommerce asks for 256 MB ([server recommendations](https://woocommerce.com/document/server-requirements/)).
- With checkout in a container but the database still on D1 (`docs/approach-c-checkout.md`), every query is a network round trip, about 46 ms. A checkout makes about 390 of them: 42 s.
- So the database goes into the container, next to PHP.

## Design

- **Container:** stock WordPress 7.1.4, WooCommerce 11.2.1 and the official SQLite plugin (`sqlite-database-integration`, its own `db.php`), on a real SQLite file at `/data/wordpress.sqlite`. PHP 8.3 with PHP's built-in server (2 workers), 256 MB for PHP, instance type `basic`.
- **Durability: Litestream to R2.** The container disk is lost when it sleeps. On start, `litestream restore` gets the database from R2 if a replica exists; otherwise the entrypoint installs WordPress and WooCommerce. Then `litestream replicate -exec "php -S ..."` runs PHP and sends every change to the R2 bucket `wp-woo-c1-db` (1 s sync interval). The S3 key can touch only that bucket.
- **The Worker in front:**
  - Static files come from Workers static assets.
  - Uploads come from R2 (`wp-woo-c1-media`).
  - Logged-out pages come from Workers Cache (`Vary: Cookie`; cart, checkout, account, admin and REST are never cached).
  - Everything else goes to one container named `store` (one writer, as SQLite wants).
- **Media and images:** the same R2 Uploads and Cloudflare Images mu-plugins as approach B. PHP calls `http://worker.internal/`, a Container outbound handler, which uses the Worker's R2 and Images bindings. The container holds no keys for them.
- **Cache purge:** the Edge Cache mu-plugin sends a purge through `worker.internal`; the handler calls `cache.purge()` from `cloudflare:workers`.

Container snapshots were considered for durability and not used. A snapshot is point in time (a crash loses later orders), is tied to the image version (an image update orphans it), and expires after 30 days. Litestream is continuous and survives image updates.

## Results (Paid)

| Test | Result |
| --- | --- |
| `tests/woo.py` (setup, product, shop, product page, Store API cart, guest checkout, order, stock, orders screen) | **12 of 12** |
| Guest checkout (Store API), 4 runs | **1.3 to 1.7 s** each |
| Add to cart | 0.4 to 0.6 s |
| Shop and product pages | 0.6 to 1.0 s |
| Logged-out home and shop pages | `cf-cache-status: HIT` on the second request |
| Cold start after a stop: restore from R2, then the first response | about 11 to 12 s |
| First start with no replica (install WordPress and WooCommerce) | about 60 s (two errors, then 200) |
| Locally: data written, container destroyed, new container started | the product was restored from R2 |

Compared with approach B and the B+C split:

| | Checkout | Product page |
| --- | --- | --- |
| B, in the Worker (D1) | `exceededMemory` | 6 to 10 s wall |
| B+C, checkout in a Container, D1 over the network | 42 s | 6 to 10 s (in the Worker) |
| **C1, WooCommerce and SQLite in the Container** | **1.3 to 1.7 s** | **0.6 to 1.0 s** |

## More tests (2026-11-04)

**`tests/break.py`: 27 of 27.** Two real defects found and fixed first:
- 8 parallel uploads of one file name made 4 files. Approach B reserves names in D1; here the R2 Uploads plugin falls back to `add_option()` in the local database, one INSERT on a unique key. Now 8 of 8.
- An upload over 20 MB was accepted (the Images binding input limit is 20 MB). The Worker now returns 413 over 20 MB.

**`e2e.sh`: all pass** (front-end pages 0.5 to 0.8 s; category and date archives about 2 s; REST posts 3.4 s; dashboard 2.5 s; editor 4.4 s; publish a post and read it back).

**Durability: 6 of 6 orders kept.** A guest checkout, then the container stopped, then a check on the next container (a new boot id proves a new container):

| Stop | After the checkout | Order on the new container | New container after |
| --- | --- | --- | --- |
| SIGTERM (Litestream does a final sync) | 3 s | present | 11 s |
| SIGTERM | 0 s | present | 11 s |
| SIGKILL to Litestream (no final sync, the container exits: a crash) | 5 s | present | 11 s |
| SIGKILL | 2 s | present | 11 s |
| SIGKILL | 1 s | present | 12 s |
| SIGKILL | 0 s | present | 12 s |

"0 s" means the kill request arrived a few hundred milliseconds after the checkout response. Litestream syncs every 1 s, so a crash can lose at most about the last second of writes; none was lost in these tests.

How the stops were made: Linux ignores SIGKILL sent to PID 1 from inside the container, so the entrypoint shell is PID 1 and runs Litestream as a child (it forwards SIGTERM). The spike-only `/_kill.php` sends SIGTERM to PID 1 or SIGKILL to Litestream.

**A Container class finding: `sleepAfter` never stopped the container.** `stop()` from the Worker returned while the container kept running. The Durable Object reported `ctx.container.running = false` for a container that was serving requests, and `stop()` (and `onActivityExpired()`, which `sleepAfter` uses) does nothing when that flag is false. Measured: the same container answered after 17 idle minutes with `sleepAfter = "15m"`. A container that never sleeps bills all month (see Cost).

**Fix: the container stops itself.** The router marks the time of every request, except health checks (`/ping`) and the test boot id: the platform's health checks hit `/ping` and kept the container awake in the first try. A loop in the entrypoint checks every minute; after `IDLE_SECONDS` (900) with no request it sends SIGTERM to Litestream, which finishes its sync, and the container exits. The next request starts a new container, which restores the database from R2. Measured live with `IDLE_SECONDS=180`: after 5 idle minutes, the next request got a new container in 4 s, and an earlier order was present.

**Scaling** (same load test; PHP workers set by `PHP_WORKERS`):

| 5 at a time unless noted | `basic` (1/4 vCPU, 1 GiB, 2 workers) | `standard-1` (1/2 vCPU, 4 GiB, 4 workers) | `standard-2` (1 vCPU, 6 GiB, 8 workers) |
| --- | --- | --- | --- |
| Uncached product page | 2.9 s, 1.4 req/s | 1.55 s, 3.3 req/s | 0.92 s, 4.9 req/s |
| Store API products | 1.1 s, 4.3 req/s | 0.59 s, 7.7 req/s | 0.42 s, 10.7 req/s |
| Add to cart | 1.1 s, 2.3 req/s | 0.58 s, 4.3 req/s | 0.46 s, 5.4 req/s |
| Checkout, 5 shoppers | 3.8 s, 0.6/s | 3.06 s, 1.2/s | 1.39 s, 2.1/s |
| Checkout, 10 shoppers | | | 2.62 s, 2.4/s |

Medians. No errors on `standard-1` or `standard-2`. Each instance type change rolled out in 36 to 66 s, and the new container restored the database from R2.

**Cost of an awake container** ([Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/), read 2026-11-04): memory and disk are billed for the provisioned size while the container runs; CPU only while busy ($0.000020 per vCPU-second, about $0.072 per vCPU-hour at full load).

| Instance | Idle but awake, per hour | Awake all month |
| --- | --- | --- |
| `basic` | about $0.010 | about $7 |
| `standard-1` | about $0.038 | about $27 |
| `standard-2` | about $0.057 | about $41 |

Workers Paid includes 25 GiB-hours of memory and 200 GB-hours of disk a month.

## Under load (Paid, `basic`: 1/4 vCPU, 2 PHP workers)

| Scenario | Median | p90 | Throughput |
| --- | --- | --- | --- |
| Cached home page, 20 at a time, 100 requests | 0.35 s | 1.35 s | 35 req/s |
| Uncached product page, 5 at a time, 40 requests | 2.9 s | 4.9 s | 1.4 req/s |
| Store API products, 5 at a time, 40 requests | 1.1 s | 1.4 s | 4.3 req/s |
| Add to cart, 5 at a time, 20 requests | 1.1 s | 1.4 s | 2.3 req/s |
| Checkout, 5 shoppers at once, 10 checkouts | 3.8 s | 6.7 s | 0.6 req/s |

All checkouts succeeded; 1 of 145 container requests failed (client exception). The limit is the quarter vCPU: requests queue at the 2 PHP workers. A larger instance type (`standard-1`, 1/2 vCPU; `standard-2`, 1 vCPU) is the next measurement.

## Where c1 saturates (2026-11-05)

Issue #39. Site `wp-c1-perf`: the same image as `wp-c1`, plus spike-only measurement. `standard-1` (1/2 vCPU), PHP built-in server, `PHP_WORKERS=4`.

### The instruments

- `container/router.php` writes one line per request to `/tmp/c1-req.log`: the start time, the wall seconds, the CPU seconds of the PHP worker (`getrusage`), the peak memory, the status and the path. The line is written last in the shutdown, so the time includes the shutdown work of WordPress.
- `container/entrypoint.sh` writes one sample every 2 s to `/tmp/c1-samples.log`: the `/proc/stat` CPU line, the cgroup `cpu.stat`, the load, the accept backlog of port 80 (connections that no PHP worker took yet), and the PHP processes by state.
- `/_stats.php` (header `x-spike-token`) returns both logs and the state of the instance. `tests/load/c1_stats.py` reads them after a run. Read the logs after the run: during a run the stats request waits behind the load. The logs are lost when the container stops (`IDLE_SECONDS` after the last request).

The instance shows 1 CPU and no cgroup `cpu.max`. The half vCPU of `standard-1` is applied outside the guest: it shows as about 50 % steal time in `/proc/stat`, and as `usage_usec` in the cgroup.

### The load run

`tests/load/load.py` from the Vultr runner (Chicago, 2 vCPU), LEVELS 1,5,10,25,50,100, 60 s per step, BUYERS 0.2, uncached. Result: `deploy/results/bench-runner-20261105T223444Z-da819d.json`.

| Users | rps | browse p50 | browse p95 | checkout p50 | checkouts | errors |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2.29 | 0.43 s | 0.75 s | 0.58 s | 21/21 | 0 |
| 5 | 2.53 | 1.93 s | 4.13 s | 2.80 s | 21/21 | 0 |
| 10 | 2.45 | 3.95 s | 5.81 s | 4.81 s | 28/28 | 0 |
| 25 | 2.49 | 9.49 s | 12.28 s | 10.37 s | 22/22 | 0 |
| 50 | 2.69 | 17.93 s | 20.08 s | 19.11 s | 29/29 | 0 |
| 100 | 2.64 | 33.24 s | 37.43 s | 28.78 s | 45/45 | 0 |

### What the container measured

- **The CPU is the limit.** vCPU used: p50 0.48, p95 0.50, against the cap of 0.5. From 60 s to the end, every 30 s used 14.0 to 15.0 CPU seconds.
- **CPU per request:** 0.179 s mean. Browse 0.20 s, checkout 0.32 s, cart 0.06 s, add to cart 0.07 s. The ceiling is 0.5 / 0.179 = 2.8 requests per second. The run served 2.4 to 2.9.
- **Inside PHP, the time is CPU sharing.** A browse page took 1.81 s wall (p50) for 0.20 s of CPU: the PHP processes share half a vCPU. The PHP processes were runnable (state R) 3.5 of the time and in disk wait (state D) 0.01. In flight: 4.4 on average. No lock waits show.
- **The rest of the time is the queue.** The accept backlog grew with the users: about 0 to 3 at 5 and 10 users, 18 at 25, 40 at 50, 90 at 100. A request waits there for a free PHP process. The queue has no limit, so at high load a client waits until its own timeout.
- **The PHP server has five processes, not four.** With `PHP_CLI_SERVER_WORKERS=4`, the server process answers requests too: 40 GETs came from 5 process ids (header `x-c1-pid`, added with the APCu step). This is why up to 6 requests were in flight.
- **SQLite and OPcache are not the limit.** `journal_mode` is `wal` (the driver default, with `busy_timeout` 10000 ms). OPcache: 99.9 % hits, not full, no restarts, `validate_timestamps=0`.

So a different PHP server (PHP-FPM, FrankenPHP) does not raise the ceiling: it uses the same CPU for each WordPress request. It can limit the queue (an early 503 instead of a long wait). The levers are less CPU per request, or more CPU.

### wp-c1 and wp-c1-perf: one run is not a measurement

`wp-c1` (the first baseline site) ran the same test at about 1 request per second, with 0 of 32 checkouts at 100 users (`deploy/results/bench-runner-20261105T214231Z-230073.json`). `wp-c1-perf` ran at 2.5. The c1 build inputs are the same, except for the measurement.

- **Not the data.** wp-c1's database (127 orders, 63 pending Action Scheduler actions, 287 autoloaded options, 51 KB) was restored into wp-c1-perf (replica path `swap`, with the `REPLICA_PATH` deploy option of the APCu change). With it, wp-c1-perf used 0.189 CPU s per request (0.179 with its own data) and served 2.4 requests per second at the same cap (`deploy/results/bench-runner-20261105T235852Z-24ad9e.json`).
- **Not the configuration.** The Containers API (read 2026-11-06, about 00:10 UTC) shows the same shape for both applications: 0.5 vCPU, 4 GiB, 8 GB disk, the same scheduling policy and tiers, `max_instances` 1. wp-c1's was last changed at 20:35 UTC, before its load runs.
- **Not explained.** A container with 1/4 vCPU would give 0.25 / 0.19 = 1.3 requests per second, which fits wp-c1. But the configuration says 1/2 vCPU, and the API keeps no record of the host that ran. So the cause is the host or the placement of that container, and it is not known.

The numbers in this document compare against wp-c1-perf, not wp-c1. Repeat a c1 measurement on more than one container start before you trust it.

### WooCommerce's Action Scheduler holds a PHP process

Issue #45. With `DISABLE_WP_CRON`, Action Scheduler runs its queue through an async loopback: the site sends a POST to its own `admin-ajax.php`. That request runs one batch, then calls `sleep( 5 )` (filter `action_scheduler_async_request_sleep_seconds`), then sends the next loopback. An admin request starts the chain; storefront requests do not. In the load run, 30 of these requests held one of the PHP processes from 46 s to 312 s: 6 to 14 s wall each, for 0.1 to 0.8 s of CPU. Every checkout adds one email action to the queue.

Under load the chain stops. With wp-c1's database (63 pending actions at the start), the first runner request took 18.6 s and 4.1 CPU s (one batch of emails), 9 more followed about 6 s apart, and then none for the remaining 7 minutes. Pending actions went from 63 to 137: the queue was larger at the end than at the start. So with WP-Cron off, order emails can wait without limit on a busy store. Issue #45 has the fix candidates.

## Object cache in APCu (2026-11-05)

Issue #39. `OBJECT_CACHE=apcu` (now the default; `none` turns it off) puts an object cache drop-in in `wp-content`: [l3rady/object-cache-apcu](https://github.com/l3rady/object-cache-apcu) 2.0.1, GPL-2.0-or-later ([prior-art.md](prior-art.md)). APCu 5.1.28 is in the image, 64 MiB. All PHP processes of the server share one APCu: `/_stats.php?what=apcu` from 4 process ids gave the same start time and the same counts.

Home went from 62 queries to 1, the shop page from 71 to 1, Store API products from 40 to 0 (`x-d1-calls`, warm cache).

### The measurement

wp-c1's database, restored twice from one file into wp-c1-perf (replica paths `swap` and `swap2`), so both runs start from identical data. Both start on a new container with a cold cache. `standard-1`, the same test as above.

| Users | none: rps | none: browse p50 / p95 | none: checkout p50 / p95 | apcu: rps | apcu: browse p50 / p95 | apcu: checkout p50 / p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1.95 | 0.48 / 0.97 s | 0.61 / 1.06 s | 2.39 | 0.39 / 0.88 s | 0.54 / 0.64 s |
| 5 | 2.62 | 1.98 / 2.91 s | 3.00 / 4.82 s | 3.17 | 1.66 / 2.23 s | 2.70 / 3.08 s |
| 10 | 2.50 | 3.96 / 6.06 s | 6.00 / 7.49 s | 3.05 | 3.75 / 6.26 s | 4.27 / 6.62 s |
| 25 | 2.37 | 10.0 / 13.4 s | 10.9 / 14.1 s | 3.01 | 7.91 / 10.3 s | 9.19 / 12.8 s |
| 50 | 2.40 | 19.1 / 22.8 s | 20.0 / 24.4 s | 2.97 | 15.5 / 17.9 s | 16.6 / 19.6 s |
| 100 | 2.52 | 35.5 / 39.8 s | 21.9 / 39.8 s | 3.09 | 26.9 / 35.9 s | 29.2 / 36.5 s |

Errors: none 16 (10 at 25 users, with no failure in the container log), apcu 0. Results: `deploy/results/bench-runner-20261105T235852Z-24ad9e.json` (none), `deploy/results/bench-runner-20261106T002159Z-2ca71a.json` (apcu).

CPU seconds per request, from the container log:

| | none | apcu | change |
| --- | --- | --- | --- |
| All requests | 0.189 | 0.153 | -19 % |
| Home | 0.174 | 0.136 | -22 % |
| Shop | 0.247 | 0.201 | -19 % |
| Product page | 0.223 | 0.173 | -22 % |
| Checkout | 0.322 | 0.299 | -7 % |
| Cart | 0.062 | 0.044 | -29 % |
| Add to cart | 0.068 | 0.047 | -31 % |

So the cache takes about 20 % of the CPU of a page, and the ceiling goes from about 2.45 to about 3.05 requests per second (+24 %). The CPU is still at the cap. Checkout gains least: most of its work is writes. The queries were not most of the cost: 62 queries to 1 is 20 %. The rest is the start of WordPress and WooCommerce, and the rendering.

### A first run was wrong: freeze the data before you measure

A first APCu run on wp-c1-perf's own data showed no change. Between that run and the run it was compared with, the correctness tests (`tests/break.py`) had written posts to the site, one of them 1.9 MB, and it was on the home page: home cost 80 % more CPU. The pages without posts already showed the gain. Rule: run the tests that write before the data is frozen for a measurement, never between two runs that you compare. For a before and after, seed both runs from one file.

### Correctness

With a persistent cache, all PHP processes share one cache, so a change must show in every process. Checked on the APCu site before the measurement:

- `tests/cache_check.py` (new): an admin price change, stock change and option change, then a deleted product, each read 8 times, uncached. Every read had the new value, none the old one, and the reads came from 4 or 5 PHP processes (`x-c1-pid`). 13 of 13.
- `tests/woo.py` 12 of 12. `tests/break.py` 5 runs of 5, 27 of 27 each.

`tests/break.py` found a race first: "8 parallel uploads of one name get 8 files" failed in 2 of 5 runs (7 files). The c1 fallback in `r2-uploads.php` used `add_option()` as a lock. `add_option()` checks `get_option()` first (with the cache: a shared answer that can be old), then runs `INSERT ... ON DUPLICATE KEY UPDATE`, which reports a change on a duplicate too. Now one `INSERT IGNORE`, and the name is reserved only when it inserted 1 row. With the driver of the image, 8 processes and one name, 5 rounds: the old path gave 6 to 8 winners a round, the new one exactly 1. The reservation rows are not deleted (as before): one row per upload name.

### A deploy must reach the container

Two deploys left the container on the settings of the deploy before: the new image, but the old `OBJECT_CACHE`. The container gets its environment from the Store Durable Object, and a request on a new Worker can reach an object that still runs the code of the deploy before ([Durable Objects known issues](https://developers.cloudflare.com/durable-objects/platform/known-issues/)). A container stop does not replace the object. What changed:

- `[version_metadata]`: the Store object keeps the Worker version it was built with. `/_store-info` (spike token) shows both, and the settings the object holds.
- `/_store-stop` waits until the container stops (up to 30 s, so Litestream finishes its sync), then resets the object. If the container still runs after 30 s, it does not reset (`still_running`).
- `deploy/variants/c1.sh` `c1_check`: waits until the object is from this deploy, then checks that the drop-in matches `OBJECT_CACHE`. Otherwise the deploy fails.

Proof, the first deploy after the change (OBJECT_CACHE `none` to `apcu`, replica path `swap` to `swap2`): the stop got `reset: true` after 250 ms, the object was from the deploy after 0 s, and the settings were correct on the first try. How long an old object can live with no reset is not measured. A method named `info` on the object failed over RPC on Cloudflare ("does not implement the method") and passed in local workerd; it is now `storeInfo`, async.

## Problems found

- WooCommerce writes log files under `uploads/wc-logs`. With uploads in R2, every log line was an R2 read and write: about 30 calls and about 15 s of each checkout. `WC_LOG_DIR` now points to local disk (also in approach B).
- With 4 PHP workers at 256 MB each, a `basic` instance (1 GiB) dropped a connection once ("Container suddenly disconnected"). Now 2 workers.
- PHP's built-in server does not run `index.php` for a directory. `/wp-admin/` went to WordPress and showed the home page. Found 2026-11-05 by the plugin suite; earlier checks passed because they looked only for a 200. `router.php` now runs `<dir>/index.php` and redirects `/wp-admin` to `/wp-admin/`, as Apache and nginx do.
- The container file system is ephemeral. A plugin installed from wp-admin is lost when the container stops, so plugins go in the image (`build.sh` installs the 18 plugins of the suite, none active). The 18 plugins pass: [docs/plugins.md](plugins.md).
- The health check is a static file (`pingEndpoint = "localhost/ping"`): the default requested `/`, a full WordPress render.

## Cost and limits

- Workers Paid only (Containers). The container bills while awake; `sleepAfter = "15m"`. Workers Paid includes 25 GiB-hours of container memory a month: about 25 awake hours on `basic`, then metered ([Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/)).
- R2 holds the database replica and media (R2 free tier, then metered).
- One container: one region, one writer. The first visitor after a sleep waits about 11 s for a page that is not cached. A cart or checkout always goes to the container.

## Next

- Start the container before it is needed: on a product page view, or keep it awake in store hours.
- Admin pages and the editor in the container: measure them.
- Uploads: atomic file names (approach B used D1 for this); one container makes a race unlikely but not impossible.
- Stop sends: Litestream must finish its last sync before the container stops. Measure what a sleep loses (the sync interval is 1 s).
