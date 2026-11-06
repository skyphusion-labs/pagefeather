# b-dosql: where the time goes (issue #37)

Variant `b-dosql`: PHP and its SQLite database in one Durable Object, on Workers Free. This page is the baseline for tuning. It changes nothing.

Measured 2026-11-05 on `wp-perf-dosql` (Free test account; deployed by `deploy/deploy.sh` from branch `perf-dosql`; `e2e.sh` 17 of 17 after the install). Client: a laptop in Michigan. Every render is fresh (`?nocache=` and `Cache-Control: no-cache`), so the page cache does not answer.

## The instrument

The PHP object adds these to each response. The Worker adds `Server-Timing` and `x-perf-worker`.

| Header | What it holds |
| --- | --- |
| `x-perf` | `boot`, `bootWaitMs`, `phpMs`, statements (`dbN`, `dbMs`), lazy file inflations (`inflates`, `inflateKiB`), WebAssembly memory before and after (`wasm0MiB`, `wasm1MiB`), response `bytes`, the isolate (`iso`, `isoAgeS`), the runtime (`rt`, `rtAgeS`, `rtServed`: requests since its boot). With `x-perf-opcache: 1` and the spike token: OPcache `opHits`, `opMisses`, `opCached`, `opFull` (two extra `php.run` calls). |
| `x-perf-queue` | `inboxMs` (the object's clock at the start of `fetch` minus `x-perf-sent`, the Worker's clock when it sent), `ahead` and `waitMs` (the PHP lock), `inMs` (start of `fetch` to the response). |
| `x-object-ms` | The Worker's wall time for the call to the object. |
| `Server-Timing` | `object`, `inbox`, `queue`, `in`, `outbox` (= object minus inbox minus in), `boot`, `php`, `db`. |
| `x-perf-worker` | The Worker's colo and isolate. |

The object also logs `{"m":"perf","id":...}` with the request's `x-perf-id`. `tests/load/perf_tail.py` joins those log lines from `wrangler tail --format json` with the samples of `tests/load/perf.py`. Tail gives Cloudflare's own `cpuTime` and `wallTime` for each object invocation.

