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

## Under load (Paid, `basic`: 1/4 vCPU, 2 PHP workers)

| Scenario | Median | p90 | Throughput |
| --- | --- | --- | --- |
| Cached home page, 20 at a time, 100 requests | 0.35 s | 1.35 s | 35 req/s |
| Uncached product page, 5 at a time, 40 requests | 2.9 s | 4.9 s | 1.4 req/s |
| Store API products, 5 at a time, 40 requests | 1.1 s | 1.4 s | 4.3 req/s |
| Add to cart, 5 at a time, 20 requests | 1.1 s | 1.4 s | 2.3 req/s |
| Checkout, 5 shoppers at once, 10 checkouts | 3.8 s | 6.7 s | 0.6 req/s |

All checkouts succeeded; 1 of 145 container requests failed (client exception). The limit is the quarter vCPU: requests queue at the 2 PHP workers. A larger instance type (`standard-1`, 1/2 vCPU; `standard-2`, 1 vCPU) is the next measurement.

## Problems found

- WooCommerce writes log files under `uploads/wc-logs`. With uploads in R2, every log line was an R2 read and write: about 30 calls and about 15 s of each checkout. `WC_LOG_DIR` now points to local disk (also in approach B).
- With 4 PHP workers at 256 MB each, a `basic` instance (1 GiB) dropped a connection once ("Container suddenly disconnected"). Now 2 workers.
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
