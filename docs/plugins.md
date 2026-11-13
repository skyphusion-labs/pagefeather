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

Plugins must be in the build on every target: a plugin installed from wp-admin does not persist, except on a b-dosql site with `CODE_PERSIST=on` (#407, `deploy/wfp/README.md`) (approach B and A: the in-memory file system; C1, now retired: the container disk; HostlessWP: the bundle made at deploy). Approach B and our A put the 18 plugins in 7 builds (`spikes/b2-wordpress/plugin-suite.sh`): all 18 do not fit under the 64 MiB Worker limit (with Jetpack alone the upload is 63,024 KiB). HostlessWP bundles them all in one Worker (code bundles loaded on first read, 211 to 348 MB packaged).

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
| all-in-one-wp-migration | fail: post, dashboard, admin_page (500, cpu limit) | fail: dashboard, admin_page (500); since #29: pass (`wp-ref-a`, 2026-11-06) | pass | pass | fail: plugin list (cpu limit) | pass | pass | fail: dashboard, admin_page (500) |
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
  Since issue #29, A has a userland mysqli. Measured locally on MariaDB 11.4: the plugin passes; without the layer, dashboard and admin page answer 500. Re-run on Paid (`wp-ref-a`, 2026-11-06): pass. The other plugins were not re-run on that build ([approach-a.md](approach-a.md)).
- **Harness fixes during the runs** (each found when a result looked wrong, then confirmed): a post is found by the REST API instead of assuming id 1; Rank Math's setup is skipped right after activation, before its admin page is checked; a failed plugin list from a CPU limit is reported as the platform's failure, not the harness's.

## Gate 2: the harness for the plugins a developer keeps (#422, #426)

`tests/plugins/gate2.py` tests the Gate 2 list in `tests/plugins/gate2.txt` on the sample store with WooCommerce active. WooCommerce is the control. The Nov 5 suite above used a near-empty site; this harness does not. It runs on a throwaway site only.

- **Plugins and themes are in the build** (`PLUGINS=`, `THEMES=`). Conrad's ruling (2026-11-13): installs and updates are code deploys, so the harness has no wp-admin install phase. The old `install`, `check` and `fetch` phases were removed.
- **Phases:** `function` (activate, admin screens, settings save, visible job, deactivate), `stack-activate` (tier 1), `cms` (below), and `report`.
- **Recording:** one JSON line per request, with headers only. Every write is read back and classed `ok/ok`, `fail/fail`, `fail/changed` or `ok/unchanged`. The last two are answer/state disagreements.
- **write-loss:** counted from `x-write-loss`, and from a Workers Logs export (`report --logs`).
- **The report:** it prints each item's first failing step next to its prediction.
- **One SEO plugin per site** (Conrad, 2026-11-13): Yoast and Rank Math are each tested alone. Before the harness activates one, it checks that the other is not active. If the other is active, it records a refusal and runs nothing for that item.

The first use is a one-pass prediction check (the lead's ruling, 2026-11-13). Payments, mail, the stack profile and the 10-round runs are deferred until #293, #407 and the admin memory work (#394, #411) move.

## Gate 2, tier 1: the CMS phase (#422)

"Feels like WordPress" means the standard CMS work in wp-admin works (Conrad, 2026-11-13). `gate2.py cms` (code in `tests/plugins/cms.py`) measures it on the built-in stack, one step per function:

| Function | What the phase does |
|---|---|
| Block editor | loads `post-new.php`; makes a draft with blocks; saves it twice (revisions +2); publishes it; the front page shows the last text; loads the editor for the post |
| Media | uploads a small PNG; reads the file back from its URL; finds it in the library; loads `upload.php`; deletes it |
| Menus | block theme: a navigation with two links; classic theme: a menu with two items, put in an empty location if there is one; loads `nav-menus.php` |
| Widgets | classic theme with a widget area: adds a block widget and reads it back; loads `widgets.php`. Otherwise not applicable. |
| Site editor or Customizer | block theme: loads `site-editor.php`, changes one global style, reads it back, puts it back; classic theme: loads `customize.php`, saves the tagline through the Customizer, reads it back, puts it back |
| Settings | changes the tagline by REST and puts it back; saves the General settings form unchanged |
| Users and roles | makes an author; makes it an editor; logs in as it and makes a draft; deletes it (its posts go to the admin) |
| Comments | a visitor comment from the front (Turnstile test key); approves it; replies as the admin; the front shows both |

Each write is read back and classed as above. `ROUNDS=<n>` repeats the phase (default 1). Everything a round makes carries the round's run id and is deleted at the end of the round. Then the round compares the counts (posts, pages, media, comments, users, menus, navigation, widgets) with the counts before it. A round that leaves a row fails its `cleanup` step. The cleanup tries a delete again after a 5xx answer (up to 3 times, 10 s apart); that is housekeeping, and the measured steps never retry. `CMS_FUNCTIONS="settings,users"` runs only those functions, in that order. Each function ends with a `function` step that holds its result. Tests: `tests/plugins/cms_test.py` (offline, a fake WordPress).

## Gate 2, tier 1: the standard stack on plain WordPress (#422)

Tier 1 runs the same harness on a plain b-dosql site with no WooCommerce. The site is loaded with the Theme Unit Test fixture (`tests/fixtures/load-theme-unit.sh`, pins in `tests/fixtures/theme-unit.env`).

- **The stack:** `GATE2_LIST=tier1.txt` holds Elementor, Yoast SEO, Contact Form 7, ACF, Wordfence, UpdraftPlus and Astra, one of each kind. `tier1-alt.txt` holds the second run's alternates: Rank Math, WPForms Lite and Hello Elementor.
- **`STACK=1`:** the items stay active together. The `stack-activate` phase activates them all, and the one-SEO guard still holds.
- **Elementor's visible job:** a new page, its editor, a save through Elementor's own `elementor_ajax` `save_builder`, and then the page renders the saved heading.
- **Request classes:** every request is labelled operator, login, `admin-ajax:<action>`, editor-save, admin-page, admin-write, rest-read, rest-write or front. The report adds a class table with the request count, fail rate, resets, write-loss and WASM memory. That table is the evidence for which requests an admin container should take.
- **Visible jobs not in the first pass:** ACF's field group, Wordfence's scan and UpdraftPlus's backup report "not in this pass". They report that, never a pass.