**The clock.** In a Worker and in a Durable Object, `Date.now()` moves only at I/O. PHP with its database in the object does no I/O while it runs, so on Cloudflare every millisecond figure measured inside the object reads near 0 (`phpMs`, `dbMs`, `bootWaitMs`, `inMs`). `inboxMs` read about -600 ms, because the two clocks stop at different points, so `inbox` and `outbox` are valid locally only. On Cloudflare, use `x-object-ms` (the Worker's clock moves at the call to the object) and tail CPU. The counts do not depend on the clock.

**Tail drops events.** Of 180 samples at one client, 121 joined with a tail event. Each figure below that comes from tail gives its number of joined samples.

## Results at one client (C=1)

Command: `B=https://wp-perf-dosql.vivijure-coldrun.workers.dev ADMIN_PASSWORD=... SPIKE_TOKEN=... N=30 C=1 python3 tests/load/perf.py`, with `wrangler tail wp-perf-dosql --format json` running. 30 renders per page; all 180 answered 200.

Columns, in ms:
- **client**: what the client measured.
- **edge**: client minus `x-object-ms`. It covers network, TLS (a new connection for each request) and the Worker.
- **hop**: `x-object-ms` minus the object's tail wall time. It covers the Worker to object round trip.
- **object CPU**: the object's tail `cpuTime`.

| Page | Tail joined | Client p50 / p95 | Edge p50 / p95 | Hop p50 / p95 | Object CPU p50 / p95 |
| --- | --- | --- | --- | --- | --- |
| home | 16 of 30 | 530 / 700 | 271 / 348 | 33 / 44 | 211 / 411 |
| post | 20 of 30 | 560 / 1,190 | 263 / 835 | 33 / 40 | 241 / 416 |
| search | 17 of 30 | 530 / 820 | 265 / 441 | 36 / 50 | 229 / 428 |
| dashboard | 19 of 30 | 560 / 950 | 270 / 456 | 35 / 48 | 340 / 487 |
| post-new | 30 of 30 | 1,010 / 1,480 | 356 / 666 | 35 / 54 | 570 / 1,013 |
| edit | 19 of 30 | 590 / 1,010 | 275 / 366 | 35 / 46 | 271 / 654 |

At one client, the object's wall time equals its CPU time (wall minus CPU: p50 1 to 23 ms). The object does no waiting; it computes.

**At p50,** a public page is about half edge (network, TLS, Worker: about 270 ms from this laptop) and half object CPU (about 210 to 240 ms). The hop to the object is about 35 ms.

**At p95, the object's CPU is the main part of the tail.** It is about 1.7 to 2.0 times its median on every page. The edge adds less, except for single slow connections (post: edge p95 835 ms).

## What makes the p95

The slow requests did the same work as the fast ones. For home at C=1, the top fifth by CPU (376 to 411 ms) against the rest (203 to 240 ms) had the same values for each of these: inflations (58, 199 KiB), statements (32), response bytes (68,144), WebAssembly memory (69 MiB), runtime and isolate. The CPU is bimodal, with nothing between the two groups, and the slow group is a multiple of the fast one, not a fixed added time (post-new adds about 450 ms, home about 190 ms).

Ruled out at C=1, over all 300 samples of the three passes:

| Cause | Reading |
| --- | --- |
| PHP boot | 0 boots. One isolate, one runtime. It served requests 204 to 509 of its life during the passes. |
| Runtime recycle (memory) | 0 recycles. WebAssembly memory stayed at 69 MiB (the limit for a recycle is 100 MiB). |
| OPcache | 0 misses. 604 scripts cached, cache not full (home: 543 hits a request; post-new: 589). |
| Queue in the object | None at C=1. Wall time equals CPU time. |
| Worker colo | The client reached ORD (115 samples) and YYZ (65). Edge p50: 263 ms and 299 ms. No large difference. |

**Control: the same slow mode without PHP.** `/_dbping?db=object&n=20000` runs a loop of 20,000 SQLite reads in the same object, with no PHP and no WordPress. Of 80 requests, 22 joined with tail. CPU: 17 at 42 to 62 ms and 5 at 76 to 82 ms (23%, about 1.8 times). So the 1.8 times mode is not from WordPress, PHP or OPcache. It is most likely the speed of the host's CPU for that invocation. Garbage collection in the isolate's JavaScript heap is not fully ruled out (the loop also makes JavaScript objects). The instrument cannot measure either one directly.

So with one client, the p95 of an uncached page is about the median CPU times 1.8, plus the edge. **Less CPU per request also lowers the p95, by about the same factor.**

## Results at four clients (C=4)

Command: as above with `C=4 PAGES=home,post-new`. 30 renders per page, all 200.

| Page | Tail joined | Client p50 / p95 | Object (Worker's view) p50 / p95 | Object tail wall p50 / p95 | Object CPU p50 / p95 |
| --- | --- | --- | --- | --- | --- |
| home | 9 of 30 | 1,330 / 2,460 | 1,062 / 2,176 | 216 / 433 | 214 / 421 |
| post-new | 24 of 30 | 3,190 / 3,730 | 2,339 / 3,308 | 1,666 / 2,878 | 572 / 1,066 |

The object's CPU per request does not change with four clients. The rest is waiting.
- **Before the object's event starts:** the Worker's view minus the tail wall time is 915 ms at p50 for home.
- **Inside the event, after PHP:** the tail wall minus CPU is 1,110 ms at p50 for post-new.

One object runs one request at a time, because PHP with its database in the object never yields to the event loop. A request waits for the requests ahead of it to finish, and its response waits behind the PHP of the next one.

Locally (`wrangler dev`, where the clock moves), the same split was measured directly with `inbox` and `outbox`. Home, 16 renders:

| Clients | Object | Inbox | In (PHP) | Outbox |
| --- | --- | --- | --- | --- |
| C=1 | 67.5 | 0 | 67.5 | 0 |
| C=4 | 198 | 32.5 | 65.5 | 33 (max 136) |

The C=4 parts are medians of each column, so they do not add up to the object median; each request's own parts do. The PHP lock counter (`ahead`, `waitMs`) read 0 in every case: a second request never gets as far as the lock. A counter inside the object cannot see this queue.

## For tuning (not done here)

- **CPU per request is the lever for both p50 and p95 at one client.** The host's slow mode multiplies whatever CPU there is.
- A warm public page still inflates about 200 KiB of lazy PHP files on every request (`inflateKiB`). `evictLazy()` drops them after each request. That is CPU spent on every request.
- Under concurrency, one object serializes all PHP. Throughput is about 1 / CPU per request (about 4 public pages a second at 230 ms). Past that, every request queues. With the database in the object, the object cannot be split (`PHP_DO_POOL` does not apply).
- The edge time (about 270 ms) is from this laptop, with a new TLS connection for each request. A client near the site that keeps its connection pays less. The runner's figures (home p50 0.45 s) come from another vantage, so they are not directly comparable with this page.

## Measured non-lever: re-inflating lazy files

A warm home page re-inflates the same lazy files on every request, because `evictLazy()` drops them after each request. They are theme data that WordPress reads every request, not PHP code: `theme.json`, each style variation and typography preset of the theme, and block CSS.

| Method | n | Result |
| --- | --- | --- |
| `performance.now()` around each `entry.data()` (a temporary patch, reverted), `wrangler dev`, `dosql-local`, warm home | 20 requests | Median 58 inflations, 199 KiB, 1.0 ms a request (max 3); `phpMs` median 75.5 |
| The same 55 deflated files inflated in Node with the same fflate (the local clock has 1 ms steps, so the per-file sum can be low) | 200 rounds | 0.64 ms a request |

So keeping these files inflated would save about 1 ms of about 75 ms: about 1%. Not changed. The cost is what PHP does with the files, which the object cache (change 1) addresses.

## Overload answer (measured 2026-11-05)

With about 100 clients, the object's queue overflows. Its stub refuses with `Durable Object is overloaded. Requests queued for too long.` Before this change, that was an uncaught exception in the Worker, and the client got a 503 with no body and no headers.

Now `toPhpObject()` catches it. The client gets a 503 with a short `text/plain` body, `Retry-After: 5` and `Cache-Control: no-store`. A stored error would reach readers through the page cache after the queue drains, so the answer must not be cacheable. Any other error is thrown as before.

`wp-perf-dosql`, one build of `plugin-parity`, `index.js` without the change and then with it. 3 runs of each, alternating. Each run is `N=400 C=100 PAGES=home python3 tests/load/perf.py` with `wrangler tail`.

| Run | Non-200, before | Before: what the client got | Non-200, after | After: what the client got |
| --- | --- | --- | --- | --- |
| 1 | 8 of 400 | 503, no body, no headers; tail: 6 exceptions | 137 of 400 | 503 with the body, `no-store`, `Retry-After: 5`; tail: 0 exceptions |
| 2 | 21 | 503 bare; tail: 16 exceptions | 72 (71 of them 503) | the same answer; 0 exceptions; 1 client connection reset |
| 3 | 305 | 198 bare 503s, 48 answers of 520, 59 connection resets; tail: 183 exceptions | 161 | the same answer; 0 exceptions |

The answer is now honest in all 369 overload responses after the change: body, `no-store` and `Retry-After`, with 0 exceptions and no 520 in tail.

The count of overloads did not settle. It changed by a factor of 38 between runs of the same code before the change (8 to 305), which is more than any difference between the two codes, so these runs cannot say whether the count went up or down. A fast 503 frees the client at once, and it sends its next request into a queue that is still full. `perf.py` does not wait for `Retry-After`. Not measured further.

## Change 1: object cache across requests (measured 2026-11-05)

**Where the CPU was.** Two local instruments, before the change:
- **V8 CPU profile** of the worker that holds the object (`wrangler dev`, the inspector of workerd itself, 40 warm home requests, 3,507 ms busy): 78.9% in WebAssembly (the PHP interpreter), 12.4% in all JavaScript together (our bridge, the Emscripten glue, php-wasm and fflate are one bundle), 4.1% program, 1.5% garbage collection.
- **PHP phase times** (a temporary mu-plugin with `hrtime`, 20 warm home requests, 1 ms resolution): 45 of 67 ms between `template_redirect` and `wp_head`. That is the block template and theme.json. Then `init` to `wp_loaded` 8 ms, `parse_request` to `wp` 5 ms, `wp_head` to `wp_footer` 7 ms.

That work is mostly the same on every request; it is redone because a PHP request keeps nothing.

**The change.** `php/object-cache.php` (a loader) and `php/object-cache-js.php`.
- With `JS_OBJECT_CACHE`, WordPress's object cache keeps values across requests in a JavaScript Map in the object. The Map holds 8 MB; the least recently used value goes first. The Worker defines `JS_OBJECT_CACHE` in `wp-runtime.php` only when `PHP_IN_DO` and `DB_IN_DO` are on, and `OBJECT_CACHE` is not `off`.
- Within a request, values also stay in a PHP array.
- One object is the only writer of the database. Pages, REST, `/_install`, `/_activate`, `/_dbimport` and `/wp-cron.php` all run in it: `DISABLE_WP_CRON` is set, there is no `scheduled`, queue or alarm handler, and `ctx.storage.sql` is used only in the object. So WordPress's own updates and deletes keep the cache exact. `/_install` and `/_dbimport` change the database outside WordPress, so they clear the cache.
- The groups core marks non-persistent (`counts`, `plugins`, `theme_json`) stay per request.
- Without `JS_OBJECT_CACHE` the loader defines nothing. WordPress then loads its own cache, and `wp_using_ext_object_cache()` stays false. Measured: it reads false with `OBJECT_CACHE=off`.

**Transients.** With the cache on, WordPress keeps transients in the object cache, not in the database. They are lost when the isolate restarts (after a deploy, an eviction or a crash), or when the 8 MB cap pushes them out. The transient contract allows that: a transient can vanish at any time. Our own mu-plugins do not need a transient to survive:
- `edge-cache.php` only skips purges for transient options;
- the R2 upload name reservation is a SQL table in the object (`_r2_reserved`);
- `woo-edge.php` defers `_transient_*-transient-version` option writes. With the cache on, those transients never become options, so its filter does not run.

**A defect found by the gate, before merge.** The first version kept `theme_json` across requests. Its argument was that theme files cannot change within a deploy.
- **What broke.** A global style written through REST did not show on the next fresh page, once the cache held the old stylesheet. `tests/load/cache_coherence.py`, "global-styles restore shows": FAIL with the cache on, PASS with it off.
- **Why.** Core clears `theme_json` only from `wp_clean_theme_json_cache()`, which is hooked only to `switch_theme` and `start_previewing_theme`. Core relies on the group starting empty on every request, so saving a `wp_global_styles` post never invalidates it. Plugins also change theme.json data through the `wp_theme_json_data_*` filters.
- **Now.** `theme_json` stays per request. What keeping it would need: issue #49.
- **The speedup did not come from theme.json.** The delta below is the build that ships, and it is about the same as the delta measured with `theme_json` kept: home CPU p50 -31% then, -29% now.

**Measured on Cloudflare, the build that ships.**
- One build (`7151ed6`) deployed to `wp-perf-dosql` twice: with `OBJECT_CACHE=off` (version `ac3489d7`), then without it (`338e50be`).
- After each deploy, 3 warm-up renders per public page.
- Then `N=30 C=1 python3 tests/load/perf.py` and `N=80 C=8 PAGES=home`, with `wrangler tail`.
- Object CPU is tail `cpuTime`, in ms.

| Page | Tail joined (off / on) | CPU p50, off to on | CPU p95, off to on | Statements per page |
| --- | --- | --- | --- | --- |
| home | 27 / 23 | 209 to 148 (-29%) | 388 to 283 (-27%) | 32 to 4 |
| post | 20 / 21 | 232 to 168 (-28%) | 412 to 294 (-29%) | 40 to 4 |
| search | 19 / 17 | 218 to 150 (-31%) | 396 to 291 (-27%) | 37 to 4 |
| dashboard | 22 / 17 | 236 to 169 (-28%) | 439 to 319 (-27%) | 47 to 6 |
| post-new | 30 / 29 | 562 to 523 (-7%) | 1,050 to 976 (-7%) | 72 to 42 |
| edit | 21 / 19 | 270 to 219 (-19%) | 500 to 435 (-13%) | 48 to 8 |

Home at 8 clients: 80 requests in 21.1 s (3.79 a second) to 80 in 15.6 s (5.13 a second, +35%). All 200. No boots.

**Correctness gates on the build that ships.**

| Gate | Where | Cache on | Cache off |
| --- | --- | --- | --- |
| `e2e.sh` | local, `dosql-local` | 17 of 17 | 17 of 17 |
| `e2e.sh` | local, default env (no `JS_OBJECT_CACHE`) | 17 of 17 | not applicable |
| `tests/load/cache_coherence.py` (global styles, site title, post title, `/wp-cron.php` served by the object) | `wp-perf-dosql` | 0 fails | 0 fails |
| the same, plus WooCommerce on through `/_activate` and off through REST (`ACTIVATE=1`) | local, a build with WooCommerce, 3 runs | 0 fails, 2 runs | 0 fails |
| red control: a cache that keeps the first stored value of a key | local | 2 fails (site title, activation) | not applicable |
| `tests/break.py` | `wp-perf-dosql` | 21 pass, 5 fail | 21 pass, 5 fail, the same checks |
| plugin suite (`tests/plugins/plugins.py`, 18 plugins in the 7 groups of `plugin-suite.sh`) | local, `dosql-local` | 18 of 18 pass (`7151ed6`) | 18 of 18 pass (the tree before the merge of #47, which changed only the Worker's overload answer) |

Notes on the gates:
- **`break.py`.** The 5 checks that fail in both modes are uploads (R2 delete, Images sizes, a long upload path, the purge of a deleted upload, a 6 MB upload). R2 is not on for the Free test account, so the site has no `MEDIA` binding.
- **Plugin suite, `ocCalls`.** In the same run, `x-perf` `ocCalls` read 110 to 135 on the first page of each group and 35 to 45 after the plugins ran, so the cache was on.
- **Plugin suite, `function` step.** The same 10 plugins fail their `function` step in both modes and in the B Paid results (`tests/plugins/results/b-paid.jsonl`). That step needs the network, and PHP here has none (issue #26). It does not fail a plugin.
- **One 503 on a WooCommerce deactivation, locally, not reproduced in 2 more runs.** On Cloudflare, WooCommerce on b-dosql recycles the runtime on every request (WebAssembly memory above 100 MiB). Requests then wait long enough in the object that even one client got the overload answer, and a deactivation through REST got it too (it worked on the 5th try, 15 s apart). So `ACTIVATE=1` is a local check only; WooCommerce on b-dosql is out of scope.

Locally, two A/B runs of the same code gave home PHP ms 91.5 to 64.5 (new install, low load) and 115 to 177.5 (load average 10 to 14 from other work on the laptop). Local wall times are not used for the delta.

**Not measured:** the cache after an isolate restart (it starts empty, as after a deploy); memory near the 8 MB cap (the test site used 382 keys, 208 KiB); the runner's load matrix with the change.

## Not measured

- Worker CPU for each request in this run (Worker tail events have no request id to join on).
- Garbage collection, directly.
- The host's CPU speed, directly.
- The runner's vantage with this instrument.
- The post page "8 of 10 answered" in an earlier `deploy.sh` result for `wp-ref-dosql`. It did not repeat: 300 instrumented samples and 180 renders by `deploy.sh` on `wp-perf-dosql` all answered 200.

## Reproduce

```sh
set -a; . <token file>; set +a          # CLOUDFLARE_API_TOKEN, ACCOUNT_ID
PORT=8801 NAME=wp-perf-dosql VARIANT=b-dosql N=30 ./deploy/deploy.sh
wrangler tail wp-perf-dosql --format json > tail.jsonl &
B=https://wp-perf-dosql.<subdomain>.workers.dev ADMIN_PASSWORD=... SPIKE_TOKEN=... N=30 C=1 OUT=c1.jsonl python3 tests/load/perf.py
B=... N=30 C=4 PAGES=home,post-new OUT=c4.jsonl python3 tests/load/perf.py
B=... N=30 PAGES=home,post-new OPCACHE=1 OUT=op.jsonl python3 tests/load/perf.py
python3 tests/load/perf_tail.py c1.jsonl tail.jsonl
```

The admin password and the spike token come from Terraform: `cd deploy/terraform && terraform workspace select wp-perf-dosql && terraform output -raw admin_password` (and `spike_token`).
