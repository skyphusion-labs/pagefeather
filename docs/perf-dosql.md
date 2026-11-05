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

That work is the same on every request; it is redone because a PHP request keeps nothing.

The re-inflation that this page pointed at first (about 200 KiB of lazy files on each warm request) costs about 1 ms. The files are theme.json, style variations and block CSS. So it was left as it is.

**The change.** `php/object-cache.php` (a loader) and `php/object-cache-js.php`.
- With `JS_OBJECT_CACHE` (defined only when `PHP_IN_DO` and `DB_IN_DO` are on, and `OBJECT_CACHE` is not `off`), WordPress's object cache keeps values across requests in a JavaScript Map in the object. The Map holds 8 MB; the least recently used value goes first.
- Within a request, values also stay in a PHP array.
- One object is the only writer, so WordPress's own deletes keep the cache exact.
- `theme_json` is kept too. The theme files cannot change within a deploy, and core deletes that group when user styles change.
- `/_install` and `/_dbimport` clear the cache.
- Without `JS_OBJECT_CACHE` the loader defines nothing. WordPress then loads its own cache, and `wp_using_ext_object_cache()` stays false. Measured: it reads false with `OBJECT_CACHE=off`, and `e2e.sh` passes 17 of 17 in the default env.

**Measured on Cloudflare.** `wp-perf-dosql`, one build (`2f0ab5d`), deployed with `OBJECT_CACHE=off` (version `ad4ed5b2`) and then without it (`6b4b0589`). After each deploy, 3 warm-up renders per public page. Then `N=30 C=1 python3 tests/load/perf.py` and `N=80 C=8 PAGES=home`, with `wrangler tail`. Object CPU is tail `cpuTime`, in ms.

| Page | Tail joined (off / on) | CPU p50, off to on | CPU p95, off to on | Statements per page |
| --- | --- | --- | --- | --- |
| home | 27 / 21 | 213 to 147 (-31%) | 392 to 291 (-26%) | 32 to 4 |
| post | 24 / 19 | 244 to 173 (-29%) | 436 to 334 (-23%) | 40 to 4 |
| search | 19 / 18 | 221 to 152 (-31%) | 385 to 321 (-17%) | 37 to 4 |
| dashboard | 20 / 16 | 234 to 153 (-35%) | 429 to 396 (-8%) | 47 to 6 |
| post-new | 29 / 30 | 572 to 529 (-8%) | 1,035 to 777 (-25%) | 72 to 42 |
| edit | 19 / 19 | 270 to 199 (-26%) | 582 to 424 (-27%) | 48 to 8 |

Home at 8 clients: 80 requests in 21.1 s (3.80 a second) to 80 in 15.7 s (5.08 a second, +34%). All 200. No boots.

Locally (`dosql-local`, one build, warm, N=20 per page, PHP ms median, off to on): home 82 to 67, post 89 to 63, search 82 to 57, dashboard 83 to 57, post-new 219 to 213, edit 108 to 81.5.

**Not measured:** the cache after an isolate restart (it starts empty, as after a deploy); memory near the 8 MB cap (the test site used 409 keys, 254 KiB); the runner's load matrix with the change.

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
