# Approach C1: WooCommerce in a Container, SQLite on local disk, Litestream to R2

Measured 2026-11-04 on Workers Paid. Code: `spikes/c1-woo-container`. Conrad's direction: WooCommerce entirely in the container, the whole environment on Cloudflare.

## Why

- In a Worker (approach B), WooCommerce checkout passes the 128 MB isolate limit. WooCommerce asks for 256 MB ([server recommendations](https://woocommerce.com/document/server-requirements/)).
- With checkout in a container but the database still on D1 (`docs/approach-c-checkout.md`), every query is a network round trip, about 46 ms. A checkout makes about 390 of them: 42 s.
- So the database goes into the container, next to PHP.

## Design

- **Container:** stock WordPress 7.1.4, WooCommerce 11.2.1 and the official SQLite plugin (`sqlite-database-integration`, its own `db.php`), on a real SQLite file at `/data/wordpress.sqlite`. PHP 8.3, 256 MB for PHP: PHP's built-in server at first, PHP-FPM behind nginx since issue #99 (section below). The spike started on `basic` with 2 workers; `deploy/deploy.sh` now uses `standard-1` with 4 workers and the APCu object cache (sections below).
- **Durability: Litestream to R2.** The container disk is lost when it sleeps. On start, `litestream restore` gets the database from R2 if a replica exists; otherwise the entrypoint installs WordPress and WooCommerce. Then `litestream replicate -exec` runs the web server (`php -S` at first; `container/c1-serve.sh` with PHP-FPM and nginx since issue #99) and sends every change to the R2 bucket `wp-woo-c1-db` (1 s sync interval). The S3 key can touch only that bucket.
- **The Worker in front:**
  - Static files come from Workers static assets.
  - Uploads come from R2 (`wp-woo-c1-media`).
  - Storefront pages for visitors with no state come from Workers Cache (the Storefront entrypoint; see "Storefront edge cache"). Cart, checkout, account, admin and REST are never cached.
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

Under load the chain stops. With wp-c1's database (63 pending actions at the start), the first runner request took 18.6 s and 4.1 CPU s (one batch of emails), 9 more followed about 6 s apart, and then none for the remaining 7 minutes. Pending actions went from 63 to 137: the queue was larger at the end than at the start. So with WP-Cron off, order emails can wait without limit on a busy store. The fix is the local queue runner (section "Queue runner" below).

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

## Instance size: standard-2 (2026-11-06)

Issue #39. The same seeded data again (wp-c1's database, replica path `swap3`), a cold start on a new container, `OBJECT_CACHE` and `PHP_WORKERS` at their defaults (APCu on, 8 PHP workers). Two variables changed against the standard-1 run: the vCPU (1/2 to 1) and the PHP workers (4 to 8). The container log tells them apart (below).

The container is a real `standard-2`: 6.04 GiB of memory (standard-1: 4.07 GiB), and under load the cgroup used 0.99 vCPU (p50) with 0 % steal time (standard-1: 0.5 vCPU and 50 % steal).

| Users | standard-1: rps | standard-1: browse p50 / p95 | standard-1: checkout p50 / p95 | standard-2: rps | standard-2: browse p50 / p95 | standard-2: checkout p50 / p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2.39 | 0.39 / 0.88 s | 0.54 / 0.64 s | 2.63 | 0.37 / 0.49 s | 0.49 / 0.53 s |
| 5 | 3.17 | 1.66 / 2.23 s | 2.70 / 3.08 s | 7.04 | 0.78 / 1.02 s | 1.13 / 1.29 s |
| 10 | 3.05 | 3.75 / 6.26 s | 4.27 / 6.62 s | 6.30 | 1.69 / 2.52 s | 2.76 / 4.00 s |
| 25 | 3.01 | 7.91 / 10.3 s | 9.19 / 12.8 s | 6.42 | 3.99 / 5.75 s | 5.11 / 6.86 s |
| 50 | 2.97 | 15.5 / 17.9 s | 16.6 / 19.6 s | 6.17 | 7.71 / 10.4 s | 8.96 / 11.1 s |
| 100 | 3.09 | 26.9 / 35.9 s | 29.2 / 36.5 s | 6.25 | 14.2 / 18.7 s | 15.5 / 19.1 s |

Both with APCu, 0 errors. Results: `deploy/results/bench-runner-20261106T002159Z-2ca71a.json` (standard-1), `deploy/results/bench-runner-20261106T004014Z-abe38f.json` (standard-2).

From the container log:

| | standard-1 | standard-2 |
| --- | --- | --- |
| vCPU used, p50 | 0.51 | 0.99 |
| Requests per second served | 2.97 | 5.88 |
| CPU s per request | 0.153 | 0.148 |
| In flight, mean / max | 4.2 / 6 | 6.7 / 9 |
| Accept backlog, max | 90 | 82 |

- **The ceiling is the CPU again, not the PHP workers.** The CPU is at the 1.0 cap, and on average 6.7 of the 9 PHP processes (8 workers and the server process) are in flight; about 3 sleep. With a worker ceiling, the CPU would be under 1.0 and all 9 busy.
- **The CPU per request does not change with the instance.** So the ceiling is about vCPU / 0.15 s: about 3 requests per second on standard-1 and about 6 on standard-2 (measured), about 12 on standard-3 (2 vCPU) and about 24 on standard-4 (4 vCPU) (predicted, not measured).
- **The cost.** [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/) (page updated 2026-10-05, read 2026-11-06): memory $0.0000025 per GiB-second and disk $0.00000007 per GB-second for the provisioned size while the container runs; CPU $0.000020 per vCPU-second while it is busy. Awake and idle: about $0.038 an hour on standard-1 (4 GiB, 8 GB), about $0.057 on standard-2 (6 GiB, 12 GB). At full load, add about $0.036 (standard-1) or $0.072 (standard-2) an hour of CPU. Workers Paid includes 25 GiB-hours, 375 vCPU-minutes and 200 GB-hours a month.

## Queue runner: WP-Cron from inside the container (2026-11-06)

Issue #45. `QUEUE_RUNNER=local` (the default; `loopback` keeps the old path).

### What changed

- `container/entrypoint.sh` requests `http://127.0.0.1/wp-cron.php` every `CRON_SECONDS` while the container is awake (60 at first, 10 since the head-of-line finding below). The request runs in PHP's own server, so it uses the same APCu cache as the visitor requests, and it does not go out through the Worker. Action Scheduler then processes batches for up to `AS_TIME_LIMIT` seconds (30 at first, Action Scheduler's default; 5 since the head-of-line finding): through its WP-Cron event when that is due (once a minute), and otherwise through one run that `php/c1-queue.php` starts in the same request, so the queue keeps about the same share of time with short runs.
- `php/c1-queue.php` turns off Action Scheduler's async loopback (`action_scheduler_allow_async_request_runner`). No request holds a PHP process with `sleep( 5 )` any more.
- `router.php` does not count a `wp-cron.php` request from 127.0.0.1 as activity, so the loop does not keep an idle container awake. The queue waits while the container sleeps and runs again on the next start.
- Not php-cli: a php-cli process has its own, empty APCu, so it would write past the cache that the server's processes read.
- The URL has no `?doing_wp_cron=`. With a key that `spawn_cron()` did not set, `wp-cron.php` returns at once and runs nothing (seen locally: 3 runs, 0 actions).

Before this change no WP-Cron event ran on c1 (`DISABLE_WP_CRON`). Now the other events run too: scheduled posts, WooCommerce session clean-up and scheduled sales.

**Updates.** `php/c1-queue.php` also removes WordPress core's update checks (`wp_version_check`, `wp_update_plugins`, `wp_update_themes`, `wp_maybe_auto_update`). They send the site's versions and plugin list to api.wordpress.org, and an update cannot be installed in place: the code is in the image. Updates arrive with a new image: change the pins in `spikes/c1-woo-container/build.sh` (WordPress, WooCommerce, the SQLite driver, the object cache drop-in) and in `tests/plugins/suite.txt`, then run `deploy/deploy.sh`. So "no update check" does not mean "never updated"; it means you update by rebuilding.

### Measured

- Locally (php -S on the c1 build, the image's SQLite driver, 230 Store API checkouts): 467 actions pending after the load; one `wp-cron.php` run took 18.8 s and left 1.
- Live, before the load run (wp-c1-perf, `swap4`: wp-c1's database with 63 pending actions): the first local run took 11.8 s wall and 5.2 CPU s, and pending went from 63 to 2. The next run, about 72 s later, took 0.05 s. 0 loopback requests.

So the store starts the load run with an empty queue. That is the change working: the backlog is done in the background, not by visitor requests.

### Under load

The same seeded data as the APCu run on `standard-1` (wp-c1's database, replica path `swap4`), APCu, 4 PHP workers. That run (`swap2`) used the loopback. Result: `deploy/results/bench-runner-20261106T010848Z-6f798b.json`. This run started with a warm cache (the container stayed awake from its start) and the APCu run started cold, which helps this run a little.

| | loopback (`swap2`) | local runner (`swap4`) |
| --- | --- | --- |
| Pending actions at the start / end of the run | 63 / 193 | 2 / 20 |
| Checkouts in the run | 190 | 184 |
| Loopback runner requests | 1 | 0 |
| Local cron runs in the run | 0 | 6 |

The loopback let the queue grow by 130. The local runner kept up with 184 checkouts and ended with 20, about one minute of orders.

The cost, from the container log: the 6 runs took 2.4 to 28.5 s wall and 0.8 to 2.7 CPU s each, about 80 s apart. Together they held 0.18 of the 5 PHP processes on average, and they used 5.4 % of the CPU (11.9 of 219 CPU s). That is the work of sending the order emails. With the loopback it was not done, so the queue grew.

| Users | loopback: rps | loopback: browse p50 / p95 | loopback: checkout p50 / p95 | local: rps | local: browse p50 / p95 | local: checkout p50 / p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2.39 | 0.39 / 0.88 s | 0.54 / 0.64 s | 2.53 | 0.38 / 0.51 s | 0.52 / 0.61 s |
| 5 | 3.17 | 1.66 / 2.23 s | 2.70 / 3.08 s | 2.91 | 1.76 / 2.88 s | 2.73 / 3.92 s |
| 10 | 3.05 | 3.75 / 6.26 s | 4.27 / 6.62 s | 2.76 | 3.79 / 5.38 s | 5.36 / 6.68 s |
| 25 | 3.01 | 7.91 / 10.3 s | 9.19 / 12.8 s | 2.84 | 7.83 / 10.1 s | 9.60 / 11.5 s |
| 50 | 2.97 | 15.5 / 17.9 s | 16.6 / 19.6 s | 2.77 | 15.2 / 19.0 s | 17.0 / 19.7 s |
| 100 | 3.09 | 26.9 / 35.9 s | 29.2 / 36.5 s | 2.87 | 28.5 / 33.4 s | 29.0 / 36.4 s |

0 errors in both. The CPU for each storefront request did not change (0.153 and 0.155 s). The ceiling went from about 3.05 to about 2.85 requests per second: the CPU that now sends the emails.

## Storefront edge cache (2026-11-06)

Issue #58. WordPress and the theme still render every page (not headless). The Worker keeps storefront HTML at the edge for visitors with no state, so plain browsing does not reach the container.

### What was wrong before (measured)

c1 already had an edge cache: the default entrypoint was cached (Workers Caching) with `Vary: Cookie` for logged-out pages. `tests/load/load.py` never used it, because every browse request had a `?nocache=` parameter. Measured on wp-c1-perf with `tests/edge_check.py` (reads with no `nocache`), 11 of 16:

1. **Real shoppers did not hit the cache.** WooCommerce order attribution sets `sbjs_*` cookies with JavaScript in every browser. Workers Caching does not put the Cookie header in the cache key, and with `Vary: Cookie` it compares the whole value ([cache keys](https://developers.cloudflare.com/workers/cache/cache-keys/), [Vary](https://developers.cloudflare.com/workers/cache/configuration/), read 2026-11-06). So every visitor was a separate variant: a visitor with `sbjs_*` cookies got MISS.
2. **Purges did not reach the cache.** A price change, a sold-out product and a new tagline were still old after 20 s. The purge ran in the outbound handler (the `ContainerProxy` entrypoint), and a purge reaches only the cache of the entrypoint that calls it ([purge](https://developers.cloudflare.com/workers/cache/purge/)). A change showed only after the TTL (120 s, then up to 600 s stale).
3. **The browser kept the page:** `Cache-Control: public, max-age=120`. After an add to cart, the browser could show the old page.
4. **Every checkout asked for a purge** (measured locally on the c1 build: 80 checkouts, 80 purges: the order post and the order notes). The purge limit is 5 a minute, 25 at once, per account, for all sites ([purge limits](https://developers.cloudflare.com/cache/how-to/purge-cache/), Free tier, which Workers Caching uses).

Correct before: a cart cookie or a login cookie got BYPASS, and after a classic add to cart (`?add-to-cart=`, which sets `wp_woocommerce_session_*`) the next page was BYPASS.

### The design

- **Gateway:** the default entrypoint is not cached (`[exports.default.cache] enabled = false`). It sends a request to the cache only when it is a GET or HEAD, has no cookie that carries state, and is not an admin, login, cart, checkout, account, `wc-api` or REST request (no `rest_route`, `wc-ajax`, `add-to-cart`, `preview` or `nocache` parameter). The state cookies are found BY NAME: `wordpress_logged_in_`, `wordpress_sec_`, `wp-postpass_`, `comment_author_`, `wp-settings-`, every `woocommerce_` cookie and `wp_woocommerce_session_`. Other cookies (order attribution, analytics) do not change the page.
- **Storefront:** a second entrypoint, cached (`[exports.Storefront.cache] enabled = true`, Wrangler 4.107.0 or later). The gateway calls it through `ctx.exports` WITHOUT the Cookie header, so the cache key is the path and the query. It keeps a 200, 301 or 404 with no `Set-Cookie` and no `private` or `no-store` from WordPress (WooCommerce sends `no-cache` on the cart and checkout pages). The edge time goes in `cloudflare-cdn-cache-control` (Cloudflare removes it before the browser): `PAGE_CACHE_TTL` (120 s) fresh, then `PAGE_CACHE_SWR` (600 s) stale while a new copy renders. The browser gets `Cache-Control: no-cache`.
- **Purge:** `edge-cache.php` sends `worker.internal` a purge; the outbound handler asks the Store object, which calls `Storefront.purge()` through `ctx.exports`, so the purge runs in the Storefront entrypoint.
- **What purges:** content changes as before (posts, pages, products, terms, menus, theme, options), but not orders, refunds, order notes, or a product inside an order request (a checkout or a payment callback). A change of stock status (in stock, out of stock) always purges. The cost: a stock QUANTITY shown on a page can be up to one TTL old after an order; whether a product can be bought is always correct. Measured locally: 69 checkouts, 0 purges (80 before); a price change, a review, the site title, a sell out and a product back in stock each purge; a quantity change in a checkout and an order note do not.
- **Measurement:** `php/c1-purge-log.php` writes one line per purge request (the hook), `/_stats.php?what=purge` returns it. `tests/load/load.py` `LOAD_MODE`: `nocache` (the default: the site's own render), `cached`, `cached-sbjs` (as a browser with order attribution), with the `cf-cache-status` counts per step.

### Correctness (live, on wp-c1-perf)

- `tests/edge_check.py`, 16 of 16: a visitor with `sbjs_*` cookies gets HIT; a cart cookie and a login cookie do not get the edge copy; the browser gets `no-cache`; after a classic add to cart, the next product page is not the edge copy; a price change, a sold-out product and a tagline change reach visitors through the cache, each then 5 reads with no old value. Alone on a quiet site, a change showed in 1.3 to 1.9 s. When changes come less than 15 s apart (as in the gate), each waits for the next purge interval: 12 to 15 s.
- `tests/purge_burst.py`, 3 of 3: 20 tagline saves in 7.5 s; the last one showed 9.7 s after the first save; 1 purge sent, 20 deferred, none refused.
- `tests/cache_check.py` 13 of 13, `tests/woo.py` 12 of 12, `tests/break.py` 3 runs of 3 (27 of 27 each).

**Purge budget.** The gate scripts first sent 106 purges in 7 minutes, and the later ones were refused, so `break.py` failed "publishing a post purges the cached page" in 2 of 3 runs. The Store object now runs at most one purge per `PURGE_INTERVAL_MS` (15 s) per site: a purge asked for inside the interval runs once at its end, and a refused purge is tried once more. The deferred purge is a Container schedule (a Durable Object alarm with its row in SQLite), and its state is in the object's storage, so it runs after an eviction or a reset too. Over the whole gate: 21 sent, 116 deferred, 0 refused. `/_store-info` shows the counts. Limits: 15 s is 4 a minute for one site; several busy sites on one account can still pass 5 a minute, and then the retry and the TTL are the backstop.

**Noise options.** Under load, WooCommerce's own bookkeeping options emptied the cache: `wc_pending_batch_processes` (in checkouts and cron runs), `wc_batch_*` (order log deletion) and `update_comment_type.lock`. `edge-cache.php` skips a named list: `wc_pending_batch_processes`, `wc_batch_*`, `action_scheduler_*`, and names that end in `.lock` or `_lock`. Store options such as `woocommerce_currency`, the site title and the tagline still purge (checked locally, one process for each option, and live with `edge_check` after the load run).

### Measured

The same seeded data each time (wp-c1's database), `standard-1`, APCu, the local queue runner, `tests/load/load.py` 1 to 100 users, 60 s per step, BUYERS 0.2, from the Vultr runner. Before: the queue runner run (`LOAD_MODE` nocache, so every page is rendered: `deploy/results/bench-runner-20261106T010848Z-6f798b.json`). After: `cached-sbjs`, the browser case with order attribution cookies, before the noise filter (job 1, `deploy/results/bench-runner-20261106T031515Z-253443.json`) and with it (job 2, `deploy/results/bench-runner-20261106T033126Z-4ee5ce.json`).

| Users | before: browse p50 / p95 | job 1: browse p50 / p95 | job 2: browse p50 / p95 | before: rps | job 2: rps |
| --- | --- | --- | --- | --- | --- |
| 1 | 0.38 / 0.51 s | 0.08 / 0.43 s | 0.08 / 0.42 s | 2.53 | 4.09 |
| 5 | 1.76 / 2.88 s | 0.06 / 0.11 s | 0.06 / 0.11 s | 2.91 | 8.57 |
| 10 | 3.79 / 5.38 s | 0.05 / 0.11 s | 0.05 / 0.11 s | 2.76 | 6.18 |
| 25 | 7.83 / 10.1 s | 0.05 / 0.12 s | 0.05 / 0.16 s | 2.84 | 7.19 |
| 50 | 15.2 / 19.0 s | 0.07 / 6.51 s | 0.08 / 0.41 s | 2.77 | 7.19 |
| 100 | 28.5 / 33.4 s | 0.21 / 1.10 s | 0.17 / 0.64 s | 2.87 | 8.05 |

0 errors in all three. Job 2 cache status per step (`cf-cache-status` of the browse requests): 1 user 98 HIT, 23 MISS (a cold cache); 5 users 304 HIT, 1 MISS; then HIT and UPDATING only (UPDATING is a stale copy served while one new copy renders in the background). Job 1's p95 of 6.5 s at 50 users was 26 misses after two noise purges, each waiting behind the checkouts in the container's queue; the filter removed them.

So browse p50 is under 0.3 s at every step. Browse p95 is over 0.3 s at 1 user (the cold cache), at 50 users (0.41 s) and at 100 users (0.64 s). At 100 users the client itself was busy: 100 Python threads on the runner's 2 vCPU, a 1-minute load of 1.49. Those requests were edge answers (0 MISS), so the p95 there is partly the client.

**The container now does the checkouts.** In job 2, 64 storefront page views reached PHP in 508 s (the before run: 784); a HIT never reaches it. The container served the shoppers who buy: 526 carts, 526 adds to cart and 526 checkouts in about 8.5 minutes (the before run: 184 each), with the CPU at its cap (0.48 vCPU). Checkout p50 per step: 0.47, 2.53, 4.36, 8.88, 17.6, 26.3 s. That is about one checkout a second on half a vCPU. **Checkout capacity is the instance type**: on `standard-2`, c1 served twice as much (section above). It is a sizing number, not a defect. The order email queue cannot keep up at that order rate either (pending 63 to 290); a real store has far fewer orders a second.

## Bounded queue: a fast answer under overload (2026-11-06)

Issue #39. With the storefront at the edge, the container sees the shoppers who buy: the cart, add to cart, checkout, and the pages the edge does not have.

### Where the wait was (measured first)

In the 100-shopper step of the edge cache run (job 2, `deploy/results/bench-runner-20261106T033126Z-4ee5ce.json`), a checkout took 3.14 s in PHP (p50, router log) and 26.3 s at the client. The accept queue of port 80 (the 2 s sampler) held 56 connections (p50; max 95). 56 at about 2.4 requests per second is about 23 s: all of the difference. So the wait was in PHP's accept queue, which has no limit, not in the Worker to container path.

### The change

Every request to the container passes through the Store object's `fetch`, so the object counts what the container has in hand. When `QUEUE_LIMIT` (16: the 5 PHP processes and about 11 waiting) are in hand, a request that can wait gets `503` at once, with `Retry-After` (`RETRY_AFTER`, 5 s), `x-c1-shed: 1` and `no-store`: a WordPress REST error (`c1_busy`) for the Store API, a short HTML page otherwise. The requests that can wait: a storefront page the edge does not have, `?add-to-cart=`, the cart and account pages, and the Store API except checkout. Always let in: the checkout (Store API and `wc-ajax=checkout`, the checkout page), payment callbacks (`wc-api`), `wp-admin`, `wp-login.php`, other REST (admin and API clients) and the operator endpoints. Nothing in flight is stopped. `QUEUE_LIMIT=0` turns it off. `/_store-info` shows `queue` (limit, inflight, maxInflight, admitted, shed).

### Measured

Each arm on its own copy of wp-c1's database, `standard-1`, APCu, `LOAD_MODE=cached-sbjs`, BUYERS 0.5 (to overload the container), 1 to 100 users. The same image in both arms; only `QUEUE_LIMIT` changes. BEFORE: `QUEUE_LIMIT=0` (`deploy/results/bench-runner-20261106T035439Z-ffe08b.json`, runner 2 vCPU). AFTER: `QUEUE_LIMIT=16`, run from a 4 vCPU runner (`deploy/results/bench-runner-20261106T044138Z-56aa96.json`; the result header still says the old plan, because the box was resized in place: the client CPUs per step say 4).

| Users | BEFORE checkout p50 / p95 | BEFORE orders | AFTER checkout p50 / p95 | AFTER orders | AFTER sheds (cart, add, page) | AFTER client load |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.43 / 1.04 s | 61 | 0.41 / 0.53 s | 65 | 0 | 0.00 / 4 |
| 5 | 2.8 / 4.1 s | 74 | 2.7 / 4.0 s | 74 | 0 | 0.15 / 4 |
| 10 | 3.8 / 6.4 s | 82 | 3.8 / 6.3 s | 81 | 0 | 0.32 / 4 |
| 25 | 9.6 / 17.7 s | 85 | 6.1 / 8.6 s | 85 | 99, 10, 2 | 0.46 / 4 |
| 50 | 17.4 / 25.2 s | 104 | 5.6 / 8.2 s | 76 | 343, 39, 1 | 1.36 / 4 |
| 100 | 23.6 / 55.9 s | 153 | 4.9 / 8.4 s | 71 | 712, 81, 0 | 8.09 / 4 (client limited) |

0 errors other than the 503s in both arms, and every checkout that started succeeded. In AFTER, a shed cart or add was answered at once (cart p50 0.05 to 0.09 s from 25 users); admitted carts and adds had a p95 of 3.5 to 5.8 s.

From the container log (each arm's measured window):

| | BEFORE | AFTER |
| --- | --- | --- |
| Completed orders per minute | 65.0 (559 in 516 s) | 68.7 (452 in 395 s) |
| CPU s per completed order | 0.43 | 0.40 |
| Most requests in the container (maxInflight) | 107 | 18 |
| Accept queue, max / mean | 98 / 23 | 8 / 2.9 |
| CPU used, p50 | 0.49 vCPU | 0.49 vCPU |
| Checkout time in PHP, p95 | 3.16 s | 3.02 s |
| CPU s by class: checkout, cart, add, pages and cron | 154, 23, 25, 36 | 118, 23, 19, 21 |

- **Checkout waits less.** At 25 and 50 users (a clean client), checkout p95 fell from 17.7 to 8.6 s and from 25.2 to 8.2 s. The 100-user step is client limited (a load of 8 on 4 CPUs); its 8.4 s is an upper bound, and it agrees with the clean steps. A checkout cannot be shed, but the shopper must first get a cart and an add to cart in; when checkouts fill the container, new carts and adds are shed, so checkouts arrive only as fast as the container finishes them.
- **The container finishes as many orders a minute** (68.7 against 65.0, at the same CPU cap). The limit adds no capacity. It decides who waits: BEFORE, every buyer waited (up to 56 s); AFTER, the buyers beyond the limit are told to come back.
- **The trade: shed shoppers are lost sales unless they come back.** At 50 users 382 buy attempts were shed, and at 100 users 793 (each told to retry in 5 s). BEFORE served all of them, slowly; a real shopper who waits 56 s for a checkout often leaves, so BEFORE's count is an upper bound. 130 shoppers got a cart and then had the add to cart shed: work spent on a shopper who is turned away. Letting a shopper who is already in a cart flow pass the limit would keep that work; it is the next step.
- **A page the edge does not have can be shed too:** 3 page views of 1,689 got the busy page at 25 and 50 users.
- **The client.** The first AFTER run (`deploy/results/bench-runner-20261106T040726Z-92de18.json`, kept as a record, not used for the numbers) retried a shed buyer at once, and the runner, not the site, became the limit (a load of 3.4 to 26 on 2 CPUs from 25 users). `load.py` now waits `Retry-After` after a 503, as a shopper told to come back would. With that client, a second AFTER run from the 2 vCPU runner (`deploy/results/bench-runner-20261106T042703Z-bcf56a.json`) gave the same container result (67.0 orders a minute, maxInflight 18, accept queue at most 8) and the same 25-user step (82 orders, checkout p95 8.8 s).

Checkout capacity is still the instance type: about 1.6 checkouts a second fit in half a vCPU. The limit keeps the wait short; a larger instance serves more buyers.

### Who passes the limit (refined, measured)

The first version shed a shopper's add to cart after letting the cart in (130 carts in the run above), and let every non-Store REST route through. Now `admission()` in `worker.js` has three classes:

- **always**: checkout, payment callbacks (`wc-api`), `wp-admin`, `wp-login.php`, the operator endpoints, a request from a logged-in user (a `wordpress_logged_in_` cookie), and REST with credentials (an `Authorization` header: application passwords).
- **flow**: a shopper already in a cart flow: a `Cart-Token` header (the Store API), or a WooCommerce session cookie (`wp_woocommerce_session_*`, or `woocommerce_items_in_cart` that is not 0). It passes the limit, so a cart that got in is not turned away at the add to cart. `/_store-info` counts how often (`queue.flow`).
- **shed**: everything else, including a new shopper's first cart request and anonymous REST (before, an anonymous client could pass the limit through any non-Store route, for example `/wp-json/wp/v2/posts`).

30 unit cases for `admission()` pass. **A forged flow is bounded.** The Worker cannot verify a `Cart-Token` or a WooCommerce cookie (WooCommerce signs the token in PHP), so a client can send `woocommerce_items_in_cart=1` and be treated as in a flow. A flow request therefore has its own, higher cap: `FLOW_LIMIT` (default 2 x `QUEUE_LIMIT`, never below it). Between the two caps an honest shopper's add to cart still gets in; above `FLOW_LIMIT` a flow request is shed too, so a forged cookie can push the container to at most `FLOW_LIMIT` in hand. `/_store-info` counts `queue.flow` (flow requests above `QUEUE_LIMIT`) and `queue.flowShed`. 11 unit cases for the decision (`shouldShed()`) pass, and they fail when the cap is removed. A signed admit cookie from the Store object would make a flow verifiable; it is the follow-up if the cap proves too loose. The limit is still not an access control: protection against abuse belongs to rate limiting at the edge.

The count of requests in the container now lasts until the response body has been read to the end, not only until the response headers (checked in local workerd: 1 in flight while a body streamed, 0 after). For c1 the two were close, because PHP buffers the page (`query-count.php`) and static files do not come from the container, but a large streamed response would have been counted too briefly.

**Measured.** The same overload run (`cached-sbjs`, BUYERS 0.5, 2 vCPU runner), twice, each on its own copy of wp-c1's database: swap12 (the cart-flow code; `deploy/results/bench-runner-20261106T065415Z-e3a0d8.json`) and swap14 (the same code; `deploy/results/bench-runner-20261106T075355Z-b181c4.json`).

| Users | AFTER #82: orders, checkout p95 / p99 | swap12: orders, checkout p95 / p99 | swap14: orders, checkout p95 / p99 |
| --- | --- | --- | --- |
| 25 | 82, 8.8 / 11.1 s | 91, 8.7 / 32.2 s | 104, 7.5 / 9.1 s |
| 50 | 78, 8.5 / 8.8 s | 89, 8.5 / 28.6 s | 97, 7.8 / 16.7 s |

| Container log | AFTER #82 (2 vCPU rerun) | swap12 | swap14 |
| --- | --- | --- | --- |
| Carts let in / adds | 601 / 443 | 510 / 510 | 551 / 551 |
| Completed orders per minute | 67.0 | 61.1 | 74.3 |
| CPU s per completed order | 0.41 | 0.40 | 0.38 |
| maxInflight / flow above 16 / flowShed | 18 / - / - | 20 / 112 / 0 | 21 / 119 / 0 |
| Accept queue max | 8 | 10 | 11 |
| Checkout in PHP p99 | 3.13 s | 3.06 s | 2.84 s |

- **No cart is turned away at the add any more** (0 against 158), and more orders finish at the clean steps (25 and 50 users). A flow request never came near `FLOW_LIMIT` (at most 21 in hand).
- **The checkout p99 of about 30 s on swap12 was not the flow change.** With at most 21 in hand and an accept queue of at most 11, the container cannot add 30 s. `load.py` now lists every request of 10 s or more with its time to the headers (TTFB) and its cf-ray. On swap14 all 4 such requests had TTFB equal to the total (the headers were late, not the body), and each was matched in the container log: PHP started it only when a local queue-runner cron run (`wp-cron.php`, 15 to 22 s) ended, and then took 0.1 to 0.5 s. During the cron run the accept queue was empty and 4 of the 5 PHP processes were idle. **That is head-of-line blocking in PHP's built-in server:** a `php -S` process accepts connections and serves them one at a time, so a connection that lands on the process running a long cron run waits for it, while other processes wait for work. swap12's cron runs were 27 to 30 s, the size of its tail. The fix belongs to the queue runner (issue #45: shorter Action Scheduler batches), and a server with one process per request (PHP-FPM) would end it for good; that is the first measured reason for FPM, a separate decision.
- The 100-user steps were client limited (a load of 1.3 to 2.1 on 2 CPUs) and are not used.

### Short queue runs (2026-11-06)

The head-of-line finding (section "Who passes the limit"): a local cron request that ran Action Scheduler for 15 to 30 s held the shoppers whose connection landed on that PHP process. Now `AS_TIME_LIMIT` (5 s) bounds a run, `CRON_SECONDS` is 10, and `php/c1-queue.php` runs one batch in each local cron request in which Action Scheduler's own WP-Cron event (once a minute) is not due, so the queue keeps about the same share of time (5 s of every 15 s, against 30 s of every 90 s).

Measured with the same overload run (`cached-sbjs`, BUYERS 0.5, 2 vCPU runner) on its own copy of wp-c1's database (swap15, `deploy/results/bench-runner-20261106T081530Z-dace4f.json`), the cart-flow code otherwise unchanged:

| | swap14 (30 s runs) | swap15 (5 s runs) |
| --- | --- | --- |
| Requests of 10 s or more | 4 | 5 |
| ... waiting behind a cron run | 4 (15 to 22 s each) | 0 |
| Cron runs in the load window, longest | 15 to 22 s | 4.87 s (31 runs, 0 over 6 s) |
| Checkout p99 at 25 / 50 users | 9.1 / 16.7 s | 11.1 / 10.5 s |

- **No request waited behind a cron run.** The 5 slow requests (10.2 to 11.1 s, all checkouts) had TTFB about equal to the total and waited about 7 s with all 5 PHP processes running and 6 to 8 connections in the accept queue: ordinary CPU queueing at the bounded limit (about 16 in hand at about 2.4 requests per second), not head-of-line blocking.
- **The queue still drains.** Pending actions: 13 at the start, 146 at the end of the load (at about 1 order a second the queue falls behind while the load lasts), then 77, 19 and 13 at 19, 39 and 60 s after the load, and 13 from then on (actions not yet due). There is no run with 30 s queue runs at BUYERS 0.5 to compare this with; the BUYERS 0.2 runs with 30 s runs (section "Queue runner") ended with the queue larger than at the start.
- **Open question: a sale that lasts longer than the test.** During the load the queue grew by about 133 actions in 459 s (about 1 order a second, far above a real store), and it caught up in about 60 s after the load stopped. So at that order rate the queue processes less than arrives: a sustained sale longer than the test would carry a growing backlog of order emails, and how long it would take to catch up is not measured. The levers are the queue's share of time (`CRON_SECONDS`, `AS_TIME_LIMIT`) and the instance size.
- Before the load, Action Scheduler's minute event ran 7.2 s once against the 5 s limit: it stops when the next action would likely pass the limit, so a run can overshoot by its last actions. Under load no run passed 4.9 s.
- One process per request (PHP-FPM) would end this kind of tail entirely; it is a separate decision.

## A stuck container (2026-11-06)

Issue #93. A container instance (atl16) answered no request at all, not even a static file (`/_boot.txt`), and it survived a Worker deploy (the image was unchanged, so no new instance rolled out), a stop (`/_store-stop` timed out with `still_running`) and a kill (`kill=1` returned nothing). The Containers API has no instance delete. Its health field read `healthy 0, active 1`, but a working instance reads the same, so that field is not a sign of a stuck instance. The recovery: deploy once with a changed container setting (for example `INSTANCE_TYPE`); that rolls out a new instance.

While it hung, every request waited until the client gave up, held its bounded-queue slot (a client that gives up does not end the request in the Store object), and the deploy waited 900 s for a first answer.

### The change

- **Container fetch timeout.** A shopper request (a page, the cart, the checkout, a payment callback) waits at most `CONTAINER_TIMEOUT_S` (60 s, about 5 times the checkout p99 under overload) for the container's response headers. Then the Store object answers `504` (`c1_timeout`, `no-store`, `x-c1-timeout: 1`) and gives the queue slot back; `/_store-info` counts `queue.timedOut`. A body that already streams is not cut. Exempt, because their requests can be long and legitimate (an import, a large export): `wp-admin`, `wp-login.php`, the operator endpoints (`/_*`), a logged-in user, and REST with an `Authorization` header. `0` turns the timeout off.
- **A checkout that gets the 504 can still complete in PHP afterwards.** The shopper then sees an error for an order that exists, and a retry can place a second order. At 60 s, far above the p99, that happens only with a container that really does not answer, and an error is the smaller harm than a page that never ends. Payment callbacks are retried by the payment gateways, so a 504 is safe there.
- **The deploy stops at a stuck container.** `c1_wait` reads the answer of its one stop: `still_running` (the container did not stop in 30 s) fails the deploy at once, with the recovery in the message. `c1_check` also requires a static file (`/_boot.txt`) to answer 200 within 15 s, and prints the result.
- **A stuck instance for testing:** `/_kill.php?sig=STOPPHP` (spike token) sends SIGSTOP to every PHP process. The port stays open and nothing answers.

### Measured

With the real `Store.prototype.fetch` code and a stub container that never answers (limit 1 s): a hung checkout got 504 after 1.02 s with its slot released; a hung `wp-admin` request was not cut; an answered page passed. The test is `spikes/c1-woo-container/tests/timeout-test.mjs` and runs in CI. It has an outer deadline of 15 s: without the timeout it fails with exit 1 after 15 s, and without the `wp-admin` exemption it fails 2 of 3 checks.

On wp-c1-perf (swap16, `CONTAINER_TIMEOUT_S=10` for a short test), after `sig=STOPPHP`:

| Request | Answer | Time |
| --- | --- | --- |
| Store API checkout (3) | 504, `x-c1-timeout` | 10.15 to 10.20 s |
| A page (2) | 504, `x-c1-timeout` | 10.18 to 10.20 s |
| `/wp-admin/` as admin (exempt) | no answer (the client gave up) | 30.1 s |

`/_store-info` after: `timedOut` 5, one exempt request still in hand.

A deploy of the same configuration onto that stuck container failed after 141 s (60 s of rollout wait, 30 s of stop, the rest the build and upload), with the stop answer `still_running: true, reset: false` and the recovery message. Before, the same case waited 900 s. Note that the new Worker version was already deployed when the stop failed: the site ran the new Worker code against the stuck container until the recovery deploy.

Recovery from the test: a deploy with `INSTANCE_TYPE=standard-2` rolled out a new instance (first answer 200 after 7 s, the static-file probe 200), and a deploy back to `standard-1` with the default `CONTAINER_TIMEOUT_S` came up in 11 s; `/_store-info` then read `timeoutS: 60`.

## PHP-FPM behind nginx (issue #99)

The head-of-line finding (section "Who passes the limit") was a property of PHP's built-in server: a `php -S` process accepts connections and serves them one at a time, so a shopper whose connection lands on a process that runs a long request waits for it. Short queue runs (#95) bound that wait. PHP-FPM removes it: only a free child accepts a request, so a slow request holds its own child and nothing else.

**What runs in the container** (the image is `php:8.3-fpm-trixie`):

- Litestream is the parent, as before: `litestream replicate -exec /usr/local/bin/c1-serve.sh`.
- `container/c1-serve.sh` starts PHP-FPM and nginx and supervises them.
  - If one of them exits, it stops the other and exits 1. Litestream then exits and the container ends.
  - On SIGTERM (Litestream forwards its own signal to the exec child), it sends SIGQUIT to both, so requests in progress finish. After `STOP_GRACE_S` (10 s) it sends SIGKILL. Then Litestream does its final sync, inside the 30 s that `/_store-stop` waits.
- `container/php-fpm-c1.conf`, the pool:
  - `pm = static`, with `PHP_WORKERS` children. It listens on `127.0.0.1:9000`.
  - `clear_env = no`, because the PHP files read the environment.
  - No request time limit: the Worker cuts shopper requests at `CONTAINER_TIMEOUT_S`.
  - The children run as `www-data` (`php -S` ran as root), so `wp-content` belongs to `www-data` in the image.
- `container/nginx.conf`:
  - It routes as `router.php` did: a static file as it is, a `.php` file runs, a directory goes to its `index.php` (301 to the trailing slash first), and everything else goes to `/index.php`.
  - `fastcgi_read_timeout` is 3600 s, so admin imports and exports are not cut.
  - Its access log is the idle watchdog's mark (`/tmp/last-request`). It skips `/ping`, `/_boot.txt`, the FPM ping and status, and the local `wp-cron.php`.
- `container/c1-prepend.php` (`auto_prepend_file`) keeps the request log and the `x-c1-pid` header.
- The sampler counts the PHP-FPM children by state (not the master). It reads the backlog on port 9000 (requests that no free child took yet), and it now records the PSS memory of PHP-FPM and nginx (`c1_stats.py`: `pss_mib`).
- `/_stats.php?what=fpm` returns the pool status (`fpm_get_status()`, from inside the child, so it needs no second free child).

**Why nginx.** FPM speaks only FastCGI, and the Container must answer HTTP. nginx is a Debian package (signed through apt) with a maintained FastCGI client, and one worker process is enough. Caddy is a Go binary of about 40 MB to pin. A proxy of our own would need a FastCGI client that we would have to write. Most static files never reach the container, because the Worker serves them from static assets.

**APCu.** One APCu segment per FPM master, shared by all children. This is the same shape as `php -S`, whose workers fork from one server process after APCu is set up (measured above: the same start time and counts from 4 process ids). So no change is expected; the check on the real container is below.

**Deploy check.** nginx answers `/_boot.txt` when PHP is stuck, so a static file no longer proves that PHP answers. `c1_check` (`deploy/variants/c1.sh`) also requests `/_fpm-ping`, which needs a free FPM child. `kill.php?sig=STOPPHP` now stops every FPM child (not the root master, which a child cannot signal), and that is enough to stop all PHP answers.

**Measured locally, 2026-11-06** (the real `php-fpm` 8.5 of this computer with the shipped pool file, only the user, the paths and the port changed, through a FastCGI test client; no nginx or Docker here):

| Case | Result |
|---|---|
| Children with `PHP_WORKERS=2` | 2 |
| `/_fpm-ping` | `pong` |
| `getenv()` in a request (`clear_env = no`) | the value passed |
| A fast request while one child sleeps 5 s (3 tries) | 0.00 s each, from the free child |
| Control: a fast request while both children sleep 5 s | 4.69 s: it waits for a free child |
| SIGTERM to `c1-serve.sh` | exit 0 after 1 s, both stopped |
| nginx (a stand-in) killed | exit 1 after 1 s, PHP-FPM stopped |
| The FPM master killed | exit 1 after 1 s, nginx stopped; the 2 children stay (in the container they end with it) |
| SIGTERM while a child ignores SIGQUIT | exit 0 after `STOP_GRACE_S` (3 s in the test), both stopped |

The last row is a defect that the first version had. bash starts a background child with SIGQUIT ignored, so a SIGQUIT that comes before the child sets its own handler is lost, and the first `c1-serve.sh` then waited for ever. That is a container that answers nothing. The SIGKILL after `STOP_GRACE_S` ends it.

**The stop signal (found in the image smoke test, 2026-11-06).** `docker stop` on the first image took 3 s and the container ended with exit 137 (SIGKILL), with no stop lines from PHP-FPM or nginx. The cause is the `php:8.3-fpm` base image, which sets `STOPSIGNAL SIGQUIT` for an image where php-fpm is PID 1. Here PID 1 is a shell, and bash ignores SIGQUIT. So the signal did nothing, and Docker then sent SIGKILL. In the container that skips Litestream's final sync. The image now sets `STOPSIGNAL SIGTERM`, which is what `php:8.3-cli` had. `entrypoint.sh` and `c1-serve.sh` also trap SIGQUIT. The local test sends SIGTERM and then SIGQUIT to `c1-serve.sh`. Both give exit 0 after 1 s, with the PHP-FPM lines "Finishing ..." and "exiting, bye-bye!" and the nginx stand-in's graceful stop. Without the SIGQUIT trap (a mutant), the SIGQUIT case hangs until the test's 15 s deadline.

**The first deploy crashed at start (arm 2, 2026-11-06).** On Cloudflare the FPM container exited at every start ("Failed to start container: The container just exited"), while the same image ran in local Docker (arm64 with the real entrypoint, replica and key, and amd64). php-fpm (`error_log = /proc/self/fd/2`, from the base image) and nginx (`error_log /dev/stderr`) OPEN their log path. On Linux that open fails with ENXIO when stderr is a socket. With stdout and stderr on a UNIX socketpair in the amd64 image, nginx exited with status 1 ("[emerg] open() "/dev/stderr" failed (6: No such device or address)") and php-fpm with status 78 ("ERROR: failed to open error_log (/proc/self/fd/2): No such device or address (6)", "FPM initialization failed"). Docker gives a pipe, so the smoke test could not see it. `php -S` never opened that path.

That Cloudflare gives the container a socket as stderr is inferred: it is the one difference that fits a crash at start there and none in Docker. `c1-serve.sh` now puts a pipe (to `cat`) in front of stdout and stderr before it starts the servers. The start lines of `entrypoint.sh` print what fd 2 is and whether it opens, so the next deploy shows it. The generated config now has Workers Logs on (`[observability]`), because c1 had none and there was no stderr to read.

The first start-line readouts (f15fc47) were wrong: they read `/proc/self/fd/N` inside `$( )` and in a subshell with a redirect, so they saw the capture pipe and `/dev/null` and always said "pipe" and "ok" (the lead saw "fd2 pipe" on a socket). Since f7817ee they read `/proc/$$/fd/N`, this shell's own descriptors. So arm 2 (image from f15fc47) and arm 3 (image from f7817ee) ran different image shas with the same server code; only the print lines differ. For arm 2 only the step lines count, not the fd2 or open lines.

Test: `tests/stderr-socket-test.pl` runs in the image (`docker run --rm -v "$PWD/spikes/c1-woo-container/tests:/t" --entrypoint perl <image> /t/stderr-socket-test.pl`). With stdout and stderr on a socketpair, `c1-serve.sh` must still run after 6 s, answer `/_fpm-ping` and exit 0 on SIGTERM. A copy without the two pipe lines must have exited. The fd probe of `entrypoint.sh` must say socket and FAILED on a known socket, and pipe and ok on a known pipe, and the f15fc47 probe must fail that socket check. The test exits 0 only when all of these hold.

**On wp-c1-perf:** not measured yet. The plan (issue #99):

1. The head-of-line case on `php -S` and on FPM, both with `AS_TIME_LIMIT=30`.
2. FPM with the defaults against the short-runs run (swap15), for throughput and CPU per order.

## Warm start on a product view (issue #73)

With the storefront cache, a shopper can browse cached pages while the container sleeps. Then the first request that needs the container (the cart, add to cart) waits for the cold start: 11 to 22 s, measured as starts after a stop.

**The change** (`spikes/c1-woo-container/warm.js`, off by default):
- With `WARM_START=product`, the gateway sees a product view in its cacheable branch, and the page still comes from the edge. It then calls the Store object's `warmStart()` in `ctx.waitUntil`, after the response.
- The object starts the container through the Container class `start()` (the process, not a WordPress request), only when it does not run. It never goes through `Store.prototype.fetch`, so the bounded queue does not count or shed it.
- Two rate limits: the object makes no new start within `WARM_GAP_S`, and the gateway isolate asks the object at most once per `WARM_GAP_S`, so a warm site makes no RPC per page view.
- The container's own idle watchdog (`IDLE_SECONDS`) stops a container that no shopper follows. That is the cost: up to `IDLE_SECONDS` of awake time per warm start.
- `/_store-info` reports `warm: {mode, starts, skipped_running, skipped_gap, failed, last_ms_ago}`.

**Tested locally:** `spikes/c1-woo-container/tests/warm-test.mjs` (CI) covers the path rule, the two rate limits, the running check, a failed start, and that neither `Store.prototype.fetch` nor `warm.js` warms through `fetch`. A mutation run turned each of 8 guards red.

**To measure** with `tests/load/warm_start.py` (one arm per deploy; `B=<site> SPIKE_TOKEN=... python3 tests/load/warm_start.py [trials] [think_s]`). **On a fresh c1 site, when Docker is back:** let the container sleep, make one cached product view, then add to cart, with `WARM_START=product` and, as the control, `off`. Read the add-to-cart time, and the awake time from `/_store-info`. Also check whether a cached product view already reaches the container by itself (a Store API or `wc-ajax` request of the theme); then this trigger adds little. What is known (strummer-c1perf, #39, plain HTTP with `load.py` and the probes, which run no JavaScript): an anonymous product page from the edge sets no cookie and sends nothing more by itself. Whether the mini-cart block of twentytwentyfive (or `wc-cart-fragments`, if a theme turns it on) sends a Store API cart request on load is a browser question, not tested. It needs a browser run.

**Measured, 2026-11-06,** on `wp-import-c1` (a fresh c1 site, `standard-1`), by the lead, with `tests/load/warm_start.py 3 10` at `97b58c9` (rows in `docs/results.md`). Each trial: stop the container, one cached view of a simple product as a new visitor, 10 s, then add to cart.

| Arm | Add to cart (s) | Median | Running before the cart | View |
| --- | --- | --- | --- | --- |
| `off` (control) | 10.02, 11.02, 9.36 | 10.02 | no, no, yes | HIT, HIT, UPDATING |
| `product` | 4.38, 5.14, 6.78 | 5.14 | yes, yes, yes | HIT, HIT, UPDATING |

- **The warm start about halves the first add to cart after a sleep:** median 10.0 s to 5.1 s, and 10.5 s to 4.8 s over the HIT views only. The direct evidence is the running state: the container was up before the cart in every `product` trial, and in no `off` trial with a HIT view.
- **A stale view is a second warm trigger, and it exists already.** Trial 3 in each arm got the page stale (`UPDATING`). The refresh behind it reached the container and started it, so the container was up before the cart even with `off`.
- **In `product` trial 3 the gateway made no warm call at all:** `starts`, `skipped_running` and `skipped_gap` were all 0. The most likely cause is the script's own priming view, 3 s earlier. It is a product view, so it closed the gateway isolate's 60 s gate. That is a defect of the measurement, not of the site. The script now waits out `WARM_GAP_S` after the prime, and takes its median over HIT views only.
- **n = 3 per arm is small.** Read the factor of two as a size, not as a precise number.
- **Running is not ready.** Even warm, the add to cart took 4.4 to 6.8 s, so a started container is not a ready store. The first PHP request after a start still pays several seconds: the Litestream restore, the WordPress boot, a cold OPcache. **Open item, not a fix:** warm WordPress itself after the start, with one request that boots PHP and fills OPcache. It must stay outside the queue's shed class, and that is still to design and measure.

**Why not warm through a Store API request:** under overload, the bounded queue sheds a new visitor's Store API cart request (no `Cart-Token`, no session: class `shed` in `admission()`). A warm start made through such a request would then be refused. `start()` does not go through the queue.

## Problems found

- WooCommerce writes log files under `uploads/wc-logs`. With uploads in R2, every log line was an R2 read and write: about 30 calls and about 15 s of each checkout. `WC_LOG_DIR` now points to local disk (also in approach B).
- With 4 PHP workers at 256 MB each, a `basic` instance (1 GiB) dropped a connection once ("Container suddenly disconnected"). Now 2 workers.
- PHP's built-in server does not run `index.php` for a directory. `/wp-admin/` went to WordPress and showed the home page. Found 2026-11-05 by the plugin suite; earlier checks passed because they looked only for a 200. `router.php` now runs `<dir>/index.php` and redirects `/wp-admin` to `/wp-admin/`, as Apache and nginx do.
- The container file system is ephemeral. A plugin installed from wp-admin is lost when the container stops, so plugins go in the image (`build.sh` installs the 18 plugins of the suite, none active). The 18 plugins pass: [docs/plugins.md](plugins.md).
- The health check is a static file (`pingEndpoint = "localhost/ping"`): the default requested `/`, a full WordPress render.

## Cost and limits

- Workers Paid only (Containers). The container bills while awake; it stops itself after `IDLE_SECONDS` (900 s) with no request (`sleepAfter` did not stop it, see above). Workers Paid includes 25 GiB-hours of container memory a month: about 25 awake hours on `basic` (1 GiB), about 6 on `standard-1` (4 GiB, the deploy default), about 4 on `standard-2` (6 GiB), then metered ([Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/)).
- R2 holds the database replica and media (R2 free tier, then metered).
- One container: one region, one writer. The first visitor after a sleep waits about 11 s for a page that is not cached. A cart or checkout always goes to the container.

## Next

- The first write after a sleep: a cached storefront hides the cold start (13 to 30 s) until the first cart request. Start the container on the first product view or the first Store API request of a visit (#73).
- Purge by object (a tag per product and per listing) instead of the whole site, when a store has many products and many edits.
- Let a shopper already in a cart flow (a Cart-Token or a WooCommerce session) pass the bounded queue, so the work for a cart is not lost when the add to cart is shed (section "Bounded queue").
- The rest of the CPU is the start of WordPress and WooCommerce and the rendering (about 0.15 s a page with APCu): profile it before more caching.
- Start the container before it is needed: on a product page view, or keep it awake in store hours.
- Admin pages and the editor in the container: measure them.
- Uploads: atomic file names (approach B used D1 for this); one container makes a race unlikely but not impossible.
- Stop sends: Litestream must finish its last sync before the container stops. Measure what a sleep loses (the sync interval is 1 s).
