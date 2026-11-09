# Approach A: the scalable path (WordPress in a Worker, managed MySQL through Hyperdrive)

**Status: current. This is the recommended path when a site needs to scale.** This page is the story. The detail and the raw numbers are in the pages it links to and in [results.md](results.md).

## What it is

WordPress runs as PHP compiled to WebAssembly inside a Cloudflare Worker. The database is an external, managed MySQL server. [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) pools the connections and sits between the Worker and the database. There is no container and no Durable Object in the request path.

Why pick it:

- **It scales sideways.** Cloudflare starts more Worker isolates as load rises. In the side-by-side load run, approach A went from 0.32 to 6.70 requests a second (1 to 50 users) while browse time stayed about flat; b-dosql stopped near 1 request a second. See the rows `A vs b-dosql (concurrency)` and `A vs b-dosql (fully loaded, 2608 products)` (both 2026-11-09) in [results.md](results.md).
- **It runs full WooCommerce.** `tests/woo.py` passes 12 of 12, three runs in a row, including guest checkout, under the 128 MiB isolate cap. See the row `A (12/12, the full stack, #218)` (2026-11-09).
- **The cost** is a MySQL server that you run, pay for and scale. That is the whole trade against [b-dosql](approach-b.md), which needs no outside server.

Pick b-dosql instead when you want zero outside infrastructure and have low to moderate traffic. See the choice table in [README.md](README.md).

## What makes it fit in 128 MiB

WordPress with WooCommerce needs about 99 MiB of WebAssembly memory. The 128 MiB isolate cap also counts the JavaScript heap, which the `x-wasm-mib` header does not show. Three changes brought the whole isolate under the cap (row `A (12/12, the full stack, #218)`):

1. A small hand-written MySQL client (`mysql-lean.js`) in place of mysql2. The Worker script went from 2,256,148 to 849,379 bytes.
2. Lazy MEMFS nodes (`LAZY_NODES=on`): a file node is made on first lookup, not about 6,800 at boot.
3. A precompiled OPcache cache. This was the decisive change. Without it, a cold isolate recompiled about 1,500 WooCommerce scripts and ran over the cap. It also made pages 4 to 5 times faster.

`spikes/b2-wordpress/opcache-a.sh` builds the approach-A bundle with the cache, with no outside MySQL needed.

**Read results.md carefully here.** The row `A (lean MySQL client, #218)` (2026-11-09) says approach A cannot run WooCommerce without a container. That conclusion was wrong. The rows `A (lazy MEMFS nodes, #218)` and `A (12/12, the full stack, #218)` correct it. The old row stays because a wrong result is still a record.

## Choose a database provider

Approach A works with any MySQL (or MariaDB) server that Hyperdrive can reach. Four options were measured. The numbers are for the same WordPress stack; only the database changed.

| Provider | Measured | Per query | Good for | Watch for |
| --- | --- | --- | --- | --- |
| **Azure Database for MySQL** (Flexible Server) | Rows `A (approach-A object cache, live)` (2026-11-08) and the 2026-11-09 load rows. Standard_B1ms, West US 2, Hyperdrive in the same region. | About 9 to 17 ms warm; checkout 5.1 s (313 queries) | Best measured speed; the ceiling for scale is the server size you buy | A separate bill. Azure MySQL 8.0 ships a strict `sql_mode` that breaks the WordPress install; set `sql_mode=ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION`. |
| **PlanetScale** (a2, billed through Cloudflare) | Row `A2 (PlanetScale, single Cloudflare bill)` (2026-11-09); earlier probes in [approach-a2.md](approach-a2.md). PS-10, AWS us-west-2. | About 17 ms warm reads; checkout 9.1 s (336 queries, 27 ms per query) | One Cloudflare bill and no separate invoice. Reads are nearly as fast as Azure; checkout is about 1.5 to 1.8 times slower. | Vitess is strict. Use the direct host (`us-west.connect.psdb.cloud`), not the optimized host (about 27 ms more per query). A `CREATE TABLE` can lag across pooled connections, so install and WooCommerce activation may need a re-run. 11 of 12 on `woo.py`. $39 a month for PS-10. |
| **Self-managed MariaDB or MySQL on a VPS** | Rows `A` (2026-11-05 and 2026-11-06): Vultr box in Chicago, MariaDB 10.11, SSL. See [approach-a.md](approach-a.md). | 6 to 11 ms by host name | Cheapest ($10 a month for the test box); you control everything | You patch and back up the server. Give Hyperdrive the host name, not the IP address (6 times slower by IP). The port needs SSL and a firewall that admits Cloudflare ranges, or a Tunnel (about 90 ms more per query). |
| **External or existing MySQL** | Same path as the VPS rows. | Depends on distance | Reuse a database you already run | Place the Worker near it. Hyperdrive must reach it over SSL or a Tunnel. |

How to choose:

- **Want one bill and the least to manage?** PlanetScale through Cloudflare.
- **Want the fastest checkout and have credit or a cloud account?** Azure, co-located with the Hyperdrive region.
- **Want the lowest cost and can run a server?** A VPS.
- **Already have a database?** Use it.

Two rules hold for every provider:

- Turn the Hyperdrive **query cache off** for WordPress. It holds results for 60 seconds and does not clear them on a write, so it serves stale reads. See [approach-a2.md](approach-a2.md).
- Put the Worker and Hyperdrive **in the same region as the database**. Distance is paid on every query, and a page runs 76 to 400 queries.

Under heavy concurrent checkout, only approach A on a consistent managed MySQL completes orders at scale. In the 250-concurrent run (buyers all checking out), approach A on Azure finished 261 of 276 attempted checkouts (about 95 percent); b-dosql returned 503 for every request from 50 concurrent up, because the one Durable Object per site serializes writes. See the row `A backends under 250+ concurrent checkout` (2026-11-09) in [results.md](results.md), which also covers PlanetScale and a self-managed VPS under the same load.

## The pages behind this story

| Page | What it holds |
| --- | --- |
| [approach-a.md](approach-a.md) | The first measurements: the Vultr MariaDB box, the Tunnel and public paths, per-query cost, HostlessWP compared, the userland mysqli layer (#29), and binary SQL (#79). |
| [approach-a2.md](approach-a2.md) | The PlanetScale variant: host choice, strict `sql_mode` through Hyperdrive, the `SET_VAR` fix, and the load matrix. |
| [approach-a-objectcache.md](approach-a-objectcache.md) | The write-aware object cache that cuts SQL round trips (#218): which cache groups are safe across isolates, and the L2 KV tier. |
| [results.md](results.md) | Every deploy and test run. The measurements are the product. |

## Limits to know

- **Workers Free does not run our approach-A build.** It stops at the CPU limit (HostlessWP, a different design, does run on Free; see [approach-a.md](approach-a.md)). Use Workers Paid.
- **Cold isolates do not get the in-isolate object cache.** The L2 KV tier closes most of that gap for options, terms and theme data.
- **Admin pages with WooCommerce can recycle the PHP runtime** (#84, measured locally, not yet on Cloudflare).
- **Plugins:** 17 of 18 in the standard suite passed on the first Paid run; All-in-One WP Migration passes since #29. All 18 active at once do not fit.
