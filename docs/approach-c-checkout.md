# Checkout in a Container (approach B + C)

> **HISTORICAL, not the product.** Kept as a record. The current paths are [approach A](approach-a-overview.md) and b-dosql; see the [docs map](README.md).

> **Retired 2026-11-08 (#214).** This container-checkout path was never stable (the container stopped starting after later deploys) and is superseded: b-dosql does WooCommerce checkout directly, no container. The store path is now b-dosql (light-to-moderate) with a VPS for scale. Kept as a measured record, not a recommendation.

Issue #20. Conrad's design, 2026-11-04. Measured 2026-11-04 on Workers Paid.

## Why

WooCommerce asks for a WordPress memory limit of 256 MB or more ([WooCommerce server recommendations](https://woocommerce.com/document/server-requirements/)). A Worker isolate has 128 MB for everything. On approach B, the store and the cart work, and checkout fails with `exceededMemory` (`docs/approach-b.md` 8f).

## Design

- The Worker serves the store, the product pages and the cart (PHP in WebAssembly on D1, Workers Cache for logged-out pages).
- **The cart starts the Container.** When `/wc/store/v1/cart/add-item` returns 201, the Worker calls `startAndWaitForPorts()` in `ctx.waitUntil()`. The response header `x-checkout-warmup: 1` shows it. The shopper then reads the cart and types an address while the container starts.
- **The Container runs checkout.** The Worker sends `/wc/store/v1/checkout` (and the `/checkout/` page) to the container. Responses carry `x-served-by: checkout-container` and `Cache-Control: private, no-store`.
- **One database.** PHP in the container uses the same `D1_PDO`, D1 dialect and R2 code as the Worker. The only difference is the transport: `skyphusion_worker_call()` posts to `http://worker.internal/`, and a Container outbound handler (`WooCheckout.outboundByHost`) answers with the same `handleMessage()` the Worker uses. The handler runs in the Workers runtime on the same machine, with the D1, R2 and Images bindings. The container holds no keys and has no internet (`enableInternet = false`).
- **Same keys.** The container gets `WP_SALT` as an environment variable and derives the WordPress keys the same way (SHA-256 of `WP_SALT:NAME`), so the cart session and nonces from the Worker are valid in the container.
- **Sleeps when idle** (`sleepAfter = "5m"`), so it bills only around checkouts.

Image: `container/Dockerfile`, `php:8.3-cli` with PHP's built-in server and 4 workers, the WordPress tree from `build.sh`, `memory_limit=256M`, OPcache on. Instance type `basic` (1/4 vCPU, 1 GiB).

## Results

| Test | Result |
| --- | --- |
| Guest checkout through the container (`add-item`, wait 8 s, `checkout`), 3 runs | 3 of 3 orders created, status `processing`. **About 42 s each.** |
| The same before the query cuts below | 3 of 3 orders, 63 to 72 s each. |
| One D1 statement from the container through `worker.internal`, 20 runs | Median 46 to 48 ms (min 39, max 98). Container in `iad09`, D1 primary in `ENAM`. |
| Container start after a stop (image cached) | About 35 to 44 s until the first response. A new instance name (image pulled) took 88 s or more. |
| Approach B checkout in the Worker (before) | `exceededMemory`, every time. |

**The wall time is D1 round trips.** A checkout makes hundreds of sequential D1 calls, and each is a network round trip. Cuts so far, in `D1_PDO` and `php/woo-edge.php` (they help the Worker too):

| Change | D1 calls in one checkout |
| --- | --- |
| Before | 750 |
| The driver's TEMPORARY table check answered locally (D1 has no temporary tables): 145 calls | 601 |
| The driver's column lookups cached for the request; cleared only by DDL | 488 |
| WooCommerce's `*-transient-version` options: 33 writes per checkout, now one write at the end of the request | 387 |

A general cache for all reads was tried and removed: in the container, which runs requests in parallel, a request that waits for another request's write looped forever.

## Superseded (2026-11-04)

Approach C1 (`docs/approach-c1.md`) runs all of WooCommerce and its SQLite database in one Container: checkout 1.3 to 1.7 s. The B+C split is turned off: its container application is deleted, and the Worker routes to a container only with `CHECKOUT_CONTAINER=on`. The notes below stay as the record.

## State before it was turned off: unstable

Checkout through the container worked 6 times (3 runs at 63 to 72 s, then 3 runs at 42 s). After more deploys (an instance type change from `basic` to `standard-2` and back, Worker placement changes), the container stopped starting: requests wait 100 s and end in 524. A trace of the outbound handler shows the container making D1 calls for front-end page renders even with no outside traffic, about 1 statement per second. Deleting and recreating the container application, a static health check (`pingEndpoint = "localhost/ping"`), and Worker placement `smart` did not fix it. The cause is not found yet. Checkout on the Paid deploy is not working at the moment.

Leads to check next: what sends the page requests (WordPress loopback requests from Action Scheduler, the health check, or queued requests from abandoned tests), and container stdout logs (Workers Logs).

## Problems found

- Apache (`php:8.3-apache`) ran locally but crashed in the Cloudflare runtime while the port was checked. PHP's built-in server works.
- A running instance keeps its image. With 2 or more `max_instances`, a deploy rolls out in steps `[10, 100]`. `rollout_step_percentage = 100` puts every instance on the new image.
- Each new instance name is a new instance. Renaming to force a new image used up `max_instances`, and the next instance waited until 524.
- Container responses with no `Cache-Control` could be kept by Workers Cache. The Worker now sets `private, no-store`.
- The `Container` class health check defaults to `pingEndpoint = "ping"`, which requested `/`: a full WordPress render with D1 calls. Now `localhost/ping`, a static file.
- A request the client gives up on keeps running in the container. With 4 PHP workers, a few slow requests block every later one, a static file too.

## Next

- Fewer round trips: an object cache that persists across requests (WordPress options, post meta), or D1 read replicas through the Sessions API for reads.
- Container cold start of 35 to 44 s is longer than a shopper's typing. Measure where it goes (image size, PHP start), and start the container earlier (product page view, or the cart page).
- Admin in the container too (the dashboard and the editor need more than 128 MB with WooCommerce).
