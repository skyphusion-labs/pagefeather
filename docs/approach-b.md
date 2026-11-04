# Approach B: WordPress on D1

WordPress runs as PHP compiled to WebAssembly in a Worker. Its database is D1. There is no MySQL and no server.

Status: WordPress runs on D1 in local workerd (spike B2), and is deployed on Workers Free, where CPU time decides if a page renders. Findings below are from 2026-11-03.

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

- The Worker marks a response cacheable (`public, max-age=120, stale-while-revalidate=600` (see 8d), `Cache-Tag: wp-pages`) only for a logged-out `GET` or `HEAD` with status 200, 301 or 404, no `Set-Cookie`, no WordPress cookie on the request, and not admin, login, preview or spike paths.
- The cache key has no cookies. `Vary: Cookie` keeps a logged-in visitor on their own (uncached) variant.
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

### 9. Memory: what it took to fit in 128 MB

| Change | Effect, measured locally |
| --- | --- |
| Start the PHP module at 24 MiB, not 64 MiB (patched memory section) | Lower base. Grows on demand. |
| `USE_ZEND_ALLOC=0` (plain malloc, not PHP's 2 MB-aligned chunks) | WebAssembly memory after a page: 103 to 59 MiB. After `e2e.sh`: 124 to 71 MiB. |
| Unzip WordPress in batches of 200 files | No second copy of the tree in JS memory. |
| Drop unminified CSS, text and Markdown from PHP's files | 31 to 25 MiB. Minified CSS stays: WordPress reads some by runtime paths. |
| Recycle the runtime after a crash or past 80 MiB | A broken runtime is never reused. |

### 10. Next

- CPU: precompile OPcache at build time (HostlessWP does this), so a request does not compile about 500 scripts.

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
