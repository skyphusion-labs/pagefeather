# Support matrix

This page says what works on each tier and each deploy path, what is limited, and why. Conrad asked for it in #759: "document things that are limited and why".

**State on 2026-11-21, from the sb1120 rows in [results.md](results.md) (#759).** Those runs are 2026-11-20 and 2026-11-21. The summary below uses the latest suite row for each tier. A cell that still says "not measured" has no row for that feature.

## Latest suite results (sb1120)

### Hyperdrive WordPress

WordPress only, `cf759hw`, with `PLACEMENT` set to the database region (#1054). The wp suite is 18 of 18. routes.py called 61 routes and had 0 failures. This is the first fully clean tier in the sprint ([results.md](results.md), the `cf759hw` wp and routes rows, 2026-11-20). Before #1054, Hyperdrive with WooCommerce was 6 of 18 on wp.

On a Hyperdrive store (`cf759hl`, WooCommerce on) the wp suite is 17 of 18 on two browsers (Browser Run at 00:01Z, and strummer's VPS Chrome rerun on main `9c8f407`). The one failure is edit-posts "Trash button" both times. A traced rerun from Mac Chromium on `9c8f407` passed 5 of 5, that test included: every request answered in 3.0 s or less, where the failing runs had about 5 s. So it passes or fails on our admin latency (#1078; row "sb1120, wp trace").

### Hyperdrive WooCommerce

The latest full wc suite is local Chrome on `cf759hl`, main `9c8f407` (WordPress 7.1.5), 2026-11-21: **207 passed, 22 failed of 229** ([results.md](results.md) row "sb1120, wc rerun", Hyperdrive). The last full row before it was Browser Run on `b27cd3c`: 169 expected, 57 unexpected, 3 skipped. Against it: FIXED 41, STILL 16, NEW 6. All 6 NEW are ours and all are latency: 3 guest product pages on a page-cache MISS rendered in an unplaced `Pages` isolate at about 100 ms per query (#1277), and 3 admin and editor waits (#1078). #1296 moved that render to the placed gateway; it was reverted on 2026-11-22 for two regressions, an empty cart served from cache to shoppers (#1328) and a 19 s stall before the placed render (#1277). #1277 stays open. About 1 request in 7 boots a fresh runtime, at about 3.2 s more at the median (#1169). The older `b27cd3c` run had 14 held-block 503s (#1177). The #1180 proof reran the 8 files that hit them: 0 held-block refusals and 0 5xx (row "sb1120, #1180 proof").

A local Linux Chrome arm on main `79e6709` (row "wc arm B") took 48 failures that pass on stock, from an earlier 174 expected run. 24 of those 48 still fail on the site. The other 24 were Browser Run, or they have since been fixed. The five "two role=alert" failures passed on this arm. That class was Browser Run.

Blocks checkout passes since #1219. On `cf759hl` at #1219's head, `checkout.spec.ts` was 10 of 10 (row "wc arm B 3, the #1219 AFTER"; before it, 4 of 10 at `822ab24`). The blocks order `POST store/v1/checkout` went from 9.3 to 11.8 s down to 4.8 to 6.8 s. The counted probe shows the same 342 transient delete calls now sent as 1 statement (row "#1219 counted probe"). The 5 to 7 s left is database time (#1210, closed).

Order emails on a default deploy are sent within the suite's wait since #1224. On `cf759hl` at #1224's head, every queued email action started 2 to 11 s after it was queued (it was 12 to 122 s at `822ab24`), and `order-emails` was 6 of 6 (row "wc arm B 4, #1224"). The harness half, the admin address the seed did not export (#1216), is fixed by #1217. Older rows that say no email was sent are the sites with `A_CRON` unset. A default approach A deploy turns the cron object on (#1166, #1165).

The WooCommerce "development version" notice on every admin page (#1221) is gone since #1227 (row "#1227 live": 1 to 0 on three admin pages).

The socket-close 401 in the `b27cd3c` wc run is #1178. PR #1179 merged the code fix. No later full wc row re-measures it.

Gutenberg at GB_SHA `89408c2b` (the sha wordpress-develop 7.1.5 names), Vultr boxes with local Chromium, 2026-11-23 (#1201; rows "#1201 gb"). Counted against stock core 7.1.5 alone (`BASELINE_WITHOUT_GUTENBERG_PLUGIN=1`), after reruns: on Hyperdrive `cf759hw`, **6 tests fail on ours and pass on stock** (1,697 run; 24 unexpected in the full run, of which 15 were ours-only; on rerun 5 passed 3 of 3 and 4 passed 2 of 3). They were the 2 block-bindings image tests (#1400), the image upload through the prepublish panel (#1402) and the 3 style-revisions tests (#1401, a setup leak, not the engine). Limits: one region (Vultr lax, colo LAX), one box type (vhf-3c-8gb), local Chromium only; the stock arms ran once; the reruns are 3 per file (`--repeat-each=3`), so a 3 of 3 pass is not proof against a rare flake. Later measures update two of those. #1401 closed: style-revisions **3 of 3** on `cf759hw` with `SEED_RESET_GLOBAL_STYLES=1` ([results.md](results.md) 2026-11-24). #1424 post-#1438 met the call-count gate on both tiers. get+head+list is **8** on `cf759hw` and **7** on `cf759a`. cf759hw phpMs median is **3738**. The upload spec is 5 of 6 on `cf759hw` and 6 of 6 on `cf759a`. #1400 stays open. Earlier rows (the Mac run, Browser Run) are superseded: the Mac run was runner-contaminated, and Browser Run is not a valid Gutenberg runner.

### WfP on Hyperdrive (kind a)

The first rows for a Workers for Platforms site on the MySQL option (#1407): `pf759wa`, main `2f2d66bc`, 2026-11-23, local Chrome from a Vultr box ([results.md](results.md) rows "#1407"). **wp 22 of 22. wc 206 of 229 expected.** Against `cf759hl` (a standalone Hyperdrive site) the same day, on the same wc pin (box A, main `be82396c`): 207 expected. 9 failures are on both; 14 failed on pf759wa only in its one run, and a rerun of those 14 (3 runs each) leaves **2 confirmed**, grouped product add to cart and shop sort, both 10 s navigation timeouts (#1078's latency class). A third, the setup checklist "Can hide the task list", failed 3 of 3 only as a subset-run artefact of a setup failure seen on every one of our sites (#1412). 8 were flakes and 3 passed. Box A's own 13 that pf759wa passes are unconfirmed (not rerun). 0 cookie HITs on either. Limits: one run each, one region, and pf759wa ran with Workers Logs off, so there is no server log for these rows.

### DO WordPress on Paid

Paid DO `cf759p` (WooCommerce active), Browser Run, 1 worker, 2026-11-20: wp 18 of 18 (row "Browser Run baseline"). The same build on a local browser was 17 of 18. The miss is a memory reset on trash (#1022, open). An earlier local wp row the same day was 16 of 18. Both misses are #1022.

WfP `cf759a`: wp 17 of 18. The one failure is Quick Edit, a memory reset on `post-new.php` (#1022). No later wp row.

WfP `cf759a` (b-dosql), Gutenberg at GB_SHA `89408c2b`, 2026-11-23 (#1201, its first valid gb row; rows "#1201 gb"): **3 tests fail on ours and pass on stock** core 7.1.5 alone, after reruns (1,697 run; 25 unexpected in the full run, of which 16 were ours-only, and 13 of those passed 3 of 3 on rerun). They are the 2 block-bindings image tests (#1400) and taxonomies "create a new tag" (#1403, the editor publishes before the tag create returns). The same limits as the Hyperdrive line above.

routes.py on Paid DO and on WfP: 429 routes, `missing_core` 0, and the same 3 stock WooCommerce 500s. That routes row names no engine finding.

### DO WooCommerce on Paid

The 2026-11-21 wc reruns (rows "sb1120, wc rerun"): **Paid DO `cf759p` is blocked by #1022**, because WooCommerce's own setup never completed in three tries; the smallest seed leaves a fresh runtime at 113 MiB, about 4 below the write ceiling. **WfP `cf759a` is 116 passed, 93 failed, 20 skipped** (main `9c8f407`, VPS Chrome 149), with NEW 62 and the instrument not separated, over memory-reset churn at volume (about 230 boots and 85 write-losses in the hour; #1022). The 2026-11-20 rows below are the last ones before them.

Paid DO `cf759p`: 176 expected, 51 unexpected, 3 skipped. The open engine classes in that row are a memory reset in 23 tests (#1022) and 503 `x-sql-failure` on email-editor reads in 2 tests (#1042, open). The row also counts image 404s after a store reset (#1071), a missing storefront (#1018), and Marketing (#1044, code lock).

WfP `cf759a`: 178 expected, 50 unexpected, 2 skipped. The open engine classes are a memory reset in 16 tests (#1022) and 503 `x-sql-failure` on parallel REST reads in about 6 tests (#1042). The row also counts 2 Turnstile failures (#1032). PR #1035 merged after that run. No later WfP wc row re-measures them.

The Hyperdrive rerun on main `f9c3434` says the storefront exists (#1018). The Paid DO and WfP wc rows above are older, and they still list it.

### DO WordPress on Free

`cf759f`, WordPress only, `MEDIA=1`, Browser Run, 2026-11-20. wp is 18 of 18. routes.py called 59 routes and had 0 failures. `media_probe.py` passed 14 checks: uploads persist. This is the row the Free DO cells cite. The site has no WooCommerce, so there is no wc suite row. The earlier `MEDIA=0` rows are history.

## How to read a cell

| cell | meaning |
|---|---|
| **yes** | It works, and the cell cites the test, run or PR that shows it. No cell says yes without a citation. |
| **limited** | It works with a limit. The cell names the limit, and [Limited, and why](#limited-and-why) gives the reason and the issue. |
| **no** | It does not work, by design or because a named limit blocks it. |
| **not measured** | Nobody has tested it yet on this tier. It may work. It is not a claim either way. |

A citation is an issue or PR number, or a row of [results.md](results.md) (the date and site). A row of results.md is a record of that date. A later build can change the answer, so an old failure is "not measured" here until someone runs it again.

## The tiers and the deploy paths

| tier | what it is |
|---|---|
| **Free DO** | b-dosql: PHP and SQLite in one Durable Object per site, on Workers Free. |
| **Paid DO** | b-dosql on Workers Paid. |
| **WfP** | b-dosql as a Workers for Platforms user site (`deploy/wfp`). |
| **Hyperdrive** | Approach A: PHP in the Worker, MySQL outside Cloudflare through Hyperdrive. |

The deploy paths are `deploy/deploy.sh`, `deploy/wfp`, and one-click (the Deploy button and the site manager, #401).

## WordPress

| feature | Free DO | Paid DO | WfP | Hyperdrive |
|---|---|---|---|---|
| Install, pages, login, dashboard | yes (#638); on main, WordPress only, with media: the whole wp suite 18 of 18 ([results.md](results.md) 2026-11-20, `cf759f` MEDIA=1) | yes ([results.md](results.md) 2026-11-07, `cochk4`); the first page after a fresh install: fixed in #790 (merged 2026-11-16), measured on `deploy/wfp` only | yes: the first page after a fresh install is fixed in #790 (merged 2026-11-16; 0 of 3 died, [756b](https://github.com/skyphusion-labs/pagefeather/issues/756#issuecomment-6921835983)); code-only updates: yes (756a) | yes ([results.md](results.md) 2026-11-05, `e2e.sh` 17 of 17); WordPress only, the whole wp suite: yes, with PLACEMENT set to the database region (#1054) ([results.md](results.md) 2026-11-20, `cf759hw` wp 18 of 18 and routes 0 failures) |
| The block editor | yes, plain WordPress (#638); limited on a store (#638); the icon library: fixed in #778 (merged 2026-11-16); not yet measured live | limited: memory ceiling (#768); the icon library: fixed in #778 (merged 2026-11-16); not yet measured live | limited: memory ceiling (#768); the icon library: fixed in #778 (merged 2026-11-16). The gb suite at `89408c2b`: 3 tests fail on ours and pass on stock, after reruns: #1400 (2) and #1403 ([results.md](results.md) 2026-11-23, `cf759a`). Prepublish upload post-#1438 is 6 of 6 ([results.md](results.md) 2026-11-24, #1424) | #1201 left #1400 (2) failing on ours. #1401 closed: style-revisions 3 of 3 with `SEED_RESET_GLOBAL_STYLES=1` ([results.md](results.md) 2026-11-24). #1424 post-#1438: get+head+list 8, phpMs 3738, spec 5 of 6 ([results.md](results.md); [the summary](#latest-suite-results-sb1120)) |
| REST API | yes on main, WordPress only: routes.py 59 routes, `missing_core` 0, 0 failures ([results.md](results.md) 2026-11-20, `cf759f` MEDIA=1) | `/wp-json/` on fresh installs: fixed in #773 (merged 2026-11-16); not yet measured live; `/wp/v2/icons`: fixed in #778 (merged 2026-11-16); not yet measured live; live: routes.py 429 routes, `missing_core` 0, only the 3 stock WooCommerce 500s ([results.md](results.md) 2026-11-20, `cf759p`) | `/wp-json/` on fresh installs: fixed in #773 (merged 2026-11-16); not yet measured live; `/wp/v2/icons`: fixed in #778 (merged 2026-11-16); not yet measured live; live: routes.py 429 routes, `missing_core` 0, only the 3 stock WooCommerce 500s ([results.md](results.md) 2026-11-20, `cf759a`) | WordPress only: yes, with PLACEMENT set to the database region (#1054) ([results.md](results.md) 2026-11-20, `cf759hw`: routes.py 61 called, 0 failures); with WooCommerce: only the 3 stock WooCommerce 500s ([results.md](results.md) 2026-11-20, `cf759hl`, before #1054) |
| Application passwords and HTTP Basic | yes ([results.md](results.md) 2026-11-20, `cf759f` wp: the three applications-passwords specs pass) | yes ([results.md](results.md) 2026-11-20, `cf759p` wp: the three applications-passwords specs pass) | yes ([results.md](results.md) 2026-11-20, `cf759a` wp: the three applications-passwords specs pass) | yes, WordPress only, with PLACEMENT set to the database region (#1054) ([results.md](results.md) 2026-11-20, `cf759hw` wp 18 of 18: the three applications-passwords specs pass) |
| Permalinks | fresh installs get pretty permalinks: fixed in #773 (merged 2026-11-16); not yet measured live; unknown paths under owner-chosen plain: fixed in #804 (merged 2026-11-16); not yet measured live | the same | the same | not measured |
| Cron | not measured | not measured | not measured | not measured |
| Mail | not measured | not measured | not measured | not measured |
| Media uploads | yes with media on R2 (MEDIA=1): uploads persist ([results.md](results.md) 2026-11-20, `cf759f`: media_probe.py, 14 checks); with MEDIA=0 uploads do not persist (#1108) | yes without WooCommerce ([results.md](results.md) 2026-11-07 and 11-08: R2 and Cloudflare Images); with WooCommerce, on R2: yes, uploads persist ([results.md](results.md) 2026-11-20, `cf759p`: media_probe.py, 14 checks) | yes: gb prepublish upload post-#1438, get+head+list **7**, spec 6 of 6 ([results.md](results.md) 2026-11-24, `cf759a`, #1424) | yes: gb prepublish upload post-#1438, get+head+list **8**, phpMs median **3738**, spec 5 of 6 ([results.md](results.md) 2026-11-24, `cf759hw`, #1424) |
| Search | yes for a long term: a search builds `%term%`, which is rewritten over SQLite's 50-byte LIKE cap (#805, measured locally); semantic search limited (opt-in; the plugin side closed upstream, not measured here); limited: a LIKE with a wildcard INSIDE it, over 50 bytes, fails (#805, plugin-built only) | the same | the same | not measured; not affected by #805 (MySQL) |
| Comments | not measured | not measured | not measured | not measured |
| Site Health | directory sizes: fixed in code (#780, #799, #826); not yet measured live | the same | the same | not measured |
| Server-side requests to the site's own URL (url-details, Site Health's loopback check) | no: a Cloudflare platform limit ([why](#a-site-cannot-fetch-its-own-url-on-the-do-tiers-a-cloudflare-limit-1157)) | the same | the same | limited (#1157): a page already in the front page cache answers from it (measured on cf759hx 2026-11-21: url-details 200 in 1.3 to 1.6 s, every hop a cache hit); any other page runs on the overflow pool object `ovf-self`, and a page not yet cached in that colo pays a cold render, which can pass WordPress's 5 s timeout (measured: 8.5 s cold, 4.9 s warm; pending #1169). With the pool off (`PHP_OVERFLOW=0`): no, the same limit |
| Multisite | not measured | not measured | not measured | not measured |
| Installing plugins and themes from wp-admin | no, by design ([why](#plugins-and-themes-are-not-installed-from-wp-admin-by-design)) | no, by design | no, by design | no, by design |
| Maintenance mode during updates | no, by design: sites are code-locked; updates ship in the build and the deploy replaces the site ([why](#plugins-and-themes-are-not-installed-from-wp-admin-by-design); `deploy/wfp/README.md`, the code lock #458) | no, by design: sites are code-locked; updates ship in the build and the deploy replaces the site ([why](#plugins-and-themes-are-not-installed-from-wp-admin-by-design); `deploy/wfp/README.md`, the code lock #458) | no, by design: sites are code-locked; updates ship in the build and the deploy replaces the site ([why](#plugins-and-themes-are-not-installed-from-wp-admin-by-design); `deploy/wfp/README.md`, the code lock #458) | no, by design: sites are code-locked; updates ship in the build and the deploy replaces the site ([why](#plugins-and-themes-are-not-installed-from-wp-admin-by-design); `deploy/wfp/README.md`, the code lock #458) |

## WooCommerce

**On b-dosql (Free DO, Paid DO, WfP), WooCommerce is for a light storefront.** Under load the site's Durable Object isolate runs out of memory and resets, and writes in flight can be lost. That is a tracked limit with measured counts in [guide/limits.md](guide/limits.md) (#1022). A real store uses approach A on Hyperdrive.

| feature | Free DO | Paid DO | WfP | Hyperdrive |
|---|---|---|---|---|
| Catalog: shop and product pages | yes (#638); the false 404 (#766): fixed in #770 (merged 2026-11-16); not yet measured live | yes ([results.md](results.md) 2026-11-07, `cochk4`); the false 404 (#766): fixed in #770 (merged 2026-11-16); not yet measured live | the false 404 (#766): fixed in #770 (merged 2026-11-16); not yet measured live | yes ([results.md](results.md) 2026-11-09, `wp-a-lean` 12 of 12) |
| Cart and checkout | yes (#638) | yes ([results.md](results.md) 2026-11-08, `woocap`; the flaky failure fixed in #208) | yes (#704, `pf704`: `load.py` checkouts placed orders) | orders complete: yes ([results.md](results.md) 2026-11-09, three runs of 12 of 12). Under concurrent checkout: every checkout completed at 10, 25, 50 and 100 concurrent users in four runs, 2,710 of 2,710 ([results.md](results.md) 2026-11-20, `cf759hx`, #1077). Before the #1101 fix (#1109, #1116), 3 hung-request cancels and 1 named 503 in about 6,600 requests; after it, 0 errors in 2,232 requests. Speed limit on the blocks checkout: the order POST took 9.3 to 11.8 s on `cf759hl` at main `822ab24`, so 6 of 10 suite tests missed the 10 s thank-you wait (#1210, #1218). The fix is PR #1219, in progress, not fixed ([why](#woocommerce-checkout-on-hyperdrive-is-slow-1218)) |
| Editing the store in wp-admin | no: memory (#638) | not measured | not measured | not measured |
| Payments | not measured | cash on delivery: yes ([results.md](results.md) 2026-11-07, `cochk4`); other gateways not measured | not measured | not measured |
| Orders and HPOS | not measured | orders placed: yes (checkout rows above); HPOS not measured | the same | orders screen: yes ([results.md](results.md) 2026-11-09); HPOS not measured |
| Stock | not measured | yes: checkout lowers stock ([results.md](results.md) 2026-11-07); a cached page is usually at most about 30 s old by default, and up to 60 s after a quiet spell (PR #713; [why](#a-cached-product-page-can-show-stock-up-to-about-60-s-old-628-closed)); not measured live on this path | yes: a cached page is usually at most about 30 s old, and up to 60 s after a quiet spell ([C2 verdict](https://github.com/skyphusion-labs/pagefeather/issues/628#issuecomment-6902826012), PR #707; ggc.sh [read-back](https://github.com/skyphusion-labs/pagefeather/issues/628#issuecomment-6909672971)) | yes: checkout lowers stock ([results.md](results.md) 2026-11-09) |
| Coupons | not measured | not measured | not measured | not measured |
| Tax | not measured | not measured | not measured | not measured |
| Emails | not measured | not measured | not measured | order emails: limited on `deploy/deploy.sh`. Since #1165 the cron object is on by default (`A_CRON=1`; `A_CRON=0` opts out), so the queue runs. Delivered live on cf759hx: orders 3071 and 3182 to a postern inbox (#1143). They can be late: on `cf759hl` at main `822ab24` the alarm ran them 12 to 122 s after they were queued, past the suite's 30 s poll (#1215, open; [why](#order-emails-on-hyperdrive-can-be-late-1215)). A one-click approach A site has no cron object: not built |
| PDF invoices | every deploy path: fixed in #769 (merged 2026-11-16); not yet measured live | the same | the same | not measured |
| REST API keys in the Basic header | yes in code (#762); live run pending | yes in code (#762); live run pending | yes in code (#762); live run pending | not measured |
| REST product batch (`/wc/v3/products/batch` create) | not measured | not measured | not measured | limited: about 1.9 s per product (130 queries at about 14 ms), so the suite's 14-product batch took 27.2 s ([why](#a-rest-product-batch-is-about-19-s-per-product-on-hyperdrive-1119)) |

## The deploy paths

| feature | `deploy/deploy.sh` | `deploy/wfp` | one-click |
|---|---|---|---|
| PDF invoices | fixed in #769 (merged 2026-11-16); not yet measured live | fixed in #769 (merged 2026-11-16); not yet measured live | yes (#765) |
| Update a site | yes: `CODE_ONLY=1` in `.github/workflows/deploy-workers.yml` (the live sites `woocap`, `zarapo`) | yes: `deploy/wfp/site update` (#642; the #724 throwaways, 2026-11-16; ggc.sh) | yes, measured live 2026-11-24 ([results.md](results.md) row "#782 update round-trip", throwaway namespace `pfthrow1358`): `node deploy/provision/cli.mjs update <name>` (#782) re-uploads the user Worker and keeps the live bindings, the secret names, the site data and the placement. It does not snapshot or roll back |
| PHP overflow pool (approach A) | OFF by default since #1277 (it was on, #1119): the pool's objects run far from the database, about 3x the cost per query and a net loss of about 2 s per moved request at the median on cf759hl; `PHP_OVERFLOW=1` opts in (a queued request then runs on a Durable Object pool instead of waiting behind a long run in its isolate; about 38 USD per million moved requests, [cost](approach-a-overflow.md#cost)) | not applicable (b-dosql) | not built: a one-click approach A site has no `PhpRuntime` binding |
| Remove a site | not measured (`deploy/destroy.sh`) | yes: `deploy/wfp/site remove` (`pf704`, #704; the #724 throwaways) | yes, measured live 2026-11-25 ([results.md](results.md) row "#1458"): `node deploy/provision/cli.mjs remove <name> --delete-data` removed all 7 parts of a live throwaway with read-back; without `--delete-data` it deletes nothing and exits non-zero. With the restricted `WP_PROVISION_TOKEN` the remove stops partial at the Vectorize delete (#1484) |

## Limited, and why

### The first page after a fresh install could fail (#756, fixed)

A fresh install boots a new PHP runtime on purpose. Before the fix, the install's own runtime was retired but its memory was not collected yet. So the first page booted a second runtime beside it, and reached the memory ceiling.

- **Fresh installs (756b, [the scored run](https://github.com/skyphusion-labs/pagefeather/issues/756#issuecomment-6921835983)):** measured on `deploy/wfp` with the lean engine, on 2026-11-16. On main before the fix, the first page died in 3 of 3 counting trials (`pf756m1`, `m3`, `m4`). Each died with a write-loss 500. With the fix (PR #790) it died in 0 of 3 (`pf756k1`, `k2`, `k4`). Two more trials were void (#783).
- **Code-only updates (756a):** live sites update this way, with no install. On lean (`pf724l0`), 3 updates and 9 first pages all answered 200, with 0 deaths ([the scored run](https://github.com/skyphusion-labs/pagefeather/issues/756#issuecomment-6919876119)).

So only the first page after a fresh install was affected. #790 keeps the install's runtime for that first page. It merged on 2026-11-16 and closed #756. 756b measured the fix on `deploy/wfp` only.

### The block editor reaches the memory ceiling (#768)

A b-dosql site has one PHP object, and that object has a memory ceiling. `post-new.php` alone takes it from about 65 MiB at boot to a median of 118 MiB. That is the write ceiling. It was measured on b-dosql in the #724 runs on 2026-11-16, on the sample store. About 1 in 5 admin requests answers 500, even on the lean engine with reuse off. Memory reuse cannot help, because the page reaches the ceiling within one request. #768 is open, to find and cut the page's own peak.

Rollins bisected the peak on 2026-11-16 (#768). WooCommerce costs about 37 MiB. The wc blocks package costs about 8 MiB. The REST preload costs about 6 MiB. The REST route registration step costs about 10 MiB in the hook trace. Shipped mitigations include `wc-route-defer.php`, `woo-blocks-scope.php`, and `rest-route-cache.php`. None of them alone is measured to clear the write ceiling. The next step is a measured cut at the root, with a red test.

On Workers Free, a WooCommerce store's editor does not fit the memory limit (#638). Use Workers Paid to edit a store.

### A site cannot fetch its own URL on the DO tiers, a Cloudflare limit (#1157)

When WordPress fetches its own URL from the server (`wp_remote_get( home_url() )`), the request cannot go out through the Worker's `fetch()`. Cloudflare's docs say:

- Routes: "Routes cannot be the target of a same-zone `fetch()` call."
- Limits: "Using global `fetch()` to call another Worker on the same zone without service bindings fails." Error 1042 is also returned "for a `workers.dev` URL with no Worker serving it".

It cannot run in place either, because the request that asks holds the one PHP runtime. So the engine refuses it at once, and WordPress treats that like any failed request. The block editor's link preview (`url-details`) answers 404 `no_response` for the site's own pages, and Site Health's loopback check reports a failure. Pages, REST and checkout don't depend on it.

- **Hyperdrive (approach A):** limited, by #1157. A page already in the front page cache answers from it in milliseconds (measured live on cf759hx). Any other page runs on an overflow pool object, and **a page not yet cached in that colo pays a cold render, which can pass WordPress's 5 s timeout** (measured 8.5 s cold, 4.9 s warm), pending #1169's cold-boot work. The uncached request runs on another PHP runtime, one of the overflow pool's objects, called through its binding and never through a public URL. A request a pool object runs never calls the pool again, so a self-request is at most one hop deep.
- **The DO tiers (Free DO, Paid DO, WfP):** they have no second runtime, so this is a platform limit.

### Files PHP reads or probes from disk (#1205, #1208, #1221, fixed; one case limited)

The build drops from the PHP tree (`site.zip`) the files PHP never reads, every unminified `.css` among them; the static copy keeps everything. But PHP DOES read some stylesheets from disk, and a pruned one was silently missing:
- **Block styles** named in a plugin or theme `block.json` (`"file:./x.css"`): core registered them with an empty `src`, so no WooCommerce block style printed (#1205).
- **Theme stylesheets:** `add_editor_style` files are read and inlined into the editor, so every theme's editor styles were missing, the default twentytwentyfive's included (#1208).
- **Stylesheets a plugin reads itself,** such as WooCommerce's email editor: `content.css` and `content-shared.css` when it renders an email (#1208).
- **Files a plugin or theme probes,** with `file_exists`, `is_file`, `is_readable`, `filesize` and the like, of any type the prune removes (#1221). WooCommerce 11.2.1 checks `file_exists( WC()->plugin_path() . '/assets/css/admin.css' )`, and when it is false shows "development version, files must be built" on every admin page. A probe whose base the build can't follow is matched by its literal path (`/assets/css/admin.css`) against the plugin's own files.

All of these now stay in the PHP tree. The build FAILS if one is in the static copy but missing from the PHP tree (`block-css-keep.py --check`).

- **The limit:** a plugin that reads or probes a pruned file by a path the build can't work out (a variable, a computed name, or a bare file name after a variable) isn't covered. The build prints a `block-css-keep: note:` line naming the file and line. WooCommerce 11.2.1 has none. Keeping every unminified `.css` would cover it, at 2.25 MB more `site.zip` (+10%), which the Free and b-do tiers hold in isolate memory, so it's not the default.

### The icon library had no icons (#777, fixed)

WordPress 7.0 added an icon library, which the editor's Icon block reads from `/wp/v2/icons`. Our build dropped every core `.svg` from the PHP tree, so PHP could not read the 88 icon files. The route answered 200 with no icon content. #778 keeps those files (352 KB). It merged on 2026-11-16. It is not yet measured live.

### Fresh installs kept plain permalinks (#760, fixed), and the soft 404 (#772)

Our HTTP bridge refuses the installer's loopback probe, so a fresh install keeps plain permalinks. Then `/wp-json/` and every unknown path answer the home page with 200. Stock WordPress with working rewrites chooses pretty permalinks.

- **The workaround today:** set a permalink structure in Settings, or call REST as `/?rest_route=/`.
- **The fix:** #773 merged on 2026-11-16. A fresh install now gets the day-and-name structure, as stock does. It is not yet measured live.
- **`/wp-json/` under plain:** with #773, `/wp-json/` reaches the REST API even under a plain structure. That goes beyond stock: under plain, stock has no rewrite rule for it.
- **Owner-chosen plain, unknown paths (#772, fixed):** under a plain structure, an unknown path used to answer 200 and not 404. Stock WordPress on Apache answers 404. #804 fixes that path on b-dosql. It merged on 2026-11-16. It is not yet measured live in the conformance run.
- **Pretty structures, unknown paths (#1195, fixed):** under `/%postname%/`, a path no rule matches (`/cart/x/y/z`) answered 301 to a trailing slash and then the home page with 200. Stock answers 404. The cause was `$_SERVER['PHP_SELF']`: php-wasm set it to the requested path on its internal redirect to `/index.php`, and core's `WP::parse_request` clears its 404 when the path equals `PHP_SELF`. `php-self.mjs` now sets `PHP_SELF` to `SCRIPT_NAME . PATH_INFO`, as Apache and nginx front controllers do. Under the day-and-name structure, a missing path whose last segment names a page (`/x/y/cart`) still answers 301 to that page: that is core's own 404 guess (`redirect_guess_404_permalink`), which stock runs too.

### HTTP Basic auth was broken, now fixed in code (#761, #762)

Before #762, PHP never received `PHP_AUTH_USER` and `PHP_AUTH_PW`. So application passwords and WooCommerce REST keys in the `Authorization: Basic` header failed. The lead confirmed it live on 2026-11-16. #762 maps the header and is merged. A live run on a site built from main is still pending, so the cells say "yes in code".

### Site Health directory sizes (#780, fixed)

The Site Health > Info panel asks `/wp-site-health/v1/directory-sizes`. On b-dosql it used to answer 500 `not_available`. WordPress sums `SHOW TABLE STATUS` for the database size. SQLite reported 0 for every table. #799 and #826 put the whole database size on the first row of an unfiltered `SHOW TABLE STATUS`. Per-table sizes stay 0 on Durable Object SQLite. The directory sizes were always readable. #780 is closed. A conformance run has not filled the matrix cell yet.

### Guests could get 404 for products that exist (#766, fixed; also #794)

After a SQL failure at the memory ceiling, a later guest could get 404 for a real product. No header or log marks it. It was measured on b-dosql in the #724 runs on 2026-11-16. In one arm, 15 of 15 false 404s came within 3 s of a memory failure. The cause was a failed request that still wrote the object cache. #770 fixed it, merged on 2026-11-16. It is not yet measured live.

A related case was #794: a value derived from a failed read, then written to the database, persisted. Unlike a cache entry, it outlives every deploy. #797 rolls the request back on that kind of failure. It merged on 2026-11-16, and it is not yet measured live.

### A cached product page can show stock up to about 60 s old (#628, closed)

This is by design, and it is bounded. #628 is closed.

A logged-out product, shop or category page comes from the edge cache. A checkout that lowers stock does not clear that copy. So a guest can see a stock number or price that is a little old.

- **The bound:** a store caches those pages for 30 s by default (`PAGE_CACHE_PRODUCT_TTL`). The edge can also serve the old copy for a 30 s stale-while-revalidate window. So a copy is usually at most about 30 s old. After a quiet spell, the first visitor can get one up to 60 s old.
- **Other guest pages:** they keep 120 s, plus a 600 s window. So after a quiet spell, a copy can be up to 720 s old (#699).
- **The fix that closed #628:** PR #707 made 30 s the store default on `deploy/wfp`, as a recorded setting. PR #713 (#706) did the same for `deploy.sh` and one-click.
- **The evidence:**
  - The [C2 verdict](https://github.com/skyphusion-labs/pagefeather/issues/628#issuecomment-6902826012) passed all four bars on a `deploy/wfp` store.
  - On ggc.sh, a product page re-rendered every 32 to 36 s, the longest 36.5 s ([read-back](https://github.com/skyphusion-labs/pagefeather/issues/628#issuecomment-6909672971), 2026-11-16). That was under steady traffic.
  - The 60 s worst case after a quiet spell comes from the headers (`max-age=30, stale-while-revalidate=30`, `page-cache-ttl.mjs`). It is not measured.
- **What stays safe:** checkout always reads the real stock, so the store never sells more than it has. When a product sells out, its page is cleared.

A store that shows exact stock numbers can use a lower `PAGE_CACHE_PRODUCT_TTL` (5 to 600 s). See [Stock numbers on cached pages](guide/from-lamp.md#stock-numbers-on-cached-pages).

### PDF invoices worked on one-click only (#765, fixed)

The feature needs the `BROWSER` binding. `deploy/wfp` and `deploy.sh` rendered none, so only one-click sites could make invoices. #769 adds `PDF_INVOICE=on` to both paths. It merged on 2026-11-16 (`5a94341`). It is not yet measured live on those paths.

### One-click can add, update and remove a site (#765, #782)

The one-click CLI implements `site add`, `site update` and `site remove`. Update re-uploads the user Worker. It keeps the live bindings and the secret names, and it sends no migrations block, so the Durable Object data stays. It does not snapshot and it does not roll back. Remove deletes nothing unless `--delete-data`. Without that flag it names the site code (the database lives there) and the media bucket, and it exits non-zero. Both are unit-tested against a stand-in API. Neither is measured on a live site. A re-upload that keeps a secret and a Durable Object row was measured on a throwaway namespace script (the #782 probe, 2026-11-17), not through this command, and not for every binding shape.

### A LIKE with a wildcard inside it, over 50 bytes, fails on SQLite (#805)

The Durable Object's SQLite caps a `LIKE` pattern at **50 bytes**, not SQLite's default 50,000 (measured locally, 2026-11-17: 50 bytes pass, 51 fail, "LIKE or GLOB pattern too complex"). D1 documents the same 50. MySQL has no such cap. Hyperdrive runs MySQL, so #805 does not affect it.

- **Rewritten, so it works at any length** (the SQL dialect, `php/d1-dialect.php`): a pattern over the cap that is ONE literal becomes a plain comparison with the same result:
  - `'%term%'` (every WordPress search: the site search, the users list, the REST searches, `meta_query` LIKE);
  - `'term%'` (a prefix);
  - `'term'` (an exact match, such as a plugin calling `get_users()` with a long search and no `*`; before #805 this returned an empty list).
  NOT LIKE is rewritten too. A pattern at or under 50 bytes is left to SQLite as before.
- **Still a limit:** a pattern over 50 bytes with a wildcard INSIDE it (`_` anywhere, or `%` between literals), or a suffix match (`'%term'`). SQLite refuses it. **No WordPress core path builds one from user input** (measured on #805). Plugin code that writes such a `LIKE` by hand can. WooCommerce's cart-page check is the one known case, and `php/woo-cart-page.php` handles it (#744).
- **What the visitor sees in that case:** an empty result with HTTP 200, a plausible wrong answer. Whether a deterministic refusal should answer a visible error instead is #836.

### WooCommerce checkout on Hyperdrive is slow (#1218)

Orders complete. On `cf759hl` at main `822ab24` (2026-11-21, row "wc arm B 2" in [results.md](results.md)), 6 of 10 blocks checkout tests still miss the suite's 10 s thank-you wait (#1210). In each one, `POST store/v1/checkout` takes 9.3 to 11.8 s. The thank-you page then answers 200 in 1.6 to 4.0 s.

The cause is per-order transient deletes. A query trace of one guest order on that build shows 700 queries and 9.3 s of database time. 404 of the queries, 4.8 s, are `DELETE`s of per-order transients. #1206 made transients durable rows in `wp_options` and deleted each one on its own round trip. HPOS is on.

PR #1219 coalesces those deletes into one statement at the end of the request. The results row says that, locally, 364 transient DELETE statements per order become 1. PR #1219 is open. The fix is in progress, not fixed. #1210 stays open for a live spec run.

### Order emails on Hyperdrive can be late (#1215)

WooCommerce defers each order email to Action Scheduler. On approach A the cron object runs that queue ("via Skyphusion DO alarm"). On `cf759hl` at main `822ab24` (row "wc email wait", 2026-11-21, before #1176 merged) the alarm started the action 12 to 122 s after it was queued. The suite polls the mail log for 30 s, then the fixture deletes the order. An action that runs later finds no order and completes without sending. #1215 is open.

This is not the old "no cron" miss. Those rows are sites with `A_CRON` unset. A default `deploy/deploy.sh` approach A deploy turns the cron object on (#1166, #1165).

A second miss on that run is the harness (#1216). Two "admin receives" specs wait for `admin@woocommercecoree2etestsuite.com`. WooCommerce sends to the site admin address, which the seed sets to something else. New order 1394 was sent in time, to the site address. PR #1217 is open.

### The WooCommerce "development version" admin notice (#1221)

#1221 is closed. PR #1227 fixed it (merged 2026-11-21): the build now keeps the files that WooCommerce probes, so PHP sees them. A live check on `cf759p` after the merge found the notice on 0 of 3 WooCommerce admin pages, against 3 of 3 before (results.md row "#1227 live"). That is a live check, not a suite run: no conformance suite row tests the notice. Before the fix, PHP's `file_exists` did not see `assets/css/admin.css` or `assets/js/admin/woocommerce_admin.min.js`, while an anonymous GET of both answered 200 (`cf759hl`, 2026-11-21, recorded on the issue).

### A REST product batch is about 1.9 s per product on Hyperdrive (#1119)

WooCommerce creates each product in a batch with about 130 database queries, one after another. On Hyperdrive each query is one round trip to the database, about 14 ms, so a batch costs about 1.9 s per product. That is WooCommerce's own write path, not an engine bug.

- **Live (cf759hl, 2026-11-20, build `7acbc3c`, westus2, `PLACEMENT=azure:westus2`):** the wc-api suite's product-list sample data, `POST /wp-json/wc/v3/products/batch` with 14 simple products, made 1,829 queries in one PHP run of 27.2 s (19:09:30.8Z to 19:09:58.0Z, Workers Observability). The suite's client gives up at 10 s.
- **The same batch locally (method):** the suite's exact payload (WooCommerce pin `67e007c3`, `product-list.test.ts`), with `SAVEQUERIES` on, made 1,805 queries in 2.0 s on dosql-local, so the count is the same on both engines and only the round trip differs. Of the 1,805, about 470 are writes, and about 1,060 more are reads caused by those writes in the same request: an existence check before each meta insert, the post meta cache reloading after each write, and the term caches cleared by each term count update. A cache across requests (#1090) cannot remove them, and placement is already set (#1054).
- **What a client sees:** a batch of more than about 5 products takes longer than 10 s. A short request on the same isolate waits behind it (the suite's term GET waited 11.3 s, then ran in 0.5 s); that wait is what the overflow pool (`PHP_OVERFLOW`, #296) addresses, but the pool is OFF by default since #1277 (its objects run far from the database; `PHP_OVERFLOW=1` opts in), so on a default deploy the wait stands.

### Semantic search: the plugin side is closed upstream, not measured here

The `vectorize-search` descriptor is opt-in. The search engine is the skyphusion-ai plugin. Its token-free bridge path is closed upstream (skyphusion-ai#193, completed 2026-11-12), but no Pagefeather run has measured a search through it, so the cell stays limited. See [guide/limits.md](guide/limits.md).

### Plugins and themes are not installed from wp-admin (by design)

WordPress, its plugins and its themes run from the Worker's code bundle. The bundle is read-only at run time: a site has no writable disk to install into. So plugins and themes ship in the build, pinned by content hash, and a change is a code deploy (#458).

To make that plain in wp-admin, every site is code-locked. `wp-config.php` sets `DISALLOW_FILE_MODS` and `DISALLOW_FILE_EDIT`, so the install, update and editor screens are off. See [guide/from-lamp.md](guide/from-lamp.md).

No user has the `install_plugins` capability, so the WordPress and WooCommerce screens that recommend plugins to install stay empty. WooCommerce's Marketing > Overview shows no Channels card: `wc-admin/marketing/recommendations` needs `install_plugins` (`MarketingRecommendations.php:76`) and answers 403. Measured on `cf759a`, 2026-11-20; the conformance runs exclude that one test with this reason (#1044).

## Not measured, and what will measure it

The conformance runs (#759) cover many of the "not measured" cells. They run the upstream WordPress and Gutenberg browser suites, WooCommerce's core browser profile, and the API half. Each runs on a throwaway, with and without the page cache. Each is compared with stock WordPress at the same versions. The sb1120 rows are the latest of those runs. See [Latest suite results](#latest-suite-results-sb1120).

Some cells are still not measured. Multisite has no row on any tier. Cron and mail on the DO tiers have no suite row. On Hyperdrive, order mail and the cron alarm do have rows: the mail is sent, and it can be late (#1215). Gutenberg has no valid full-suite row yet (#1201).
