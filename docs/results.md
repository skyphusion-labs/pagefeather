# Results

Each row is one deploy and one test run.

A row with plan `local` ran in local workerd through `wrangler dev`. It is not a plan result and does not change a README cell.

| Id | Plan | Date (UTC) | Wrangler | Command | Result |
| --- | --- | --- | --- | --- | --- |
| B | local | 2026-11-03 | 4.157.0 | `spikes/b1-boot/run.sh` | PHP 8.3.36 boots in 319 ms on the first request, a script runs in 11 ms. `pdo_sqlite` and `post_message_to_js` are loaded. |
| B | local | 2026-11-03 | 4.157.0 | `spikes/b1-boot/run.sh '?d1=1'` | PHP ran CREATE, INSERT and SELECT on D1 through JSPI. 3 D1 calls, 104 ms total on local D1. Returned the inserted row. |
| B | local | 2026-11-03 | 4.157.0 | `spikes/b2-wordpress/run.sh _install` | WordPress 7.1.4 installed into D1 (`installed: true`, user 1). One non-fatal failure: `REGEXP` in a transient cleanup. |
| B | local | 2026-11-03 | 4.157.0 | `curl` warm `GET /` | 200, 29 D1 calls, 43 to 94 ms in D1, 605 to 961 ms total in PHP. 0 failures. |
| B | local | 2026-11-03 | 4.157.0 | `curl` pages: `?p=1`, `?page_id=2`, `?feed=rss2`, `wp-login.php`, `?s=hello`, REST posts, `?cat=1` | All 200. D1 calls 11 to 37 per page. PHP 444 to 912 ms. 0 failures. |
| B | local | 2026-11-03 | 4.157.0 | `curl` login, `GET /wp-admin/` | Login 302, 18 calls. Dashboard 200, 116 calls, 1,033 ms. |
| B | local | 2026-11-03 | 4.157.0 | `curl` `GET /wp-admin/post-new.php` | 200, 123 calls, 1 failure: `YEAR()` in the media month list. |
| B | local | 2026-11-03 | 4.157.0 | REST `POST /wp/v2/posts` | 201, post published, 82 calls, 0 failures. The front page then shows it. |
| B | local | 2026-11-03 | 4.157.0 | `spikes/b2-wordpress/tests/dialect-test.php` | 10 of 10 pass: YEAR, MONTH, FIELD, nested calls, md5 of a parameter, REGEXP as a rowid filter, NOT REGEXP, refusals. |
| B | local | 2026-11-03 | 4.157.0 | `spikes/b2-wordpress/e2e.sh` after a clean `_install` | 17 of 17 requests pass, 0 D1 failures. Pages 11 to 45 D1 calls; dashboard 116; editor 123; REST create 82. PHP 455 to 1,549 ms. |
| B | Free | 2026-11-03 | 4.157.0 | deploy `spikes/b2-wordpress` (`--env paid`, account `32ce15b8`, which is on Workers Free: a `cpu_ms` limit is refused with code 100328) | Upload 12,971 KiB gzip, startup 13 to 22 ms. |
| B | Free | 2026-11-03 | 4.157.0 | `/_install` on the deploy | 503, error 1102 (exceededResources). Database loaded instead from a local install with `wrangler d1 export` and `d1 execute --file` (380 statements). |
| B | Free | 2026-11-03 | 4.157.0 | `e2e.sh` and repeated `GET /?p=1` on the deploy | Some pages render: 200, 21 to 37 D1 calls, 0 D1 failures. Most requests fail with 1102. |
| B | Free | 2026-11-03 | 4.157.0 | Workers analytics (GraphQL `workersInvocationsAdaptive`), 8 minutes | success: page renders at 1,434 ms CPU (p50) to 1,934 ms (p99). exceededResources: 13 requests, all stopped at 2,010 to 2,018 ms CPU. The Free hard stop observed is about 2 s of CPU, not the documented 10 ms. |
| B | local | 2026-11-03 | 4.157.0 | `/_mem`, `/_peak` | PHP peak for a front page 38 MB (40 MB real), 528 files. WebAssembly memory 103 MiB with PHP's allocator, 59 MiB with `USE_ZEND_ALLOC=0`; 124 and 71 MiB after `e2e.sh`. |
| B | Paid | 2026-11-04 | 4.107.0 | deploy `spikes/b2-wordpress` (`--env paid`, `cpu_ms = 30000`, an account on Workers Paid) | The `cpu_ms` limit is accepted. Upload 12,971 KiB gzip, startup 13 ms. |
| B | Paid | 2026-11-04 | 4.107.0 | `POST /_install` on the deploy | 200, `installed: true`. 1,059 D1 queries, 32 s wall time. One failed statement: a read of `_wp_sqlite_global_variables`. |
| B | Paid | 2026-11-04 | 4.107.0 | `e2e.sh` on the deploy | 17 of 17 pass, 0 D1 failures. Pages 11 to 38 D1 queries (192 on the first request after install); dashboard 116; editor 124; REST create 79. |
| B | Paid | 2026-11-04 | 4.107.0 | 50 more `GET /` and `GET /?p=1`, then Workers analytics (GraphQL `workersInvocationsAdaptive`), 70 requests | All 200. 0 errors. CPU p50 845 ms, p90 1,668 ms, max 3,485 ms. |
| B | Paid | 2026-11-04 | 4.107.0 | `B=https://wp-on-d1-paid... python3 spikes/b2-wordpress/tests/break.py` before fixes (probe scripts, same checks) | Failures: 30 parallel requests 2 or 3 of 30 crash; a 100 KB post fails with `SQLITE_TOOBIG`; a 4 MB body crashes with a stack in the response; search over 48 bytes fails a LIKE limit; PHP errors and paths shown; xmlrpc multicall open; uploads served by one isolate only. |
| B | Paid | 2026-11-04 | 4.107.0 | `tests/break.py` after the fixes in `docs/approach-b.md` 8b | 12 pass, 1 fail. The fail is uploads (issue #12): fetch 200 once, 301 four times. |
| B | Paid | 2026-11-04 | 4.107.0 | `e2e.sh` after the fixes | 17 of 17 pass, 0 D1 failures. |
