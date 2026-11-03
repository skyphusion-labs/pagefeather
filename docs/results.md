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
