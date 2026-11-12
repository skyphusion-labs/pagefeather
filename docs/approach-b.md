# Approach B: WordPress on D1

> **Status:** the D1 variant on this page is historical (checkout exceeds the memory limit on D1). The current variant is b-dosql (section 8j, [perf-dosql.md](perf-dosql.md)). The scalable path is [approach A](approach-a-overview.md). Docs map: [README.md](README.md).

WordPress runs as PHP compiled to WebAssembly in a Worker. Its database is D1. There is no MySQL and no server.

Status: WordPress runs on D1 in local workerd (spike B2), and is deployed on Workers Free, where CPU time decides if a page renders. Findings below are from 2026-11-03.

**Read this first:** this page is about B with D1. The variant the framework runs for sites and WooCommerce stores is **b-dosql** (section 8j and [perf-dosql.md](perf-dosql.md)). It keeps SQLite inside the Durable Object, and checkout works on it. See the README matrix. The checkout failure in 8f below is a D1 result.

## The parts

| Part | Choice | Why |
| --- | --- | --- |
| PHP | `@php-wasm/web-8-3` 3.1.62, JSPI build (GPL-2.0-or-later) | Open source. It has `pdo_sqlite`, `mbstring`, `openssl`, `zlib` and `libxml`. It has an `instantiateWasm` hook, so the Worker can pass a bundled module. The HostlessWP engine is binary only, so we cannot build on it. |
| MySQL to SQLite | `sqlite-database-integration` (`WP_SQLite_Driver`) | WordPress sends MySQL. This driver parses it and writes SQLite. |
| Database | D1 binding | The goal of approach B. |
| Files | WordPress core, theme and plugins bundled; uploads in R2 | Same as HostlessWP. |

## Findings

### 1. PHP can wait for D1. Measured.

D1 is async. PHP runs synchronously. JSPI lets WebAssembly pause on a JavaScript promise.

Local workerd (Wrangler 4.157.0, compatibility date 2026-07-01) returned:

```
{"Suspending":"function","promising":"function","Tag":"function"}
```

So `WebAssembly.Suspending` and `WebAssembly.promising` exist. Not yet checked on the deployed runtime.

### 2. The PHP engine fits.

The JSPI `php_8_3.wasm` is 18,065,768 bytes, and 6,975,027 bytes after `gzip -9`. The Worker size limit is 64 MiB on both plans. Memory is 128 MB per isolate, so WordPress plus PHP must fit in that. Not yet measured.

### 3. The driver uses a small part of PDO.

`WP_SQLite_Connection` accepts a `PDO` instance in `$options['pdo']`. The driver and its information schema classes call only these: `prepare`, `execute`, `query`, `fetchAll`, `fetchColumn`, `columnCount`, `rowCount`, `lastInsertId`, `quote`, `setAttribute`.

Plan: a `D1_PDO` class that extends `PDO` and sends each statement to the D1 binding through JSPI. Counted with `grep` on `sqlite-database-integration` at `f05c1f9`.

### 4. Blocker: the driver needs PHP functions inside SQLite.

The driver registers 43 PHP functions in SQLite with `PDO::createFunction` (`class-wp-sqlite-pdo-user-defined-functions.php`). The SQL it writes calls them. Examples: `year`, `month`, `unix_timestamp`, `now`, `rand`, `md5`, `regexp`, `field`, `from_unixtime`, `get_lock`.

D1 cannot run a PHP function. A query that uses one fails on D1.

Fix: a D1 dialect in the translator. Each function becomes plain SQLite where it can:

| Function | SQLite form |
| --- | --- |
| `year(x)` | `CAST(strftime('%Y', x) AS INTEGER)` |
| `month(x)` | `CAST(strftime('%m', x) AS INTEGER)` |
| `now()` | `datetime('now')` |
| `unix_timestamp(x)` | `CAST(strftime('%s', x) AS INTEGER)` |
| `rand()` | `(random() / 18446744073709551616.0 + 0.5)` |
| `field(x, a, b)` | `CASE x WHEN a THEN 1 WHEN b THEN 2 ELSE 0 END` |
| `get_lock`, `release_lock` | Answer `1` without a query. One request runs at a time per isolate. |
| `md5`, `regexp` | No SQLite built-in. Compute in PHP when an argument is a constant. Otherwise fail with a clear error and list it in the compatibility table. |

The same work is needed for a Durable Object's SQLite, so it is not wasted if we add that backend.

### 4a. The D1 dialect works. Measured locally.

`php/d1-dialect.php` rewrites each driver function before the statement goes to D1. `tests/dialect-test.php` passes 10 of 10. After a clean install, `e2e.sh` passes 17 of 17 requests with 0 D1 failures, including the editor (`YEAR()`) and the date archive.

Known gaps: `RAND(seed)` ignores the seed; `WEEK()` uses `%W`, not ISO weeks; `THROW` loses its message; `MD5`, `REVERSE`, base64, `INET_*` and `FROM_UNIXTIME(x, format)` work only with constant arguments; `REGEXP` works only on one table with a constant pattern, and reads the whole column.

### 5. Every query is a round trip. Not yet measured.

Each MySQL query from WordPress becomes one or more SQLite statements. Each statement is one call to D1. An uncached page can make 30 to 100 calls.

- Run the Worker next to the database (placement hint or Smart Placement). Measure the cost of one call.
- Send read-only statements in a `batch()` where the driver allows it.

### 6. The Free plan's limit is CPU, not D1 queries. Measured locally.

Local results (spike B2, `docs/results.md`):

- Logged-out pages make 11 to 37 D1 calls. The Free limit is 50 per invocation ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)), so these pages fit.
- The admin dashboard makes 116 calls and the editor 123. These need Paid (1,000).
- PHP takes 444 to 1,033 ms per page. D1 is 18 to 94 ms of that. The Free CPU limit is 10 ms per request ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)).

So on Free, logged-out pages must come from a page cache. Admin and post saves need Paid. Local time is wall time, not billed CPU time. A deploy must measure CPU time.

### 7. What D1 refuses, found by running WordPress

