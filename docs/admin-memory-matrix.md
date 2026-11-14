# Admin memory matrix: where WordPress admin dies on Cloudflare (2026-11-14)

This page puts every admin-memory measurement of 2026-11-14 in one place, so the next person can reuse it without the chat that made it. Each number names its **method**. The raw data is in [`tests/load/data/admin-matrix-2026-11-14/`](../tests/load/data/admin-matrix-2026-11-14/README.md).

**Ruling (Conrad, 2026-11-14): admin pages go to the Container.** All wp-admin requests run in a Cloudflare Container; visitors and checkout stay on Workers. The rounds below are the evidence behind that ruling and the record of what each Worker-only path costs.

## The targets

| target | what it is | build | plan, Wrangler | data |
|---|---|---|---|---|
| **A, PHP in the Worker** (`pfa-m3-joan`, #479 M4) | approach A: PHP in the Worker isolate, MySQL 8.0 (Azure) through Hyperdrive, `OBJECT_CACHE_L2=off`, `LAZY_CACHE_MB=2` | main at deploy time; the run did not record the sha (main was `870e40f` at 07:34Z by `git log`) | Workers Paid, Wrangler 4.107.0 (`deploy/tools/package.json`) | the pf394a store (2,609 products, 899 orders), copied in by #479 M3 |
| **A, PHP in a Durable Object** (`pfa-do-joan`) | approach A with `PHP_IN_DO=on`: the front Worker forwards each PHP request to a PhpRuntime object; same vars otherwise | `b0bf9d2` | Workers Paid, Wrangler 4.107.0 | the same store, copied by the M3 tooling through a temporary plain-A loader (`/_sqlimport` is 404 with `PHP_IN_DO=on`, #551) |
| **HostlessWP** (`hwp504`) | HostlessWP v0.1.1 at `739e8e7`, deployed by its own CLI; PHP in the Worker on Paid (`PHP_IN_DO=0`, `cpu_ms` 300000, placement aws:us-west-2); its local DB connection patched for TLS only, the runtime as shipped | `739e8e7` | Workers Paid | a mysqldump of the A-in-DO database at 10:39Z (52 tables, 4,808 posts, 900 orders, 2,609 products) |
| **b-dosql, arena off / on** (pf394a, #508) | the default store path: PHP and SQLite in one Durable Object; `LAZY_ARENA` off against on, nothing else changed | `9d5c6db9ef87-wooprimed` in every arm | Workers Paid | pf394a's own store |
| **HostlessWP, 18-plugin suite** (2026-11-05, [approach-a.md](approach-a.md)) | HostlessWP `739e8e7` on a Vultr MariaDB | `739e8e7` | Free and Paid | a test site, not the store |

## The matrix

Client-visible deaths are answers of 500 or more, or no answer. "Platform memory deaths" is Cloudflare's own outcome count. "Hidden retries" are answers that carry `x-isolate-retry: 1` (`spikes/b2-wordpress/object-error.mjs`).

| target | windows (UTC) | client-visible deaths | platform memory deaths | hidden retries | POST write-loss | saves read back | WASM | method |
|---|---|---|---|---|---|---|---|---|
| **A, PHP in the Worker** | +0 08:21:12 to 08:26:20; +20 08:41:23 to 08:46:43; +60 09:21:25 to 09:26:40 | **12 of 65, 12 of 65, 7 of 70: 31 of 200** (10 profile saves not sent: their form GET had died) | **Worker `exceededMemory` 30**, success 247 (08:21 to 09:27Z) | n/a (no retry path in a plain Worker) | 0 | **20 of 20** | not recorded | client: the 7-screen round, **summarised at the time; per-request raw deleted at teardown**. Platform: GraphQL `workersInvocationsAdaptive`, `scriptName` `pfa-m3-joan`. Each death was an **empty-body 503** in 0.55 to 1.15 s (no title, no Cloudflare error code, no `x-wfp-error`) |
| **A, PHP in a Durable Object** | +0 09:59:18 to 10:10:35; +20 10:19:25 to 10:30:31; +60 10:59:24 to 11:10:26 | **0 of 210** | **DO `exceededMemory` 9 + 6 + 8 = 23**; Worker 0 (success 92, 94, 94); DO `scriptThrewException` 0, 1, 2 | **23** (9, 6, 8): **every DO memory death was a GET, hidden by one retry** | 0 | **30 of 30** | not exposed | client: the 7-screen round, CSV `a-in-do-pfa-do-joan.csv`. Platform: GraphQL `workersInvocationsAdaptive` and `durableObjectsInvocationsAdaptiveGroups`, `scriptName` `pfa-do-joan`. Retries: the `x-isolate-retry` header |
| **HostlessWP** (`hwp504`) | +0 11:10:32 to 11:13:53; +20 11:30:35 to 11:33:54; +60 12:10:38 to 12:14:04 | **0 of 210** | **0** (Worker success 94, 94, 93; no other status); DO dataset empty (PHP runs in the Worker) | n/a | 0 | **30 of 30** | **82 MB, flat on every request, as reported** (`x-hostlesswp` `wasmMB`; read as the runtime's size, not a peak) | client: the 7-screen round, CSV `hostlesswp-hwp504.csv`, `x-hostlesswp` fields per request. Platform: GraphQL `workersInvocationsAdaptive`, `scriptName` `hwp504` |
| **b-dosql, arena OFF** (abA1, abA2) | 07:39:38 to 07:48:43; 08:06:13 to 08:14:53 | **post-new 84 of 100** (50 + 34); REST create 2 of 100 | storage resets about 1 per arm (Workers Logs, in the #519 anchor) | n/a (pnrest sends no retry header) | post-new: every death is the write-loss 500 (`x-write-loss`) | REST: **0 answered 201 and absent**; 100 of 100 found | `wasm1MiB` max 119 (post-new), 97 to 98 (REST) | Rollins's `measure394.py pnrest` (#537, frozen copy sha256 `633dcb16c0f0`), 50 rounds of GET post-new then a REST draft create read back; CSV `b-dosql-arena-ab-pf394a.csv`; summary table #519 issuecomment-6874538082 and the #508 PR body |
| **b-dosql, arena ON** (abB1, abB2) | 07:52:37 to 08:01:59; 08:18:50 to 08:27:45 | **post-new 1 of 100** (1 + 0); REST create 3 of 100 | storage resets about 1 per arm | n/a | post-new 1 | REST: **0 answered 201 and absent** (the one absent row answered 500) | `wasm1MiB` max 121 | the same |
| **HostlessWP, 18 plugins at once** (2026-11-05) | not recorded | **the login answered 1102** (Worker exceeded its resource limits) | not read | n/a | n/a | n/a | **118 MB** at the 1102 | [approach-a.md](approach-a.md), "What we found about HostlessWP". One at a time, all 18 pass |

### Page time per screen (ms, answered requests only)

p50 and p95 are nearest-rank over all answered requests of the screen. The M4 row has only the per-window medians, upper middle of 10, taken at the time, because its raw data is gone.

| screen | A, PHP in the Worker (M4, per-window p50: +0 / +20 / +60) | A, PHP in a DO (p50 / p95, 30 each) | HostlessWP (p50 / p95, 30 each) |
|---|---|---|---|
| dashboard | 2,660 / 4,030 / 2,560 | 5,430 / 8,520 | 2,220 / 3,230 |
| post-new (post) | 5,990 / 5,670 / 4,620 | 7,730 / 11,860 | 2,800 / 5,030 |
| post-new (page) | 6,900 / 6,620 / 5,200 | 11,490 / 14,240 | 2,570 / 5,090 |
| post.php (post 1) | 6,200 / 5,630 / 5,790 | 11,300 / 13,820 | 2,540 / 5,170 |
| post.php (page 8) | 4,050 / 5,590 / 3,800 | 11,330 / 14,290 | 2,530 / 3,100 |
| profile GET | 2,290 / 2,110 / 4,390 | 7,140 / 8,650 | 1,710 / 2,120 |
| profile save | 1,720 / 3,220 / 1,980 | 3,180 / 4,010 | 1,310 / 2,040 |

b-dosql (pnrest, a different round): post-new p50 / p95, arena off 4,690 / 5,480 (abA2; abA1 had no answer), arena on 3,910 / 4,950 and 4,490 / 5,330; the REST create 770 to 2,550 p50.

### Also measured on 2026-11-14 (single events)

- **A in a DO, the first WooCommerce activation died in the object.** `/_activate` at 09:37:24Z answered the write-loss 500, while GraphQL `durableObjectsInvocationsAdaptiveGroups` for 09:37 read DO `exceededMemory` 1 and the Worker only success. The retry at 09:38:33Z succeeded, and its log held "Duplicate entry 'wc_installing'", so the first try had partly run.
- **A store move must hold the TARGET's cron too, not only the source's.** In the A-in-DO copy, pass 1 failed its check on `wp_actionscheduler_logs` (target 6,179 against 6,178 exported): the target's own alarm ran the cron after the load. With the target held by `/_hold` (#542), passes 2 and 3 matched on all 52 tables.

## The isolate budget (Rollins's floor rounds 1 to 6, #394)

Allocation probes in production, by Rollins, 2026-11-14. Each one holds memory until the isolate is killed, with and without the pieces our bundle loads. The raw readings are in the comments; this page only summarises them.

| finding | MiB | round and comment |
|---|---|---|
| an empty isolate: a plain Worker, a Durable Object, and WebAssembly memory alike | **255** (DO 255, wasm 254) | rounds 1 and 3, [issuecomment-6876869608](https://github.com/skyphusion-labs/pagefeather/issues/394#issuecomment-6876869608), [issuecomment-6876985619](https://github.com/skyphusion-labs/pagefeather/issues/394#issuecomment-6876985619) |
| the bundle's zips, before PHP runs | **32** (`opcache.zip` alone 20, `site.zip` alone 19; not additive) | rounds 1 to 3, also [issuecomment-6876930979](https://github.com/skyphusion-labs/pagefeather/issues/394#issuecomment-6876930979) |
| the compiled `php_8_3.wasm` alone | **6** | round 3, [issuecomment-6876985619](https://github.com/skyphusion-labs/pagefeather/issues/394#issuecomment-6876985619) |
| a booted PHP | **32** (24 heap + about 8 for compiled code, the JS glue and the runtime); running it and tier-up add **0** | round 5 (probe I), [issuecomment-6877044444](https://github.com/skyphusion-labs/pagefeather/issues/394#issuecomment-6877044444) |
| php-wasm's heap growth | grows **in place**, to about **248** (no old + new copy at once) | round 4 (probe G), [issuecomment-6877025165](https://github.com/skyphusion-labs/pagefeather/issues/394#issuecomment-6877025165) |
| the real PHP heap in one request | **226**, or **186** with the zips loaded (the zips cost 40 here, against 32 in the `ArrayBuffer` probes: measured, not explained) | round 6 (probes P and PZ), [issuecomment-6877086017](https://github.com/skyphusion-labs/pagefeather/issues/394#issuecomment-6877086017) |

**Rollins's inference, not proven:** with a budget of about 256, 32 to 40 for the zips and about 8 for the runtime, **about 100 MiB at a real WordPress death sits outside the wasm heap, in our own JS**. That includes the JS heap, inflate garbage, SQL and JSON reply strings, MEMFS contents, response buffers and runtimes not yet collected. `/_headroom` (#559) will measure it: after a real request, the same held-`ArrayBuffer` loop in the same isolate. It is also the best current explanation of HostlessWP's 0 deaths, alongside its code living outside the bundle.

## What it means

1. **In the same shape (PHP in the Worker, Paid, the same store data and the same round), HostlessWP 0.1.1 had 0 platform memory deaths in 210 admin requests, and our approach A lost 31 of 200.** Both run PHP in a Worker isolate with ONE budget of about 256 MiB, shared by WebAssembly memory and every `ArrayBuffer` (the floor rounds above). HostlessWP reports a flat 82 MB and answers every screen in 1.3 to 2.8 s p50. Our plain-Worker A died after the heavy editor screens with Cloudflare's `exceededMemory`, with the isolate's budget used up, not PHP's heap alone.
2. **Moving PHP into a Durable Object does not remove the wall: the object hits the same isolate budget of about 256 MiB.** It died 23 times in 210 requests. Our retry of a GET on an object reset (`object-error.mjs` `shouldRetryObjectError`, used at `index.js` `fetchWithMemoryRetry`) hid all 23 from the client. The cost is time: about 2 to 3x slower than the plain Worker, partly because each retried request boots two objects, and 2.4 to 4.5x slower than HostlessWP (the page-time table below).
3. **On b-dosql, the arena (#508) is the lever for post-new**: 84 of 100 deaths off, 1 of 100 on, with every write durable both ways.
4. **Where the budget goes** is in the floor section above: 32 for our zips and 32 for a booted PHP before any page runs, and, by Rollins's inference, about 100 MiB of our own JS at a death.
5. **The Worker-only paths each trade something** (deaths, hidden memory deaths with latency, or a tuned engine that still hits the wall with many plugins at once, 118 MB in 2026-11-05). So admin pages go to the Container. Visitors and checkout stay on Workers, where these rounds do not apply.

## Not measured here

- **The Container itself** (the ruling's target): no admin round has run on it yet. This matrix is the baseline it must beat.
- **HostlessWP media**: the database was copied but not the uploads, so images answered 404. The rounds load admin screens, not images.
- **HostlessWP with this store's plugin set beyond WooCommerce**, and HostlessWP under `PHP_IN_DO=1`.
- **Per-request memory on approach A**: the A runtime sends no `x-perf` on these paths. HostlessWP's `wasmMB` is flat and is not a peak.
- **Concurrency**: every round is one client, requests in sequence.
- **ServerlessWP** (mitchmac/ServerlessWP) is deliberately not a comparison row, by Conrad's call: its spin-up terms, on platforms like Vercel's hobby tier, which is for non-commercial use, go against what our WooCommerce side is built for. Its code may still be read for research.
- **Visitor and checkout paths**: out of scope for the admin ruling (see [results.md](results.md) for checkout under load).
- **Other notes on the data**: HostlessWP made fresh salts at deploy, so the round logged in anew. `home` and `siteurl` in all three copied databases still name the pf394a host; each runtime sets `WP_HOME` from the request host, so it did not matter at runtime.

## How to repeat a round

`tests/load/data/admin-matrix-2026-11-14/tools/admin-round.py` is the 7-screen round. Per round it runs:
- the dashboard;
- post-new for a post and a page;
- post.php for one post and one page;
- the profile GET;
- the profile save with a marker in the description, read back by REST, and the original restored at the end.

Each request carries `x-mem-trace: 1`, `x-mem-ledger: 1` and a unique `x-perf-id`; on a site without the spike token they do nothing. Set `B`, `ADMIN_USER`, `ADMIN_PASSWORD`, `ROUNDS=10` and `ALL_ON=1`, and set `SPIKE_TOKEN` only for our own sites. Run it at +0, +20 and +60 min. Then read the platform outcomes per window with GraphQL `workersInvocationsAdaptive` (and `durableObjectsInvocationsAdaptiveGroups` for a Durable Object), filtered by `scriptName` and the window.
