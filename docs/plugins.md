# The plugin suite

Conrad, 2026-11-05: "test each setup with a standard suite of plugins, SEO, standard stuff".

## The suite

The 20 most popular plugins on wordpress.org (`browse=popular`, read 2026-11-05), without WooCommerce (it has its own test, `tests/woo.py`) and Hostinger (a host's own plugin): 18 plugins. Versions and SHA-256 of each zip are pinned in [tests/plugins/suite.txt](../tests/plugins/suite.txt).

## Method

`tests/plugins/plugins.py` runs against any target. First a baseline row "(none)": the home page, a post, the dashboard and `plugins.php` with no suite plugin active. Then, for each plugin, one at a time:

1. Activate it through the REST API and read the status back.
2. Home page and a post, logged out (fresh render, `?nocache=`).
3. Dashboard and the plugin's own admin page, logged in (no error text, the wp-admin frame present).
4. One thing the plugin does that a client can see, where there is one: Yoast and Rank Math print SEO tags and a sitemap; Contact Form 7 accepts a submission; Classic Editor shows its editor; Duplicate Post and Duplicate Page make one draft; Elementor opens its editor. The rest are "admin page only".
5. Deactivate it.

A step is tried up to 3 times. "pass (n retried)" means n steps needed a second or third try. `tests/plugins/report.py` makes the matrix below from `tests/plugins/results/*.jsonl`.

Plugins must be in the build on every target: a plugin installed from wp-admin does not persist (approach B and A: the in-memory file system; C1: the container disk; HostlessWP: the bundle made at deploy). Approach B and our A put the 18 plugins in 7 builds (`spikes/b2-wordpress/plugin-suite.sh`): all 18 do not fit under the 64 MiB Worker limit (with Jetpack alone the upload is 63,024 KiB). HostlessWP bundles them all in one Worker (code bundles loaded on first read, 211 to 348 MB packaged).

## Matrix

Runs of 2026-11-05. A and HostlessWP on the public MySQL path ([approach-a.md](approach-a.md)); our A plugin rows are from the tunnel path, and Rank Math on A Paid was rerun on the public path after a harness fix.

| Plugin | A, Free | A, Paid | HostlessWP, Free | HostlessWP, Paid | B, Free | B, Paid | C1, Paid | A2 (PlanetScale), Paid |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| (none) | fail: login failed (503) | pass | pass | pass | pass | pass | pass | pass |
| elementor | fail: login failed (503) | pass | pass | pass | fail: post, dashboard, function (cpu limit) | pass | pass | pass |
| wordpress-seo | fail: login failed (503) | pass | pass | pass | fail: dashboard, admin_page, function (cpu limit) | pass | pass | pass |
| contact-form-7 | fail: dashboard (cpu limit) | pass | pass | pass | fail: home, dashboard (cpu limit) | pass | pass | pass |
| classic-editor | fail: dashboard (cpu limit) | pass | pass | pass | fail: activate | pass | pass | pass |
| litespeed-cache | fail: activate (503) | pass | pass | pass | fail: plugin list (cpu limit) | pass | pass | pass |
| google-site-kit | fail: login failed (503) | pass | pass | pass | fail: post, dashboard, admin_page (cpu limit) | pass | pass | pass |
| akismet | fail: activate (503) | pass | pass | pass | fail: plugin list (cpu limit) | pass | pass | pass |
| wpforms-lite | fail: home, post, dashboard, admin_page (cpu limit) | pass (1 retried) | pass (1 retried) | pass | fail: dashboard, admin_page (cpu limit) | pass | pass | pass (1 retried) |
| all-in-one-wp-migration | fail: post, dashboard, admin_page (500, cpu limit) | fail: dashboard, admin_page (500) | pass | pass | fail: plugin list (cpu limit) | pass | pass | fail: dashboard, admin_page (500) |
| wordfence | fail: login failed (503) | pass (1 retried) | pass | pass | fail: activate (503) | pass | pass | pass |
| wp-mail-smtp | fail: login failed (503) | pass | pass | pass | fail: dashboard, admin_page (cpu limit) | pass | pass | pass |
| seo-by-rank-math | fail: login failed (503) | pass | pass | pass | fail: dashboard, admin_page (cpu limit) | pass | pass | pass |
| updraftplus | fail: login failed (503) | pass | pass | pass | fail: plugin list (cpu limit) | pass | pass | pass |
| duplicate-post | fail: plugin list (cpu limit) | pass | pass | pass | fail: plugin list (cpu limit) | pass | pass | pass |
| duplicate-page | fail: plugin list (cpu limit) | pass | pass | pass | fail: plugin list (cpu limit) | pass | pass | pass |
| jetpack | fail: login failed (200) | pass | pass | pass | fail: login failed (200) | pass | pass | pass |
| really-simple-ssl | fail: login failed (503) | pass | pass | pass | fail: dashboard (cpu limit) | pass | pass | pass |
| insert-headers-and-footers | fail: login failed (503) | pass | pass | pass | fail: dashboard, admin_page (cpu limit) | pass | pass | pass |
| **passed** | 0 of 18 | 17 of 18 | 18 of 18 | 18 of 18 | 0 of 18 | 18 of 18 | 18 of 18 | 17 of 18 |

## Findings

- **Workers Free.** Every Free failure for approach B and our A is the CPU limit (or a 503 from it). HostlessWP runs PHP in a Durable Object on Free and passes 18 of 18. Issue #28 brings that design to approach B.
- **The frozen clock.** A Worker does not advance `Date.now()` during CPU work, so `uniqid()` looped to the CPU limit on `plugins.php`, `themes.php` and every request with Contact Form 7 active. Approach B Paid went from 3 to 17 of 18 with the fix ([approach-b.md](approach-b.md) 8h). HostlessWP had the same fix first.
- **BLOBs over the D1 bridge.** Wordfence stores its settings in a BLOB column, which arrived in PHP as an array: a fatal error on activation. Fixed in approach B (18 of 18 on Paid).
- **C1.** PHP's built-in server did not run `index.php` for a directory, so `/wp-admin/` showed the home page. Fixed in `router.php` (18 of 18).
- **Mail.** No target here has a mail transport configured. Contact Form 7 accepts the form and returns `mail_failed`.
- **All-in-One WP Migration on our A Paid** answers 500 on every admin page: it calls `mysqli_*` on `$wpdb->dbh`, which our A does not provide as a mysqli link. HostlessWP passes because it ships a userland mysqli. Issue #29.
- **Harness fixes during the runs** (each found when a result looked wrong, then confirmed): a post is found by the REST API instead of assuming id 1; Rank Math's setup is skipped right after activation, before its admin page is checked; a failed plugin list from a CPU limit is reported as the platform's failure, not the harness's.