| D1 refuses | Spike B2 answer |
| --- | --- |
| `sqlite_version()` | Fixed answer `3.45.0`. |
| Pragmas on its own `_cf_*` tables | Hidden from schema reads. |
| Unknown pragmas (the driver's empty-result trick) | Answered locally. |
| `BEGIN`, `SAVEPOINT` and friends | Not sent. No rollback. |

The plugin's installer also opens its own database connection. The build patches it to use the D1 one.

### 8. Deployed on Workers Free: CPU decides. Measured.

The deploy account turned out to be on Workers Free. Results:

- WordPress pages need 1,434 to 1,934 ms of CPU each (Workers analytics, p50 to p99 of successful renders).
- Free stops a request at about 2,010 ms of CPU (`exceededResources`, error 1102). The documented Free limit is 10 ms; the observed hard stop is about 2 s.
- So some pages render and most do not. The install never fits; the database was loaded from a local install.
- Wall times inside the Worker are not useful: Workers freeze the clock during CPU work.

### 8a. Deployed on Workers Paid: everything works. Measured.

Same build, same code, on an account on Workers Paid, with `cpu_ms = 30000`. Results on 2026-11-04:

- `/_install` completes in one request: WordPress installed, 1,059 D1 queries, 32 s wall time. The documented limit is 1,000 D1 queries per invocation; this request made 1,059 and was not stopped.
- `e2e.sh` passes 17 of 17 with 0 D1 failures: pages, feed, search, archives, REST, login, dashboard (116 queries), editor (124), publish a post (79).
- CPU per request (Workers analytics, 70 requests, 0 errors): p50 845 ms, p90 1,668 ms, max 3,485 ms. The max is the installer or the first request after deploy; analytics does not say which.
- On Free, successful renders had a p50 of 1,434 ms. A possible cause of the difference: on Free most requests end in error 1102, and the next request boots a new PHP runtime. Not measured.
- The installer reported one failed statement: a read of the driver table `_wp_sqlite_global_variables`. The install completed.

### 8b. Break test on Workers Paid. Measured 2026-11-04.

`spikes/b2-wordpress/tests/break.py` tries to make the deploy fail. First run, then the fix, then the result on the same deploy:

| Attack | Before | Fix | After |
| --- | --- | --- | --- |
| 30 parallel requests | 2 or 3 of 30 return 500 (runtime crashed, 0 D1 calls). Locally, on one isolate, half crash. | Requests that use PHP run one at a time per isolate. PHP is not re-entrant. | 90 of 90 return 200, in 3.5 to 4.0 s per batch of 30. |
| A post of 100 KB or more | D1 refuses: `statement too long: SQLITE_TOOBIG`. The driver writes values into the SQL. D1 refuses a statement over 100 KB. | Over 90 KB, the dialect moves string literals of 1 KB or more into bound parameters. | 100 KB, 500 KB and 1.9 MB posts save and read back. A row still has the D1 limit of 2 MB. |
| A 4 MB request body | 500: the isolate runs out of memory (`RangeError: Invalid array buffer length`). The response shows the JS stack. | Bodies over 2 MB get 413. A 500 shows the stack only to a spike-token holder. | 413. |
| A search term over about 48 bytes | The count query fails: `LIKE or GLOB pattern too complex`. D1 refuses a LIKE pattern over 50 bytes. | `col LIKE '%term%'` with a long term becomes `instr(lower(col), lower('term')) > 0`. | 0 D1 failures for 200 bytes and 50 emoji. |
| `GET /wp-content/db.php` | PHP fatal error with file paths, shown to the visitor. Database errors also showed SQL and a backtrace. | A deploy sets `WP_DEBUG` false and `display_errors=0`. | 500 with an empty body. |
| `system.multicall` on `xmlrpc.php` | 50 password tries in one request, 0.7 s. | `xmlrpc.php` returns 403 unless `XMLRPC=on`. | 403. |
| Media upload | 201, then the file is served by one isolate only (1 of 5 fetches). | The R2 Uploads mu-plugin stores the media library in R2; the Worker serves `/wp-content/uploads/*` from R2. Design from Human Made's S3 Uploads (`docs/prior-art.md`). | Paid: 5 of 5 fetches 200. Thumbnails made by GD are in R2. Admin multipart upload works. Delete removes every size (404). Free: R2 is not on for the account (code 10042), so not fixed there. |

Second break test, on the R2 media library (round 4):

| Attack | Before | Fix | After |
| --- | --- | --- | --- |
| Large images (a 26 KB PNG of 3000x3000; 6000x6000; 12000x12000) | 3000x3000: 500 after 12 s. 6000x6000 and up: error 1102. GD decodes every pixel in the 128 MB isolate. A normal phone photo is larger than 3000x3000. | `php/cf-images-editor.php`: a WordPress image editor that sends every resize, crop, rotate and flip to the Cloudflare Images binding. Bytes go R2, Images, R2 in the Worker and never enter PHP. `.info()` gives the size and is not billed. | 3000x3000 and 6000x6000: 201 with all 7 sizes, pixel-exact, and the WordPress `-scaled` copy. 12000x12000 (over the Images limit of 100 megapixels): 201, no sizes. The site stays up. A center crop is a crop, not a squeeze (checked by pixel color). Delete removes all sizes. |
| 8 parallel uploads with one file name | 3 distinct files. 5 attachments show another upload's image. `wp_unique_filename()` checks, then writes; two isolates both pass the check. | The Worker reserves each name with one atomic D1 insert (`_r2_reserved`). A taken name gets the next `-N`. | 8 distinct files, each with its own content. |
| `Range` request on an upload | 200 with the full file. Video seeking needs 206. | The upload route passes `Range` to R2 and returns 206 with `Content-Range`. HEAD has `Content-Length`. `X-Content-Type-Options: nosniff` on every upload. | 206, 10 bytes. |
| A 2,000-character upload path | Error 1101 (the Worker threw). R2 keys are at most 1,024 bytes. | Longer keys get 404 before R2. | 404. |

Also tried, no failure: path traversal on the upload route (403), file names with `+ & =`, `..png` and `shell.php.png` (WordPress makes them safe), SVG, HTML and PHAR uploads (WordPress refuses them), a UTF-8 file name sent as RFC 5987 `filename*`.

The Images binding is on both plans. Images Free includes 5,000 unique transformations a month; past that, new transformations fail with error 9422 and nothing is charged. An upload uses one transformation per image size (up to 7). Source: [Images pricing](https://developers.cloudflare.com/images/pricing/), read 2026-11-04.

Also tried, no failure (round 3): SQL injection strings in search, NUL bytes, `wp-config.php` and path traversal (403 or 400), 12 parallel post creates (12 unique ids), an anonymous comment. Stock WordPress behavior, not changed: `/?rest_route=/wp/v2/users` lists user names. Each failed login costs CPU on Paid; a workers.dev address has no rate limiting rule, so a zone is needed for that.

### 8c. Page cache (Workers Cache). Measured 2026-11-04.

`[cache] enabled = true` puts Cloudflare's cache in front of the Worker. On a hit, no Worker code runs, so a cached page uses no CPU. The cache is tiered and collapses simultaneous misses into one render.

- The Worker marks a response cacheable (`Cache-Tag: wp-pages`) only for a logged-out `GET` or `HEAD` with status 200, 301 or 404, no `Set-Cookie`, no WordPress cookie on the request, and not admin, login, preview or spike paths.
- Cookies: see "Cookies (issue #63)" below. Until #63, `Vary: Cookie` kept a logged-in visitor off the cached page, and it also split the cache by every other cookie.
- The Edge Cache mu-plugin (`php/edge-cache.php`) asks the Worker to purge the `wp-pages` tag when content changes (posts, comments, terms, menus, theme, site options). A deleted upload is purged by path.
- Each deploy starts with a cold cache, because the Worker version is in the cache key.
- With the cache on, every request counts as a billed Worker request, static assets too. On Free that counts against 100,000 requests a day.

Results:

| Plan | Test | Result |
| --- | --- | --- |
| Paid | `tests/break.py` | 23 pass, 0 fail: a logged-out page is a cache HIT; a logged-in visitor gets BYPASS and the admin bar; a new post is on the cached page within seconds; a deleted upload is 404 in the cache. |
| Free | cold cache: 5 pages, retry until 200 | 4 pages on the first try, 1 on the second. |
| Free | then 50 reader requests over the 5 pages | 50 of 50: 200, cache HIT. |

On Free, this makes approach B usable for readers. Writers and admin still need Paid.

**Cookies (issue #63). Measured 2026-11-06.** The 50 of 50 above came from a client with no cookies. Workers Cache compares a `Vary` header verbatim, so `Vary: Cookie` keyed each cached page on the whole Cookie header. On `wp-perf-dosql`, the same page read 7 times with `curl`:

| Request | Before #63 |
| --- | --- |
| no cookie, twice | MISS, then HIT |
| `_ga=GA1.1.111.222`, twice | MISS, then HIT |
| another `_ga` value | MISS |
| `sbjs_current=...` | MISS |
| no cookie | HIT |

So a reader with any cookie that is not WordPress's missed, and each `_ga` value had its own entry: in practice every first visit missed.

The fix is c1's pattern (#58), as the Workers Cache docs describe it (per-entrypoint caching, cache keys):
- Only the `Pages` entrypoint is cached (`exports.Pages.cache` in `wrangler.toml`, and in the config `deploy/deploy.sh` makes). The default entrypoint is a gateway with its cache off.
- The gateway sends `Pages` a `GET` or `HEAD` that has no WordPress cookie (by name: logged in, post password, comment author, WooCommerce) and is not an admin, login, cron, spike, `preview` or `nocache` request, without its Cookie header. So the cache key is the path and the query alone. Every other request runs in the gateway, uncached.
- A purge reaches only the cache of the entrypoint that calls it, so the purge runs in `Pages.purge()` (through `ctx.exports`).
- **The browser now gets `Cache-Control: no-cache` on cached HTML.** The edge directive is `cloudflare-cdn-cache-control: max-age=120, stale-while-revalidate=600`, which Cloudflare reads and does not send on. Without `Vary: Cookie`, a browser that kept the logged-out page could show it after a login. With `no-cache`, it asks again.
- A response that is not cacheable gets `cloudflare-cdn-cache-control: no-store`, so WordPress's own `no-cache` is not stored at the edge as a stale entry.

Gate: `spikes/b2-wordpress/tests/cookie_cache_check.py`. On `wp-perf-dosql`: before #63, 8 fail; after, 14 of 14. The checks are:
- HIT with no cookie, with `_ga`, with another `_ga` value, and with `sbjs_*`;
- the gateway (not the cached copy) with a cart cookie, a post password cookie, or logged in (with the admin bar);
- the browser gets `no-cache`, and there is no `Vary: Cookie`.

Locally, workerd has no Workers Cache, so the gate checks only the route (`x-entrypoint: pages`) and skips the HIT checks. `break.py` (same PASS/FAIL set) and `cache_coherence.py` (0 fails) pass; "publishing a post purges the cached page" passes.

**Purges.** Counted with `wrangler tail` over one `break.py` run. Each purge request and each purge sent is a log line (`{"m":"purge"}`); a refused purge is now logged, before it was dropped.
- Before the change below: 27 requests, 20 purges sent, 0 refused. One request came from opening the editor (`post-new.php` makes an auto-draft).
- With it: 26 requests, 20 purges sent in 32 s, 0 refused.
- The cause of 20 sends is that `PURGE_GAP_MS` (15 s) coalesces per isolate. `break.py` writes in parallel, so many isolates purge. 20 is inside the burst of 25, but above the rate of 5 a minute. Since issue #78 the object coalesces for the whole site (below).
- `php/edge-cache.php` no longer purges for an auto-draft, which is on no page. c1 uses the same file. A draft still purges: it may be a post that was just unpublished.

**Purges for the whole site (issue #78). Measured 2026-11-06.** With PHP in the object (`b-do`, `b-dosql`, pool of 1), every change of content passes through the one `PhpRuntime` object, so the object coalesces the purges, as c1 does in its Store object:
- `requestPurge()` stores `{pending, lastSent, lastAsked}` in the object's storage and sets one alarm for `max(now, lastSent + PURGE_GAP_MS)`.
- `alarm()` sends one purge for everything asked since the last one, through `ctx.exports.Pages.purge()`. The object's own `ctx` has `exports` (probed). A change during a purge asks for the next one. A refused purge is tried once more one interval later. The state is stored, so a purge asked for survives an evicted object.
- `/_purgestate` (spike token) returns the state and the last 20 sends. `wrangler tail` showed no alarm runs and dropped request events (18 of about 60), so it cannot count purges.
- Variants with PHP in the Worker (`free`, `paid`, `a`) keep `PURGE_GAP_MS` per isolate. With a pool of more than one object, each object coalesces on its own.

Gate: `spikes/b2-wordpress/tests/purge_coalesce_check.py` (locally through `tests/purge-coalesce.sh`). It makes 20 posts in parallel, 10 more 5 s later, then deletes them, waits two windows, and reads `/_purgestate`.

| Where | Purges sent | Gaps (ms) | Result |
| --- | --- | --- | --- |
| local `dosql-local` | 1 | | 6 of 6 |
| local, mutation: no coalescing (control) | 20 (the last 20 kept) | about 35 each | 2 fail |
| `wp-perf-dosql` (Free test account) | 3, all accepted | 15000, 15001 | 6 of 6 |

The same deploy: `cookie_cache_check.py` 14 of 14; `break.py` the same PASS/FAIL set, including "publishing a post purges the cached page". Locally the transaction gates and `cache_coherence.py` are unchanged.

### 8d. Phone-size uploads. Measured 2026-11-04.

The 2 MB body cap (8b) blocked a normal phone photo (3 to 14 MB). Now a media upload of more than 1 MB, up to 20 MB (the Images binding input limit), does not go through PHP:

- The Worker stores the file in R2 under `staging/` before PHP runs. It reads the type from the first bytes and flags HTML, script or PHP content. PHP gets a small marker file instead.
- The mu-plugin uses the sniffed type in `wp_check_filetype_and_ext` (an image must match its extension). After WordPress picks the final name, the Worker copies the staged object there, inside R2.
- An R2 lifecycle rule deletes `staging/` objects after 1 day, so a refused upload leaves nothing behind.
- The stream wrapper reads byte ranges (64 KB first, then 1 MB) instead of whole objects, and caches HEAD results per request.
- `wp_get_image_alttext()` reads the whole file to find XMP, twice per upload. It gets the first 1 MB only: in a JPEG, XMP is in an APP1 segment before the image data.
- Sub-sizes are queued and made in parallel in one Worker call, not one Images call after another.

| Test (Paid) | Result |
| --- | --- |
| 13.7 MB, 12 megapixel JPEG: REST raw, REST multipart (block editor), `async-upload.php` | 201 / 201 / 200. All 7 sizes pixel-exact; the original is byte-identical; `-scaled` copy made. WebAssembly memory 60 to 72 MiB. |
| Time on Cloudflare for the 13.7 MB upload (sum of R2 and Images calls, `x-r2-ops`) | 116 range reads and 7 serial Images calls: about 30 s. After the fixes: about 13 s; a 9.4 MB photo about 9 s. Client time adds the upload itself. |
| HTML named `.jpg`, 1.5 MB | Refused. |
| 21 MB | 413. |

Purge limits: Workers Cache purges always have the Free-tier limits, 5 a minute with bursts of 25, per account. A busy site runs out. So pages use `max-age=120, stale-while-revalidate=600`, purges are best effort (at most one per 15 s per isolate), and uploads are `private, max-age=86400` (browsers cache them, the edge does not, so a deleted upload is gone at once). `tests/break.py` passed 27 of 27 twice in a row after this change.

### 8e. CPU: OPcache, and a boot with no copies. Measured 2026-11-04.

**OPcache was off the whole time.** PHP turns OPcache on only for the SAPIs in its own list (Apache, FPM, FastCGI, FrankenPHP, LiteSpeed, uWSGI). The php-wasm SAPI is `wasm`. `opcache_compile_file()` returned false, and every request compiled about 540 scripts. Two fixes made it work:

- `prepare.sh` patches the list in the WebAssembly binary: the entry `frankenphp` becomes `wasm`. Only the first 5 bytes change (`wasm\0enphp`), because the string table shares tails ("php").
- `opcache.file_update_protection=0`. OPcache does not cache a file changed in the last 2 seconds. The files are written at boot and the Worker clock barely moves, so every file looked new and nothing was cached.

Settings: shared memory 32 MB (the full `e2e.sh` uses 28.6 MB), `validate_timestamps=0`, and the file cache as a second level. `opcache.sh` runs `e2e.sh` against `wrangler dev`, then saves the compiled files (about 600) to `build/opcache.zip`, which ships with the Worker. The same PHP build runs locally and on Cloudflare, so the files match.

**One runtime must compile everything (issue #84). Measured 2026-11-06.** The compiled files live in the PHP runtime's own file system, and a runtime is dropped after a request whose WebAssembly memory passes 100 MiB. With WooCommerce and All-in-One WP Migration, priming dropped the runtime 3 times, each at 119 MiB: on `post-new.php`, a REST posts request, and `/wp-admin/`.
- When a later request booted a new runtime, `opcache.zip` held only what compiled after the last drop: 1883 files, against 2227 without drops. Nothing reported it.
- When the last request dropped it, the dump answered 409 "not booted", and the `wp-ref-a` deploy failed.

What changed:
- `opcache.sh` runs the dev server with `PHP_RECYCLE:off` (through `run.sh`'s `DEV_VARS`): no recycle for memory while priming. Local workerd has no 128 MB isolate limit, and a crashed runtime is still dropped.
- `/_opcache-dump` answers with `x-isolate` and `x-runtime-drops` (runtimes dropped without a plan; the restart of `/_activate` is planned and not counted).
- `opcache.sh` reads the isolate before the pages, and saves nothing unless the dump comes from the same isolate (no reload) with 0 drops. A 409 names its causes and prints the end of `dev.log`.

**The boot copied 54 MB.** Unzipping the PHP files (26 MB) and the compiled files (28 MB) cost more CPU than compiling saved. Now nothing is copied at boot:

- The Worker reads each zip's central directory once and makes empty file nodes with the right size.
- A PHP file (`site.zip`, deflated) is inflated on its first read only. A page reads about a quarter of them.
- A compiled file (`opcache.zip`, stored) is a view of the bundled bytes (MEMFS `canOwn`), with no copy.
- Two stored zips are too big: a 72 MB Worker was refused. The limit is 64 MiB uncompressed, not the gzip size.

Boot file setup locally went from 228 to 286 ms to 45 to 58 ms.

CPU per request on Paid, median, from `wrangler tail` (each request logs whether it booted PHP). At low traffic, most requests land on a new isolate.

| Configuration | Cold (boots PHP) | Warm |
| --- | --- | --- |
| OPcache off (before) | 2,684 ms (n=32) | 957 ms (n=4) |
| OPcache on, compiled files shipped | 2,151 and 2,238 ms | 428 and 837 ms |
| plus the boot with no copies | **1,136 and 1,281 ms** | **660 and 398 ms** |

WebAssembly memory after a page is 69 MiB with OPcache (the runtime recycle limit is now 100 MiB; at 80 MiB, every request booted a new runtime).

**Free:** a cold render now mostly fits under the CPU limit of about 2 s. 12 requests for `wp-login.php` (10 of them on a new isolate): 11 were 200, 1 was "Worker exceeded CPU time limit". `e2e.sh` on Free (logged in, admin, editor, publish), 3 runs after the fixes: 17 of 17, 12 of 17, 9 of 17. Every failure was the CPU limit; the admin pages are the heaviest. Before the fix below, some runs also had 524: a request that Free stops for CPU could leave the isolate with the PHP lock held, so later requests waited until 524. A waiter now gives up after 60 s and uses a new runtime. No 524 since.

### 8f. WooCommerce. Measured 2026-11-04.

WooCommerce 11.2.1 (pinned by SHA-256 in `build.sh`), tested by `tests/woo.py`: admin setup, a product, then a guest buys 2 with cash on delivery through the Store API.

**Locally (wrangler dev):** 12 of 12 pass. The order is `processing`, total 25.00, stock 20 to 18, and it shows on the orders screen. Checkout makes about 800 D1 queries.

Fixes this needed:
- Plugin `.js` and `.svg` files stay on the PHP side: WooCommerce registers a block only if its script file exists, and reads card icons (SVG) at runtime.
- The D1 dialect removes parentheses around `UNION` parts (`( SELECT ... ) UNION ( SELECT ... )`), which SQLite refuses. A part with its own `ORDER BY` or `LIMIT` becomes a subquery.
- A new store is in "coming soon" mode; `woo.py` turns it off.
- Order emails are deferred (`php/woo-edge.php`). PHP in a Worker cannot send mail.
- The WooCommerce installer is the heaviest request WordPress makes. It ran out of memory on Paid, so the database was loaded from a local install. Two `wrangler d1 execute --file` traps: serialized PHP objects contain NUL bytes, and the SQL splitter stops at the first one with only "Warning: leftover buffer", exit 0, and the rest of the file not run. Rewrite each NUL as `'||char(0)||'`. And a failed import was not rolled back.

**Paid:** 8 of 9 pass. The shop, product page, Store API cart and the cart session in D1 work. Each WooCommerce request uses 2 to 5 s of CPU (`wrangler tail`) and 4 to 10 s wall. **Checkout fails every time: `exceededMemory`** (4 to 7 s CPU, about 35 to 39 s wall). WebAssembly memory is 99 MiB after a WooCommerce page.

Tried, no change for checkout: OPcache shared memory 16 MB; deferred emails; a cap of 8 MB on inflated files in a request. Worse: no shipped OPcache files (simple Store API calls also ran out of memory, because compiling takes more memory than loading), and PHP's own allocator (`USE_ZEND_ALLOC=1`: 155 MiB).

**Free:** with WooCommerce active, every request failed with "Worker exceeded CPU time limit", the home page too. Login failed. WooCommerce is off again on the Free deploy.

**Why:** WooCommerce asks for a WordPress memory limit of 256 MB or more ([WooCommerce server recommendations](https://woocommerce.com/document/server-requirements/)). A Worker isolate has 128 MB for JavaScript, the bundled code and the PHP heap together. Checkout is the request that passes it. This was the D1 result at the time. Issue #20 then tried moving checkout to a Container; that path was retired (#214). Later, b-dosql (section 8j) ran checkout inside the Worker, and the README matrix records that result.

### 8g. Placement next to D1. Measured 2026-11-04.

`/_d1ping` (spike token) times 20 sequential D1 statements from where the Worker runs. D1 reports its primary only as `ENAM`.

| `[placement]` | Worker ran in | Median per D1 statement |
| --- | --- | --- |
| `mode = "smart"` | IAD | 39 ms |
| `region = "aws:us-east-1"` | IAD | 40 ms |
| `region = "gcp:us-east4"` | (no header) | 37 ms |
| `region = "aws:ca-central-1"` | YUL | 40 ms |
| `region = "gcp:us-central1"` | OMA | 35 ms |
| `region = "gcp:us-east5"` | CMH | 20 ms |
| `region = "azure:northcentralus"` | ORD | 19 ms |
| `region = "aws:us-east-2"` | ORD | 14 and 29 ms (two runs) |

The D1 primary is near Chicago. The Paid Worker is pinned to `aws:us-east-2`. A page with 30 to 90 D1 statements saves about 1 to 2 s of wall time. Containers can only be constrained to coarse regions (`ENAM`), so the checkout Container stays at about 46 ms per statement.

### 8h. Plugins. Measured 2026-11-05.

The 18 most popular plugins, tested one at a time by `tests/plugins/plugins.py`. Method and matrix: [docs/plugins.md](plugins.md). The work found three defects in approach B. All three are fixed.

**1. The Worker clock stops while code runs.** `Date.now()` moves only at I/O. PHP's `uniqid()` reads `gettimeofday()` until the microsecond changes, so a second `uniqid()` in one request looped until the CPU limit. wp-admin `plugins.php` and `themes.php` call it for a temporary file name. Contact Form 7 calls it on every request. Before the fix, each of these requests used 32 s of CPU (`exceededCpu`). Locally it took 0.1 s, because the clock moves there. In this build `gettimeofday()` reads `emscripten_date_now()`. `prepare.sh` now patches it so that each read returns at least 1 microsecond more than the last read. After the fix, `plugins.php` took 2.1 s on Paid. Before the fix, the suite passed 3 of 18 on Paid.

**2. A BLOB did not survive the D1 bridge.** PHP and the Worker send queries and rows as JSON. D1 returns a BLOB as an array of numbers, so PHP got an array. In the other direction, `json_encode()` returns false for a string that is not UTF-8. Wordfence keeps its settings in a BLOB column, and its activation stopped with a fatal error: `explode(): Argument #2 ($string) must be of type string, array given`. Binary values now travel as `{"$b": base64}`, both ways (`index.js`, `php/d1-pdo.php`).

**3. The Worker size limit sets how many plugins fit.** The limit is 64 MiB (65,536 KiB). WordPress with Jetpack is a 63,024 KiB upload (Wrangler "Total Upload"). With Elementor alone it is 58,186 KiB. All 18 plugins do not fit in one Worker, so `plugin-suite.sh` builds them in 7 groups. A real site on B can have a few large plugins, not all of them.

Also found:
- Plugins must be in the build (`PLUGINS=... ./build.sh`). On B, a plugin installed from wp-admin is written to the in-memory file system and is lost when the isolate stops.
- PHP has no network (issue #26). Update checks and the network parts of Akismet, Site Kit, Jetpack, WP Mail SMTP and Wordfence fail. Each outbound call waits for a timeout: Wordfence activation takes about 10 s.
- No plugin can send mail. Contact Form 7 accepts the form and returns `mail_failed`.
- `build.sh` kept an existing `build/opcache.zip`, so a new `site.zip` could run with OPcache files compiled from another tree (an A build ran B's compiled `wp-content/db.php`). Every measured deploy ran `opcache.sh` after `build.sh`, which writes a new zip, so no result was affected. `build.sh` now always starts with an empty zip.

### 8i. PHP in a Durable Object (issue #28). Measured locally 2026-11-05. Not deployed.

**Why.** On Workers Free a Worker request stops at about 2 s of CPU (8, 8e). A cold WordPress page needs about 1.2 s and an admin page more, so the plugin suite passed 0 of 18 on Free (8h). A Durable Object request has its own CPU budget. HostlessWP runs PHP in a Durable Object on Free and passed `e2e.sh` 17 of 17 on our Free test account (docs/approach-a.md). This mode uses the same design. Credit: docs/prior-art.md.

**Design.** `PHP_IN_DO=on` turns it on. Without the variable, B does not change: the Worker runs PHP as before.

- The Worker keeps static assets, R2 uploads (`serveUpload`), the body size checks, XML-RPC off, the spike token check and the page cache (Workers Cache in front of the Worker). It sends every other request to the `PhpRuntime` object, with the same URL, so WordPress sees the public origin.
- The object runs the same code as the Worker did: `boot`, `handle`, `withPhp` and the D1 bridge `handleMessage`. It reads `DB`, `MEDIA` and `IMAGES` from its own `env`. The bindings come from the same wrangler env, because the object is a class in the same Worker script. PHP sees no change.
- The object purges the page cache itself since issue #78, through `ctx.exports.Pages.purge()`, coalesced for the whole site (8c, "Purges for the whole site"). Its response carries `x-cache-purge` (`scheduled` or `coalesced`). Before #78 the object set `x-php-purge: 1` and the Worker purged, per isolate.
- `PHP_IN_DO=on` without the `PHP_RUNTIME` binding returns 500 on every request. It does not fall back to PHP in the Worker, because that fallback would hide the misconfiguration.
- Responses from the object carry `x-php-object` (the object name) and `x-object-ms` (Worker to object and back, PHP included).
- `/_d1ping` is answered by the object, so it measures D1 from where PHP runs.

**Decisions.**

| Question | Decision | Why |
| --- | --- | --- |
| How many objects | One by default (`PHP_DO_POOL=1`, object `php-0`). `PHP_DO_POOL=2` picks one at random, as HostlessWP does with 2. Spike endpoints (`/_install`, `/_opcache-dump`, `/_last`, `/_mem`) always go to `php-0`. | One object keeps one warm runtime and one warm OPcache. B already ran one PHP request at a time per isolate. A pool adds parallel PHP but also adds cold starts. Measure before raising it. |
| Where | Location hint `PHP_LOCATION=enam` (Eastern North America). The Worker has no placement. | D1's primary is near Chicago (8g). A hint applies only when the object is made, and objects do not move after that ([data location](https://developers.cloudflare.com/durable-objects/reference/data-location/), read 2026-11-05). The hint list has no finer region than `enam`, so the object can be in IAD (39 ms per D1 statement in 8g) and not ORD (14 to 29 ms). The Worker makes no D1 calls in this mode, so it can run near the visitor. |
| PHP lock | `withPhp` stays as it is, inside the object. | PHP is not re-entrant. An object can get a new request while PHP waits for D1, so one object can still run two requests at once without the lock. The lock and the runtime are module globals, so objects in one isolate share both. Locally, workerd ran `php-0` and `php-1` in one isolate: the first request to `php-1` did not boot PHP. |
| Cold start and keep-warm | No keep-warm. | An idle object is evicted from memory after 70 to 140 s ([lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/), read 2026-11-05). A cold boot then costs about 1.2 s of CPU (8e), which is in the object's budget. Logged-out pages come from the page cache and do not wake the object. If the deploy shows many cold boots (`x-boot: 1`), the next step is a Cron Trigger that calls the object (Free allows 5 Cron Triggers per account, [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), read 2026-11-05). |
| Workers Paid | Not used there. | B in the Worker passes 18 of 18 on Paid (8h). The object adds a hop and a second bill. HostlessWP also runs PHP in the Worker on Paid. |

**Cost.** Source: [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [limits](https://developers.cloudflare.com/durable-objects/platform/limits/), read 2026-11-05.

- Each request that goes to PHP is one Worker request and one Durable Object request. A page cache hit is neither, because Workers Cache answers before the Worker runs.
- Free: Durable Objects with the SQLite backend only (so the migration uses `new_sqlite_classes`). Per day: 100,000 requests and 13,000 GB-s of duration. Over a limit, "further operations of that type will fail with an error". The limits reset at 00:00 UTC.
- Paid: 1 million requests and 400,000 GB-s a month are included. Then $0.15 a million requests and $12.50 a million GB-s.
- Duration is wall time at 128 MB, "while the Durable Object is actively running or is idle in memory but unable to hibernate". An object that can hibernate is not billed while idle. This object has no WebSockets and keeps no timer after a request, so it should not be billed while idle. Not measured.
- Example: a page that takes 1 s of wall time in the object costs 0.128 GB-s. 13,000 GB-s a day is about 100,000 such pages, so the request limit and the duration limit are close to each other on Free.
- CPU: the limits page gives "30 seconds (default)" per request for SQLite-backed objects. Its FAQ also says objects "have the same per invocation CPU limits as any Workers do", and the Workers limits page gives Free 10 ms. The two statements do not agree. HostlessWP's 17 of 17 on our Free account shows that an object request there gets more than the Worker's 2 s. Our own number comes from the deploy.

**Measured locally** (wrangler 4.107.0, `wrangler dev`, 2026-11-05):

| Run | Command | Result |
| --- | --- | --- |
| OPcache files built through the object | `DEV_ENV=do-local ./opcache.sh` | Pass, 601 compiled files |
| e2e through the object | `DEV_ENV=do-local ./run.sh _ping`, then `./e2e.sh` | **17 of 17**, exit 0. Every response had `x-php-object: php-0`. |
| e2e, pool of 2 | `wrangler dev --env do-local --var PHP_DO_POOL:2`, then `./e2e.sh` | 17 of 17, requests on `php-0` and `php-1` |
| Purge crosses from the object | The REST post create in `e2e.sh` | `x-cache-purge: no-cache-api` (local has no cache API); `x-php-purge` does not reach the client |
| 12 parallel uncached GETs | `curl` of `/?p=1&nocache=N`, 12 at once | 12 of 12 were 200 |
| Mode on, binding missing (control) | `wrangler dev --var PHP_IN_DO:on` (default env) | 500 on every request; `e2e.sh` fails |
| Default env (no change) | `./run.sh _ping`, then `./e2e.sh` | 17 of 17 |

Time in PHP (`x-php-ms`, wall, local) is the same in the object and in the Worker: cold home page 470 to 507 ms in the object and 544 ms in the Worker; warm home page 91 to 109 ms and 105 ms; `post-new.php` 230 to 251 ms and 252 ms. The hop from the Worker to the object added about 1 ms warm (`x-object-ms` 111 against `x-php-ms` 110). `wrangler dev` does not report CPU time, so the local numbers are wall time only.

The 72 `ws.removeListener is not a function` errors in the log of the first `opcache.sh` run are not from this mode. The default env shows the same 72 on a new database. They come from PHP's socket code during the install (PHP has no network, issue #26).

**Found on the first deploy** (`wp-do-free`, version `40d14b5f`, measured by the lead 2026-11-05). `/_install` inside the object on Free worked: 901 queries, 56.7 s wall, 200. `/_d1ping` from the object: median 38 ms (34 to 59), so `enam` did not put the object near ORD (B Paid from ORD: 12 to 25 ms). Defect: every logged-out page answered 301 to `http://<host>:443/...`, and `e2e.sh` did not fail on those rows.

The cause on Cloudflare is not confirmed. In that version the object took its origin from the URL it got. An object URL of `http://<host>:443/...` gives exactly this redirect (mutation check below). But after the fix, `/_origin` on Cloudflare returned `objectUrl` `https://wp-do-free.vivijure-coldrun.workers.dev/_origin` (https, no `:443`). So that is not the URL the object gets now. The fix is proven: the old code fails `e2e.sh` with the injected URL, and the new code passes `e2e.sh` on Cloudflare.

Fix: the Worker sends its own origin in `x-wp-public-origin`. It always replaces a value a visitor sends, and only the Worker can reach the object. The object builds the request URL from that header and answers 500 without it. `/_origin` (spike token) returns the URL the object got and the origin it used. `e2e.sh` now fails on a redirect to another origin, and when `GET /` is not 200.

**Second deploy** (version `d40446cb`, code `a380065`, measured by the lead 2026-11-05 with `e2e.sh` and `wrangler tail`):

| Measure | Result |
| --- | --- |
| `e2e.sh` | 17 of 17, exit 0, new post present |
| Worker CPU per request | 1 to 4 ms |
| Object CPU per request | 64 ms (login) to 670 ms (`post-new.php`) |
| Outcomes | every one `ok` |
| `/_install` in the object | 901 queries, 56.7 s wall, 200 |

**Root cause, found 2026-11-05.** The 301 came back on a new site (`wp-ref-free`, code `a380065`): the first PHP request was `POST /_install`, and after it every public page answered 301 to `http://<host>:443/...`. `/_origin`, `home` and `siteurl` were correct, and a restart of the object cleared it. So the wrong value was runtime state, not data.

- During a new install, PHP's socket layer opens WebSocket connections to the site itself (WordPress tests its own URL). Locally the Worker logged two `GET /` requests with `upgrade: websocket` during `/_install`. These are the 72 `ws.removeListener` errors in the log (8i above); they appear only on a new install.
- Such a request waits behind the install (the PHP lock). `/_install` ends with `bootPromise = null`, so the next request in the queue boots the runtime, and that request is the loopback. `boot()` writes its origin into `wp-runtime.php` as `WP_HOME`, and that runtime then serves every later request. On Cloudflare the loopback URL was `http://<host>:443/` (a WebSocket to port 443, as an http URL).
- A Worker that runs PHP itself (B, the default) did not show this on Cloudflare. Probably a Worker cannot fetch its own workers.dev URL, so the loopback never arrives. Not measured.
- Two fixes, only in the object (the default path does not change):
  1. The Worker answers a request with an `Upgrade` header with 426. WordPress serves no WebSockets.
  2. A runtime serves only the origin it booted with: a request for another origin boots a new runtime. Responses from the object carry `x-boot-origin`.
- Test: `e2e.sh` also fails when `GET /` does not link to the site's own origin. The old checks did not see the defect locally: every row was 2xx.
- **Later (2026-11-06, issues #55 and #33):** both fixes now apply to every variant, not only the object. The `Upgrade` guard runs before the variant branch (#55: in variant `a` the loopback booted the runtime with `http://127.0.0.1:<port>`). And the origin no longer comes from a request at all: the runtime takes it from the var `SITE_ORIGIN` (the site's configured address; `deploy/deploy.sh` and `run.sh` set it), so no first request (the loopback, a health probe, a second host name) can pin it (#33). Without `SITE_ORIGIN`, the request's origin is used and the runtime reboots when it changes, in the Worker as in the object. Test: `tests/origin.sh` (install and the first page through `127.0.0.1`, then the page through `localhost`): before the change both pages linked to `127.0.0.1` (default env) or the first did (object); after it both link to the configured origin. `FALLBACK=1` checks the unconfigured case.

Red and green, locally (wrangler 4.107.0, new database each run, `POST /_install` through `127.0.0.1`, then `e2e.sh` through `localhost`):

| Code | Env | First `GET /` | `e2e.sh` | WebSocket request |
| --- | --- | --- | --- | --- |
| Before the fix | `do-local` | `x-boot: 0`, links to `127.0.0.1` 30 times, to `localhost` 0 | Fails: "does not link" | 200 (reached PHP) |
| After the fix | `do-local` | `x-boot: 1`, `x-boot-origin: http://localhost:18728`, 30 links to `localhost` | 17 of 17 | 426 |
| Before the fix | `dosql-local` | Same as before the fix on `do-local` | Fails | 200 |
| After the fix | `dosql-local` | Same as after the fix on `do-local` | 17 of 17 | 426 |
| (no change) | default | `x-boot: 0`, links to `127.0.0.1` | Fails | 200 |

The default env has the same weakness when an install and later requests use two origins, but the default path is kept as it is so that the B numbers stay valid. With one origin it passes (`e2e.sh` 17 of 17).

Mutation check, local (`~/scratch` script). The object was given `http://<host>:443/...`, as on the deploy:

| Code | `e2e.sh` |
| --- | --- |
| Before the fix, with that URL | Fails: 8 rows 301 to `http://localhost:443/` (the deploy symptom) |
| After the fix, with that URL | 17 of 17 |
| After the fix, no change to the URL | 17 of 17 |
| Default env | 17 of 17 |

**Not measured yet:** the plugin suite on Free through the object, cold boots and evictions, the page cache purge from the object, duration billing while idle, and the Images binding inside the object (R2 is not on for the Free test account, so `MEDIA` is not bound in `env.do-free`). Approach A with the object and the checkout Container with the object were not tried.

**Deploy:** `[env.do-free]` in `wrangler.toml` (Worker `wp-do-free`, its own D1 database, migration `v1` for `PhpRuntime`).

### 8j. The database inside the PHP object (issue #2). Measured locally 2026-11-05. Not deployed.

**Why.** With PHP in the object (8i), each statement still goes over the network to D1. Measured on Cloudflare from the object: median 38 ms per statement (8i). A page makes 20 to 70 statements, so that is about 0.8 to 2.7 s of wall time per page. The object has its own SQLite database (`ctx.storage.sql`). The SQLite driver already speaks SQLite. With the database in the object, no statement leaves the object.

**Design.** `DB_IN_DO=on`, only with `PHP_IN_DO=on`.

- PHP does not change. `php/d1-pdo.php` sends each statement through the same bridge. In the object, `handleMessage` runs it on `this.ctx.storage.sql` and not on `env.DB`.
- The object sets the database for each PHP run, under the PHP lock (`withPhp`). In the Worker it is always unset, so the D1 path does not change.
- One object holds the site, so `PHP_DO_POOL` does not apply: every request goes to `php-0`.
- The R2 name reservation (`_r2_reserved`) uses the same database.
- Responses carry `x-db: object-sqlite` and `x-db-rows: read=N written=N` (the billed units, from the cursor's `rowsRead` and `rowsWritten`).
- Failures are loud: `DB_IN_DO=on` without `PHP_IN_DO=on` returns 500 in the Worker. It does not fall back to D1.

**Differences from D1, and what the bridge does.** Source: [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) (last updated 2026-09-21) and [limits](https://developers.cloudflare.com/durable-objects/platform/limits/) (last updated 2026-10-29), read 2026-11-05.

| Subject | D1 | Object SQLite | Bridge |
| --- | --- | --- | --- |
| Call | `prepare().bind().raw()`, async, a network round trip | `exec(sql, ...bindings)`, synchronous, returns a cursor | `sqlStatement()` in `index.js` |
| Changed rows, last row id | `meta.changes`, `meta.last_row_id` | Not in the cursor (`rowsWritten` also counts index rows) | `changes()` and `last_insert_rowid()` in the same synchronous turn. `total_changes()` before and after: a statement that changes nothing reports 0. The row id is sent for an INSERT or REPLACE only. |
| BLOB | Array of numbers | ArrayBuffer | Sent to PHP as `{"$b": base64}`, as for D1 (8h). `{"$b"}` parameters are bound as bytes. |
| Booleans | Bound | Not stated | Bound as 1 and 0 |
| BEGIN, COMMIT, SAVEPOINT | Not supported | `exec()` refuses them | `d1-pdo.php` answers them in PHP, as for D1. Nothing changes. |
| Statement length, bound parameters | 100 KB, 100 | 100 KB, 100 | Same limits |
| Row, string or BLOB size | 2 MB | 2 MB | Same limit |

**Transactions.** Real since issue #60: an undo log in the object rolls back `ROLLBACK`, `ROLLBACK TO SAVEPOINT` and a request that stops midway. `ctx.storage.transaction()` around the PHP request cannot do it (probes T10 and T11). See 8l. Before #60, as on D1, `ROLLBACK` undid nothing.

**Size.** Per object: 10 GB on Paid. On Free, the limits table gives 5 GB per account and the FAQ gives 1 GB per object. Past the limit, writes fail with `SQLITE_FULL`; reads and deletes still work. The local test site is 409,600 bytes (`databaseSize`).

**Cost.** Source: [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) (last updated 2026-10-18), read 2026-11-05.

| | Free, per day | Paid, per month |
| --- | --- | --- |
| Rows read | 5 million | 25 billion included, then $0.001 a million |
| Rows written | 100,000 | 50 million included, then $1.00 a million |
| Stored data | 5 GB (total) | 5 GB-month included, then $0.20 a GB-month |

The page says storage billing starts in January 2026 and does not confirm that it is on now. The page does not define a row read. The cursor counts rows scanned.

Measured per request in `e2e.sh` (`x-db-rows`, local): a public page reads 157 to 217 rows and writes 0 (4 on `/?cat=1`). Login writes 4. `/wp-admin/` reads 507 and writes 42. `post-new.php` reads 438 and writes 33. Publishing a post reads 395 and writes 25. **On Free, rows read are the first limit:** 5 million a day is about 25,000 uncached public pages (at 200 rows), fewer than the 100,000 object requests. Rows written allow about 2,400 admin page views a day (at 42). Page cache hits use neither.

**Backups.** Point-in-time recovery: the database can be restored to any time in the last 30 days (`getBookmarkForTime()`, `onNextSessionRestoreBookmark()`, then `ctx.abort()`). It does not work in local development. The docs do not say whether it is on the Free plan. No restore endpoint is built yet. Not measured.

**Install, and moving a site in or out.**

- Install: `/_install` runs inside the object and writes to its own database. No other step.
- `dbmove.py export <url> <file> [--from-d1]` saves the database as JSON lines (`/_dbexport`): first the tables, then one INSERT with parameters for each row, then indexes, triggers and views, then an end line. `--from-d1` reads the `DB` binding instead, which moves a B site from D1. A dump without the end line is incomplete, and import refuses it.
- `dbmove.py import <url> <file> [--replace]` loads a dump (`/_dbimport`) in parts of up to 1.5 MB (the Worker refuses a body over 2 MB). Each part is one transaction. Import refuses when tables exist. `--replace` drops all tables first, in the transaction of the first part. Any page view of an empty object makes the SQLite driver create its own tables, so a new site usually needs `--replace`.
- Both run under the PHP lock and need the spike token.
- Limit: one row larger than 1.5 MB as JSON cannot be imported this way. Integers above 2^53 lose precision in JavaScript (SQLite storage API page).

**Measured locally** (wrangler 4.107.0, `wrangler dev`, 2026-11-05; the laptop had a load average of about 20, so the wall times are not comparable):

| Run | Command | Result |
| --- | --- | --- |
| OPcache files built with the database in the object | `DEV_ENV=dosql-local ./opcache.sh` | Pass, 601 files |
| e2e, database in the object | `DEV_ENV=dosql-local ./run.sh _ping`, then `./e2e.sh` | **17 of 17**, every response `x-db: object-sqlite` |
| The deploy env, no D1 binding, new object | `DEV_ENV=dosql-free ./run.sh _ping`, `POST /_install`, then `./e2e.sh` | Installed (919 statements, 14.2 s); **17 of 17** |
| Install statement failures | `/_install` on a new database | 202 in the object, 198 on a new D1: 196 are "no such table: wp_options" in both, WordPress reading before the installer makes the tables. The object also has 4 on the driver's `_mysql_data_types_cache`. `e2e.sh` has 0 in both. |
| Per statement, from the object | `/_dbping?db=object&n=2000`, `/_dbping?db=d1&n=200` | Object SQLite 0.004 to 0.009 ms; local D1 0.555 ms. Local D1 is a file on the same laptop; on Cloudflare D1 from the object is 38 ms (8i). |
| Move from D1 | `dbmove.py export ... --from-d1`, then `import ... --replace` into the object | 470 statements; then `e2e.sh` 17 of 17. A second export matches D1 table for table, except the rows `e2e.sh` wrote. |
| Import into a database with tables, no `--replace` (control) | `dbmove.py import` | Refused: "10 tables or indexes exist" |
| Empty object (control) | `./e2e.sh` before import | Fails: "no such table: wp_options" |
| `DB_IN_DO=on` without `PHP_IN_DO` (control) | `wrangler dev --var DB_IN_DO:on` | 500 on every request |
| Default env, and PHP in the object with D1 (no change) | `./e2e.sh` | 17 of 17 each, no `x-db` header |

**Not measured yet:** all of this on Cloudflare: CPU per request, the time a page saves (no D1 round trips), cold start of an object with its database, rows billed per page there, the plugin suite, point-in-time recovery, an R2 upload (`_r2_reserved` in the object) and the Images binding inside the object. On Cloudflare the clock does not move during synchronous work, so `/_dbping?db=object` can read 0 ms there: read CPU in `wrangler tail`.

**Deploy:** `[env.dosql-free]` in `wrangler.toml` (Worker `wp-dosql-free`, no D1, migration `v1` for `PhpRuntime`, no location hint: the object is made near its first request).

### 8k. Outbound HTTP from PHP (issue #26). Measured 2026-11-05.

**Problem.** PHP in WebAssembly has no sockets in a Worker or a Durable Object. Every `wp_remote_*()` request failed:
- no update checks;
- the network parts of Akismet, Site Kit, Jetpack, WP Mail SMTP and Wordfence did not work;
- Wordfence activation waited about 10 s for timeouts.

**Design.** `php/http-bridge.php` (mu-plugin) answers `pre_http_request`, at the highest priority, so a plugin's own answer (a mock or a cache) still wins.
- **Checks before sending.** It makes the checks core makes:
  - `reject_unsafe_urls`, the allowed protocols and a valid URL;
  - `block_request()`, so `WP_HTTP_BLOCK_EXTERNAL` and `WP_ACCESSIBLE_HOSTS` keep their meaning;
  - then `skyphusion_http_allowed` (a filter, default true).
- **The request.** It goes through `post_message_to_js()` to `httpOp()` in `index.js`, which makes it with `fetch()`.
- **The answer.** It comes back in core's array (`headers`, `body`, `response`, `cookies`, `filename`). `http_api_debug` and the `http_response` filter run on it, and `stream` and `filename` write the body to the file.
- **In `httpOp()`:**
  - one timeout for the request and its redirects;
  - redirects are followed in JavaScript, so each hop is checked again: 0 returns the redirect, and past the count is "Too many redirects", as WordPress's HTTP library does;
  - the body is read up to `limit_response_size`, and never past `HTTP_MAX_BYTES` (default 8 MB);
  - `HTTP_ALLOW_HOSTS` (a comma list) is the hosts it may call. Unset uses `.wordpress.org`, `.woocommerce.com` and `.gravatar.com`. An empty list denies every host. `*` allows every http(s) host. A leading dot matches that name and its subdomains;
  - a log line for each request.
- **Configuration.** `wp-config.php` no longer defines `WP_HTTP_BLOCK_EXTERNAL`. `HTTP_BRIDGE=off` defines it again in `wp-runtime.php` and turns the bridge off: the behaviour before.
- **Not covered:** `curl_*()`, `fsockopen()` and `http://` streams (`file_get_contents()` of a URL). `sslverify` cannot be turned off, because `fetch()` always checks TLS.

**A request to the site itself is refused.** The PHP object runs one request at a time. A request from inside a page to the site's own host goes out, comes back through the Worker, and waits behind the page that made it. `httpRefusal()` refuses any request to the site's own host at once. WordPress treats it like any failed request (Site Health's loopback check, the plugin editor's fatal-error check).

Measured, locally:
- with the refusal: the request fails in about 0.3 s, and the site answers right after;
- with the refusal mutated off (built tree only): the request hung for its whole 10 s timeout.

**Gate.** `tests/http/http_bridge_check.py`, with the test-only route `tests/http/test-http-route.php` copied into the built tree (it is never shipped).

| Where | Echo | Result |
| --- | --- | --- |
| local, `dosql-local` (PHP in the object) | `tests/http/echo.py` | 16 of 16, plus `e2e.sh` 17 of 17 |
| local, default env (PHP in the Worker) | `tests/http/echo.py` | 16 of 16, plus `e2e.sh` 17 of 17 |
| `wp-perf-dosql` on Cloudflare, a test build with the route and Akismet | `https://httpbin.org` | 17 of 17 |

The checks are:
- get, a form post, a JSON post;
- headers both ways, a status;
- redirects, too many redirects, no redirect;
- a timeout (1 s against a 4 s delay), the size limit, a stream to a file, a cookie;
- the loopback refused at once, and the site answering after;
- `api.wordpress.org` 200, and no update-check warning on plugins.php;
- with Akismet, `Akismet::verify_key()` answers `invalid` (its API answered; the key is not real), and not `failed` (no network).

Controls:
- `HTTP_BRIDGE=off`: the network checks fail (12 of 16 locally), and Akismet answers `failed`;
- the loopback mutation: the loopback check fails.

**No regression on pages without HTTP.** On `wp-perf-dosql`, the same build with `HTTP_BRIDGE` off, on, then off again. Each pass: `N=30 C=1 PAGES=home,post python3 tests/load/perf.py` with `wrangler tail`; 0 boots; `httpCalls` 0 on these pages.

| Page | Off | On | Off again |
| --- | --- | --- | --- |
| home | 152 / 177 (27) | 148 / 186 (27) | 147 / 193 (24) |
| post | 157 / 225 (19) | 156 / 201 (18) | 189 / 221 (19) |

Values are tail CPU in ms, p50 / p95 (joined n). On is inside the off range on both pages.

**The plugin suite does not test this.** Its `function` step has no check for the 10 network-dependent plugins: `fn_check()` returns `None` ("admin page only") for them, so they count as not passing in every run, with the network or without it. The evidence for this change is the gate above. A network check per plugin would be new work in `tests/plugins/plugins.py`.

**Two findings in the test rig, not in the bridge.**
1. With a local echo server on HTTP/1.0 (Python's default; it closes each connection), a redirect inside the object sometimes failed with "Network connection lost": workerd reused a closed connection. With HTTP/1.1 keep-alive it passed 3 of 3. A real HTTP/1.0 server that closes connections might do the same. Not tested.
2. In the first Cloudflare run of the test build, the test route and Akismet answered 404 for about 15 s right after the deploy; a second deploy of the same build answered from its first request. Not explained.

### 8l. Real SQL transactions in the PHP object (issue #60). Measured 2026-11-06 (UTC).

**Problem.** On `b-dosql` a `ROLLBACK` undid nothing. The PHP driver answered `BEGIN` and `COMMIT` itself, and each statement committed on its own. A request that stopped midway kept its earlier writes. The red test showed this on `dosql-local` and on `do-local` (D1).

**What the object's SQLite allows.** Probed on Cloudflare and locally, with throwaway builds (never committed):
- `BEGIN`, `SAVEPOINT` and `PRAGMA schema_version` are refused (`SQLITE_AUTH`).
- Triggers, `PRAGMA table_info` and `quote()` are allowed.
- `ctx.storage.transactionSync()` nests as a savepoint.
- `ctx.storage.transaction(async)` cannot hold a whole PHP request:
  - **T10.** A nested transaction that is held open does not capture statements made from outside its closure. The inner one rolled back; the row written from outside stayed (rows `o1, i1, i2, i3, o2` = `1, 0, 1, 0, 1`). On Cloudflare and locally.
  - **T11.** A `fetch()` while the transaction is held deadlocks. On Cloudflare the request answered the overload message after 30 s, and the site answered 200 right after. Locally the object reset after 30 s.
  - A PHP request awaits `fetch()` (8k), so a transaction around the request cannot hold.

**Design: an undo log** (SQLite's "Automatic Undo/Redo" technique).
- `php/real-transactions.php` (mu-plugin) watches the `query` filter of `$wpdb`. That filter sees the transaction statements of WordPress and plugins. The SQLite driver's own internal transactions do not pass through it. It sends `START TRANSACTION`, `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `ROLLBACK TO`, `RELEASE` and DDL to `txnOp()` in `index.js` through `post_message_to_js()`.
- On `BEGIN`, `index.js` puts three triggers on each table: AFTER INSERT, UPDATE and DELETE. Each writes the inverse SQL into `_wp_undo`, only when `_wp_undo_state.active` is 1.
  - Tables that are skipped: `sqlite_*`, `_cf_*`, the undo tables, and `WITHOUT ROWID` tables.
  - A trigger's name holds a hash of its whole body. A changed body (a new release, a new column) gets a new name, the old trigger is dropped, and the new one is made.
  - The triggers are checked again only when `sqlite_master` changes (its row count and the total length of its SQL; `PRAGMA schema_version` is refused).
- **ROLLBACK.** Replays the log newest first, inside one `transactionSync()`, then deletes those log rows.
- **COMMIT.** Deletes the log and sets `active` to 0.
- **The object cache.** The keys set or deleted since `BEGIN` are dropped from the object cache on any rollback, so the next request reads the old value from the database.
- **MySQL semantics kept:**
  - `START TRANSACTION` inside a transaction commits the first;
  - DDL (`CREATE`, `ALTER`, `DROP`, `RENAME`, `TRUNCATE`) commits first (MySQL's implicit commit);
  - a transaction still open at the end of the request is rolled back, as MySQL does when a connection closes;
  - a `SAVEPOINT` outside a transaction does nothing;
  - the same savepoint name replaces the old one;
  - `ROLLBACK TO` an unknown name is an error.
- **Isolation.** The object runs one PHP request at a time (`withPhp`), and the lock is held across `await fetch()`. So every logged write belongs to the request that holds the transaction. The concurrency check below confirms this.
- **An isolate that dies mid-transaction.** `active` is stored in the database. Before its first PHP run, a new isolate rolls back what the log holds (`txnRecover()`). Not tested: no gate kills an isolate mid-transaction.
- **Off switch.** `REAL_TRANSACTIONS=off` restores the behaviour before: `ROLLBACK` undoes nothing.
- **Dumps.** The undo log (`_wp_undo`, `_wp_undo_state` and the `_wp_undo_*` triggers) is not data, so `dumpTo()` leaves it out of a `dbmove.py` dump. The target makes its own on the first `BEGIN`. An import with `--replace` drops it with the other tables.

**Gate.** `tests/tx/tx_check.py`, with the test-only route `tests/tx/test-tx-route.php` copied into the built tree (it is never shipped). 11 checks:
- the transaction sees its own insert; rollback; commit;
- a PHP fatal error with the transaction open (the row is gone);
- a savepoint (only the part after it is undone);
- an UPDATE and a DELETE are undone;
- the cache: `update_option()` inside `BEGIN`, `ROLLBACK`, then `get_option()` in the next request returns the old value;
- `wp_remote_get()` inside a transaction, then the rollback (no deadlock);
- concurrency: request 1 opens `BEGIN`, writes, and calls `wp_remote_get()` to a 3 s delay. Request 2 writes 0.7 s later. Request 1 rolls back. Request 2's write survives, and request 2 ends after request 1;
- a nested `START TRANSACTION`; DDL inside a transaction.

| Where | Result |
| --- | --- |
| local, `dosql-local`, real transactions | 11 of 11, plus `e2e.sh` 17 of 17 |
| local, `dosql-local`, `REAL_TRANSACTIONS=off` | 3 of 11 (8 fail: the control) |
| local, `do-local` (D1) | 3 of 11 (8 fail) |
| local, mutation: the triggers never log (`WHEN 0`), built tree only | 3 of 11 (8 fail) |
| `wp-perf-dosql` (Free test account), a test build with the route, echo `https://httpbin.org` | 11 of 11 |

The mutation ran on the state the "on" run left, so it also proves that a changed trigger body replaces the old trigger. In the first mutation run, trigger names held only the table and its columns, so the old triggers stayed and the mutation passed 11 of 11. That run found the defect; the name now holds the body.

**No regression.**
- Local, `dosql-local`: `e2e.sh` 17 of 17; `tests/load/cache_coherence.py` 0 fails with the object cache on and off; the plugin suite (7 groups) 0 lines with `pass: false`.
- `wp-perf-dosql` (Free test account), shipping build: `tests/break.py` 21 pass, 5 fail, the same PASS/FAIL set as before this change (the 5 are uploads; R2 and the Images binding are not on for `wp-perf-dosql`, see [perf-dosql.md](perf-dosql.md)); `cache_coherence.py` 0 fails.

**CPU.** The triggers stay on all tables. Outside a transaction, each write runs the trigger's `WHEN` subquery and logs nothing. On `wp-perf-dosql` (Free test account), the shipping build, `REAL_TRANSACTIONS` off, on, off, on. Each pass: `N=30 C=1 PAGES=post-new,dashboard,home python3 tests/load/perf.py` with `wrangler tail`; 0 boots; `txnOps` and `undoRows` 0 on all these pages.

| Page | Off | On | Off again | On again |
| --- | --- | --- | --- | --- |
| post-new (writes; 39 statements) | 552 / 593 (28) | 446 / 558 (27) | 470 / 575 (30) | 435 / 553 (29) |
| dashboard | 186 / 235 (17) | 162 / 271 (17) | 195 / 321 (19) | 214 / 264 (21) |
| home | 168 / 184 (27) | 146 / 179 (22) | 807 / 959 (30) | 874 / 1034 (30) |

Values are tail CPU in ms, p50 / p95 (joined n).
- On post-new, the page that writes, "on" is lower than "off" in both pairs. The cost of the `WHEN` check is below the spread between runs.
- Home and dashboard move about 10% in both directions between passes. With 4 to 6 statements, mostly reads, they fire almost no triggers.
- Home is a different page in the last two passes: `break.py` and `cache_coherence.py` ran between the second and third pass and added posts, and the home body went from 67 KB to 2.2 MB. Compare the passes in pairs.

**`b-do` (D1): not built.** D1 has no transaction across calls. An undo log is correct only when one writer runs every request in turn. With PHP in the Worker, many isolates write to D1 at the same time, so a replay would also undo other requests' writes. The `do-local` row above is the D1 result.

### 8m. Media-upload write ceiling, trimmed (issue #189). Built and verified locally; not yet measured on the box.

On b-dosql (PHP plus SQLite in one Durable Object, 128 MiB isolate cap) an admin media
upload (POST `/wp-admin/async-upload.php`, action `upload-attachment`) stores the attachment
on an isolate with WooCommerce not loaded (about x-wasm-mib 58), but fails at the attachment
DB insert on a WooCommerce-warmed isolate (about x-wasm-mib 99, about 29 MiB headroom):
`{"success":false,"message":"Could not insert attachment into the database."}`, no isolate
reset, identically for a 400x300 and a 3000x3000 image. The cost is the WooCommerce
per-request working set, not the image bytes; pixels never enter PHP (`php/cf-images-editor.php`
resizes through the Images binding). See `docs/results.md` row 168.

A spike-gated probe, `/_memprobe`, decomposes the warmed admin-upload working set. It
bootstraps WordPress in the admin-upload context (WooCommerce active, the wp-admin media
includes), samples the WASM heap at each phase through a JS bridge (`memory_get_usage()`
reports 0 under `USE_ZEND_ALLOC=0`, so the heap, read from JS, is the memory of record), and
reports the OPcache breakdown and WooCommerce's share of loaded files, classes and functions.
Measured locally: the heap grows about 44 MiB (60 to 104 MiB) at `wp-load`, and WooCommerce
is 665 of 1378 declared classes, 777 user functions and 9.8 MB of source. That per-request
load is the biggest freeable chunk.

The trim is `php/media-write-trim.php`, a mu-plugin gated to b-dosql plus MEDIA by the
`SKYPHUSION_MEDIA_WRITE_TRIM` define (index.js writes it from the `MEDIA_TRIM` var;
`MEDIA_TRIM=off` turns it off). It acts only on the async-upload and `wp/v2/media` POST write
path, never on the storefront or any other request. The default levers are `wcskip,cacheflush,gc`:

- `wcskip`: drop WooCommerce from `option_active_plugins` for this one request (a filter, so
  the stored option and its cache are untouched), but re-register the three woocommerce_*
  image sizes through a faithful port of `wc_get_image_size()` (WooCommerce 11.2.1), so
  `wp_generate_attachment_metadata` still makes them and `serveUpload` does not 404 them.
  `php/cf-images-editor.php` (a mu-plugin, always loaded) does the actual resize, so skipping
  WooCommerce does not change how the sub-sizes are made, only that they stay registered.
- `cacheflush`: flush the cross-request object cache (the JS Map in index.js) just before the
  insert, on the `wp_insert_attachment_data` filter, freeing isolate memory the write needs.
- `gc`: `gc_collect_cycles()` and `gc_mem_caches()` at the same point.

Perf loss on the upload request is acceptable: an admin media upload is a rare, single-admin
operation (project goal). Verified locally (`DEV_ENV=dosql-local`), WooCommerce active: with
`wcskip` the upload stores the attachment and generates all three woocommerce_* sizes
(woocommerce_thumbnail 300x300, woocommerce_single 600x600, woocommerce_gallery_thumbnail
100x100) plus the core sizes, byte-for-byte the same dimensions as WooCommerce loaded
(`MEDIA_TRIM=off`), while the request's PHP time halves (84 ms vs 165 ms on the same warm
isolate), which shows WooCommerce's per-request init is skipped. `tests/woo.py` stays 12/12
and `e2e.sh` is unchanged (the trim is inert outside the media write path). Local workerd does
not enforce the 128 MiB isolate cap, so the exit-2-to-exit-0 transition of
`tests/upload/upload_ceiling.py` is a box measurement.

### 8n. Turnstile bot challenge on the abused forms (issue #250). Built and box-tested locally; not yet deployed.

Three WordPress forms get abused: `wp-login.php` (credential stuffing), the comment form
(spam), and WooCommerce checkout (card testing and fake orders). `php/turnstile-forms.php`, a
mu-plugin, adds a Cloudflare Turnstile widget to each and verifies the token server side before
the action proceeds. Turnstile is binding based, so it needs no zone and works on a
`workers.dev` host today, unlike the WAF and Access tracks (#245, #246).

The widget ships in the page with the PUBLIC site key. The token (`cf-turnstile-response`) is
verified in the Worker, never in the browser: PHP sends the token through the
`skyphusion_worker_call` op bridge (the `turnstile` op in `index.js`), the Worker calls
`https://challenges.cloudflare.com/turnstile/v0/siteverify` with the secret, and PHP reads back
only `{ success }`. The secret (`TURNSTILE_SECRET`) stays in the Worker and never enters PHP, as
the AI binding and the purge token do. `turnstile.mjs` holds the one network seam, `verifyToken`,
so the Worker op and the box test send the exact same request.

Switches, written into `wp-runtime.php` by `index.js` from the bindings:

- `SKYPHUSION_TURNSTILE`: on when the `TURNSTILE_SECRET` secret and a valid public
  `TURNSTILE_SITEKEY` are both set. `TURNSTILE=off` is the master off switch, which restores
  every form to its unprotected state.
- `SKYPHUSION_TURNSTILE_SITEKEY`: the public site key, sanitized to `[A-Za-z0-9_-]` before it
  becomes a define.
- `SKYPHUSION_TURNSTILE_LOGIN`, `SKYPHUSION_TURNSTILE_COMMENTS`, `SKYPHUSION_TURNSTILE_WOO`: each
  form is independently switchable (`TURNSTILE_LOGIN=off` and so on); one off leaves the others on.

The gate is login via the `authenticate` filter (a `WP_Error` stops the sign-in, only on a real
credential POST so cookie and application-password auth are untouched), comments via
`preprocess_comment` (a 403 `wp_die`, skipping pingbacks and the admin screens), and checkout via
`woocommerce_checkout_process` (a `wc_add_notice` error, which fails order placement on the
classic shortcode checkout). The posture is fail closed: a missing or failed token always rejects
the action. A verifier that is unreachable (a timeout or a network failure, told apart from a bad
token by an error field the op sets) is also rejected, unless the site opts in through the
`skyphusion_turnstile_failopen` filter, so an outage never silently drops the protection.

A token passes only if siteverify says it was solved on this site's own host (the hostname of
`SITE_ORIGIN`) by this site's widget (the action `turnstile-spin-v1`). A token for another host or
action is a failed token, not an outage. The documented test secret keys always reply
`example.com` with no action, so these two checks are skipped for them.

**The verify waits for the output gate first (issue #351).** A Durable Object holds each outgoing
`fetch` until the storage writes made before it are confirmed. A login writes to the database
before its `authenticate` filter runs, so the siteverify fetch waited for those writes. On a
runtime that had just booted, the wait was 0.6 to 2.8 s, and the fetch itself took 4 to 117 ms
(fdprobe1112j, 2026-11-12). The timeout (`TURNSTILE_TIMEOUT_MS`, default 10 s) counted the wait,
so a long wait refused a valid token. Now the op yields once, waits for `storage.sync()`, and then
starts the verify and its timeout (`verifyAfterGate` in `turnstile.mjs`). The response waits for
the same writes, so this adds no time to the request. The `{"m":"turnstile"}` log line has
`gateMs` (the wait) and `fetchMs` (the verify) for each op.

**The block checkout (issue #308).** The block checkout posts to the Store API
(`/wc/store/v1/checkout`). That route does not run `woocommerce_checkout_process`, and a form field
does not reach it, so it has its own widget and its own gate. Both use the same
`skyphusion_turnstile_verify` path, the same fail closed posture, and the same `TURNSTILE_WOO=off`
switch as the classic checkout.

- The widget. A `render_block` filter adds a widget box and a script tag after the first
  `woocommerce/checkout` block on the page. The box is outside the block's React root, so React does
  not remove it. `php/turnstile-block-checkout.js` (shipped as the static file
  `mu-plugins/turnstile-forms/block-checkout.js`; the PHP side drops every `.js`) renders the widget
  in explicit mode. It puts the token in the checkout store with `setExtensionData`, so the place
  order POST carries it as `extensions["skyphusion-turnstile"].token`. A token is single use, so
  after a POST that fails the script clears the token and resets the widget. An expired widget
  clears the token too.
- The extension data. `woocommerce_store_api_register_endpoint_data` registers the
  `skyphusion-turnstile` namespace, with one `token` field, on the `checkout` endpoint.
- The gate. `woocommerce_store_api_checkout_update_order_from_request` runs inside the checkout
  route, before stock is held and before payment, so the batch route cannot go around it. That hook
  also fires for the PUT and PATCH draft updates that the checkout sends while the shopper types.
  Those carry no token, so only the POST is gated. A missing or failed token throws a
  `RouteException`: a 400 Store API error with the code `skyphusion_turnstile_failed`, which the
  block shows as a notice. WooCommerce then releases held stock and coupons. Read against
  WooCommerce 11.2.1 (`WOO_VERSION` in `build.sh`), `src/StoreApi/Routes/V1/Checkout.php` and
  `src/StoreApi/Utilities/CheckoutTrait.php`, 2026-11-12.
- An express payment button (for example Apple Pay) that places the order through the same POST
  also needs a solved widget. Without one, the order is refused.

Box test (no Cloudflare account or widget needed; the documented test SECRET keys fix the
outcome). `node tests/turnstile-box.mjs` calls the real siteverify endpoint through `verifyToken`:
with `1x0000000000000000000000000000000AA` (always passes) a good token returns `success:true`;
with `2x0000000000000000000000000000000AA` (always fails) a token returns `success:false` with
`invalid-input-response`; a missing token is rejected without a network call. The form gating
(login block, comment reject, checkout fail, and the off switches) is proven by
`tests/turnstile-forms-test.php`, which drives the WordPress hooks with a stubbed op bridge across
five process scenarios (all on, master off, login off, checkout off, and the Store API
`RouteException` path), including the block checkout gate: a POST with no token, a bad token or a
token under another namespace is refused, a good token passes, and PUT and PATCH are not gated.
`tests/turnstile-block-checkout.test.mjs` drives the block script against a stubbed checkout store
and widget. The helper logic is `tests/turnstile.test.mjs`. All four run in CI. The block
checkout is not yet proven on a live store: that run waits on a working throwaway store (#294). Not yet deployed: the real widget is minted and
the `TURNSTILE_SECRET` secret is set at deploy time (`wrangler secret put TURNSTILE_SECRET`), and
`TURNSTILE_SITEKEY` is the public site key var.

### 9. Memory: what it took to fit in 128 MB

| Change | Effect, measured locally |
| --- | --- |
| Start the PHP module at 24 MiB, not 64 MiB (patched memory section) | Lower base. Grows on demand. |
| `USE_ZEND_ALLOC=0` (plain malloc, not PHP's 2 MB-aligned chunks) | WebAssembly memory after a page: 103 to 59 MiB. After `e2e.sh`: 124 to 71 MiB. |
| Unzip WordPress in batches of 200 files | No second copy of the tree in JS memory. |
| Drop unminified CSS, text and Markdown from PHP's files | 31 to 25 MiB. Minified CSS stays: WordPress reads some by runtime paths. |
| Recycle the runtime after a crash or past 80 MiB | A broken runtime is never reused. |

## Prior work

- [sqlite-database-integration#288](https://github.com/WordPress/sqlite-database-integration/issues/288): D1 through the REST API. Open. A fork tried it in [Avunu/sqlite-database-integration#2](https://github.com/Avunu/sqlite-database-integration/pull/2), which was closed without a merge. Its branch is gone.
- [bhubbard/wp-cloudflare-d1](https://github.com/bhubbard/wp-cloudflare-d1): a `wpdb` replacement that calls D1. Not on the SQLite driver.
- Both use the D1 REST API from outside a Worker. Approach B uses the D1 binding from inside one.

## Steps

1. Boot `@php-wasm` in local workerd and run `phpinfo()`. Record memory and cold start.
2. `D1_PDO`: run `SELECT 1` from PHP against a local D1 through JSPI.
3. Install WordPress on D1 with the driver. Record every query that fails. That list is the D1 dialect work.
4. Add the D1 dialect for the functions in finding 4.
5. Page cache in KV or the Cache API for logged-out pages.
6. Deploy to a Free account and a Paid account. Fill row B in the README with **measured** results.
