# Approach A: the scalable path (WordPress in a Worker, managed MySQL through Hyperdrive)

**Status: current. This is the recommended path when a site needs to scale.** This page is the story. The detail and the raw numbers are in the pages it links to and in [results.md](results.md).

## What it is

WordPress runs as PHP compiled to WebAssembly inside a Cloudflare Worker. The database is an external, managed MySQL server. [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) pools the connections and sits between the Worker and the database. There is no container. PHP runs in the Worker. A request that would wait behind a long run can move to the PHP overflow pool. That pool is OFF by default for approach A since #1277 (it was on, #1119): its objects run far from the database, about 3x the cost per query. `PHP_OVERFLOW=1` opts in.

Why pick it:

- **It scales sideways.** Cloudflare starts more Worker isolates as load rises. In the side-by-side load run, approach A went from 0.32 to 6.70 requests a second (1 to 50 users) while browse time stayed about flat; b-dosql stopped near 1 request a second. See the rows `A vs b-dosql (concurrency)` and `A vs b-dosql (fully loaded, 2608 products)` (both 2026-11-09) in [results.md](results.md).
- **It runs full WooCommerce.** `tests/woo.py` passes 12 of 12, three runs in a row, including guest checkout. That run stays under the measured write ceiling (117 to 119 MiB of wasm; see [memory limits](guide/limits.md#memory-limits-the-three-figures)). See the row `A (12/12, the full stack, #218)` (2026-11-09). The upstream wc suite is a separate result. On `cf759hl` (2026-11-21, [results.md](results.md) row "sb1120, wc") the latest full run is 169 expected, 57 unexpected, 3 skipped. Blocks checkout is slow because of per-order transient deletes (#1218). PR #1219 is open, so that fix is in progress, not fixed. Order emails can be late (#1215, open). The counts and the open items are in [support-matrix.md](support-matrix.md).
- **The cost** is a MySQL server that you run, pay for and scale. That is the whole trade against [b-dosql](approach-b.md), which needs no outside server.

Pick b-dosql instead when you want zero outside infrastructure and have low to moderate traffic. See the choice table in [README.md](README.md).

## What makes it fit under the measured write ceiling

The measured write ceiling is what this stack fits under (117 to 119 MiB of wasm; see [memory limits](guide/limits.md#memory-limits-the-three-figures)). WordPress with WooCommerce needs about 99 MiB of WebAssembly memory. That use is under the ceiling. `x-wasm-mib` does not include the JavaScript heap. Three changes brought the whole isolate under Cloudflare's documented 128 MB per isolate (see [memory limits](guide/limits.md#memory-limits-the-three-figures)).

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
| **Self-managed MariaDB or MySQL on a VPS** | Rows `A` (2026-11-05 and 2026-11-06): Vultr box in Chicago, MariaDB 10.11, SSL. See [approach-a.md](approach-a.md). | 6 to 11 ms by host name | Measured test path only. Not the recommended host. | You patch and back up the server. Give Hyperdrive the host name, not the IP address (6 times slower by IP). The port needs SSL and a firewall that admits Cloudflare ranges, or a Tunnel (about 90 ms more per query). |
| **External or existing MySQL** | Same path as the VPS rows. | Depends on distance | Reuse a database you already run | Place the Worker near it. Hyperdrive must reach it over SSL or a Tunnel. |

How to choose:

- **Want one bill and the least to manage?** PlanetScale through Cloudflare.
- **Want the fastest checkout and have credit or a cloud account?** Azure, co-located with the Hyperdrive region.
- **Already have a managed MySQL?** Use it with `MYSQL=external`.

Do not stand up a VPS only for MySQL. Prefer Azure or PlanetScale. The VPS row above is a measured record, not a recommendation.

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
- **Cold isolates do not get the in-isolate object cache.** On approach A the KV L2 is off by default (#1089, #1078). On WooCommerce admin lists it added about 11 to 12 s of KV misses. Set `OBJECT_CACHE_L2=1` to turn it on.
- **Under Workers for Platforms, no Cron Trigger fires** (#1310: a namespace user Worker's `scheduled()` never ran in 7 minutes, while a Durable Object alarm fired on time). The cron object runs every leg on its own alarm anyway. `CRON_SELF_TICK=on` replaces the trigger's two jobs: each Worker isolate sends one tick on its first site request (the first arm), and the idle back-off is capped at one interval, so work a page queues is found within a minute. `deploy/wfp` renders it for an approach A site; a `deploy/deploy.sh` site does not, and keeps its Cron Trigger. An idle WfP store costs about one alarm and two database reads a minute, about what the trigger's tick costs.
- **Admin pages with WooCommerce can recycle the PHP runtime** (#84, measured locally, not yet on Cloudflare).
- **Plugins:** 17 of 18 in the standard suite passed on the first Paid run; All-in-One WP Migration passes since #29. All 18 active at once do not fit.
