# Known limitations

This page lists what does not work yet, or works only with care, so you can plan around it before you build. Each item names its issue, where you can follow it or help. The current paths still run: the built-in database option for a blog or a light storefront, and the MySQL option for a real store and to scale out. The sb1120 items below are open limits on those paths. See the [guide index](README.md).

**Names on this page.** The built-in database option is `b-dosql`, and the MySQL option is approach A (MySQL through Hyperdrive). An **isolate** is one running copy of the site's code, with its own memory. The figures below are measured per isolate, so this page keeps the word.

## Open from the sb1120 conformance runs (#759)

The rows are in the results table ([evidence](../results.md)), 2026-11-20 and 2026-11-21. The support matrix summary has the per-tier counts.

### On the MySQL option, a guest product page that was not cached yet was slow (#1277, open until measured end to end)

On `cf759hl`, 3 guest product pages on a page-cache MISS took 9 to 12 s at the browser, past the suite's 10 s wait. The render ran in the `Pages` isolate at the visitor's edge, far from the database: about 57 ms per query under load, against about 17 direct.

#1296 rendered a MISS in the placed gateway instead. It was **reverted** on 2026-11-22 (the lead's ruling), because the full wc suite on `cf759hl` (hlm029) found two regressions:
- a cookieless guest copy was served to a request with the WooCommerce cart cookies, so the shopper saw an empty cart (#1328);
- about a quarter of the `Pages` MISS calls stalled about 19 s before the placed render started, and after 15:50Z every guest MISS did. The guest-page timeouts went from 4 to 8 (#1277).

A MISS now renders in the `Pages` isolate again, as described above. A new hand-off must fix both before it merges. This item and #1328 stay open until then.

### WooCommerce checkout is slow on the MySQL option (#1218, #1210)

On `cf759hl` at main `822ab24`, 6 of 10 blocks checkout tests missed the suite's 10 s thank-you wait (#1210). The order POST took 9.3 to 11.8 s. The order was placed, and the page then answered 200. A query trace of one guest order showed 404 per-order transient DELETEs, 4.8 s of database time. #1206 added that cost.

PR #1219 fixed that part (#1218, merged 2026-11-21): the engine sends a request's transient deletes as one statement at its end. On one counted order, 352 DELETE statements became 11 (row "#1219 counted probe"). On PR #1219's head, before the merge, 10 of 10 blocks checkout tests passed, and the order POST took 4.8 to 6.8 s (row "wc arm B 3"). The time that is left is database time, about 13 ms a query. That is still a slow checkout, and #1210 is closed. No full wc suite has run since the merge.

### WooCommerce admin screens and bulk product edits are slow on the MySQL option (#1078)

On a Hyperdrive store (approach A), WooCommerce admin screens and bulk product edits take seconds, not a fraction of a second. Plan for it if your staff edit many products at once.

**What you will see:**
- **A product save** takes about 2 to 3 s. An unloaded save on `cf759hl` made 118 database queries and took 2.6 s on the server.
- **A batch of 5 new products** took 6.5 s (445 queries). Under the WooCommerce test suite's load, larger product batches took up to 14 s (p95), past a 10 s client timeout.
- **The product edit screen** took about 3 s (64 queries). The other admin and editor screens took 1 to 3 s each.

**Why:** each database query to Hyperdrive costs about 16.6 ms (the median over requests with 20 or more queries; 24.7 ms at p90). The time is that cost times the number of queries. WooCommerce writes each product field on its own, and WordPress has no way to write several fields in one query. So a product save makes about three queries per field. We measured that and checked it in WooCommerce's and WordPress's code. We found no change on our side that cuts the count by enough without risking stale data.

**What it does not affect the same way:** shoppers. Guest storefront pages are served from the page cache, and the checkout has its own item above.

**The evidence:**
- the query ranking from the full suite run: [#1078, the ranking](https://github.com/skyphusion-labs/pagefeather/issues/1078#issuecomment-7083030477);
- the per-request query trace (2026-11-22): [#1078, the trace](https://github.com/skyphusion-labs/pagefeather/issues/1078#issuecomment-7083253110);
- why each candidate fix was rejected:
  - the meta write-through: [#1078, the rejection](https://github.com/skyphusion-labs/pagefeather/issues/1078#issuecomment-7083310006);
  - WooCommerce's write loop and the scoring against the bar: [#1078, the levers](https://github.com/skyphusion-labs/pagefeather/issues/1078#issuecomment-7083327101);
  - the templates-list fix, stopped at its pre-check: [#1078, the templates check](https://github.com/skyphusion-labs/pagefeather/issues/1078#issuecomment-7083356454).

### A database query is cut off after 30 s on the MySQL option (#1359)

On approach A, one MySQL query may take at most 30 s (`DB_QUERY_TIMEOUT_MS`, default 30,000). Set `DB_QUERY_TIMEOUT_MS` to override it (digits only, 1 to 600,000). `deploy.sh`, `deploy/wfp` (kind a) and one-click render it when it is set. Leave it unset and the 30 s default stands. Past the bound, the query fails as a lost connection, and WordPress shows a database error for that request. In three full WooCommerce suite runs, no query came near it: the longest requests are thousands of short queries. The bound exists because a query that never answers holds the isolate's PHP lock, and every later request on that isolate is refused with a 503. **What it covers:** a query that never answers in a request that is still running (for example a Hyperdrive hang). **Not yet:** the case #1277 measured, where a client hangs up mid-request. If the platform stops that request's work, the bound cannot fire there either. That is being measured, and a second fix is planned (#1359). The bound and its reasons are in [the deploy README](../../deploy/README.md#when-a-database-query-does-not-answer-1359).

### Order emails on the MySQL option were late (#1215, fixed)

WooCommerce queues each order email. The approach A cron alarm ran those actions 12 to 122 s later, on `cf759hl` at main `822ab24` (row "wc email wait"). The suite polls for 30 s, so a send could miss that poll. A second miss on that run was the harness (#1216; PR #1217 fixed it, merged 2026-11-21).

PR #1224 fixed the delay (#1215, merged 2026-11-21): a queued email wakes the cron within seconds. On its head, before the merge, all 13 email actions ran 2 to 11 s after queueing, and order-emails passed 6 of 6 (row "wc arm B 4"). The 8 failures on that run are email-editor latency (#1078), not the queue. No full wc suite has run since the merge.

### The WooCommerce "development version" admin notice (#1221)

#1221 is closed. PR #1227 fixed it (merged 2026-11-21): the build now keeps the files that WooCommerce probes, so PHP sees them. A live check on `cf759p` after the merge found the notice on 0 of 3 WooCommerce admin pages, against 3 of 3 before (results.md row "#1227 live"). That is a live check, not a suite run: no conformance suite row tests the notice.

### WooCommerce on the built-in database option: the site resets under heavy load, a tracked limit (#1022)

#1022 is open and is a tracked limit, not active work (Conrad's ruling, 2026-11-22). A real store should use approach A on Hyperdrive. On b-dosql, WooCommerce runs PHP in one Durable Object per site. Under load, that object's isolate runs out of memory and the platform resets it: "Durable Object's isolate exceeded its memory limit and was reset." A write in flight on that isolate can be lost (`x-write-loss`), and the client can see "Network connection lost."

**Measured counts.** These come from `cf759a` (WfP, WooCommerce active, engine defaults, `OPCACHE_MC` 64), counted with `tests/load/reuse_score.py` at ddf83b2e (`platform_deaths`: distinct isolates, the death text in any field; a line's request is its `$metadata.requestId`). Lost writes are `write-loss` lines.

| window | requests or tests | isolates that died of memory | lost writes | other |
|---|---|---|---|---|
| `reuse_run.py` load, main 56f44937, 2026-11-22 (E3's control) | 328 server requests (perf lines) | 14 (43 per 1000 server requests) | 16 (49 per 1000 server requests) | 61 new isolates per 1000 server requests |
| wc suite, the same build and session | 113 expected, 110 unexpected, 6 skipped | 110 | 88 | 18 "Network connection lost.", 24 php-fatal |
| wc suite, main a85fe3db (E1's control) | | 55 | 47 | 17 "Network connection lost.", 15 php-fatal |

The engine code on this path was the same in both suite windows, and they gave 55 and 110 deaths. One suite window is noisy, so the load harness is the measure of record.

**Where the memory goes.** In E3's 23 death isolates, the last completed request held a WebAssembly heap of 103 to 116 MiB (median 112). The write ceiling is 117 to 119 MiB (see the three figures below).
- **OPcache:** its shared memory is 64 MiB on a store, reserved before the first request.
- **Not boots:** 22 of the 23 deaths came on a warm request, not on a boot.
- **The JavaScript inflate burst:** under 2 MiB on those requests.
- **Not measured:** the rest of the JavaScript heap. The platform gives no reading.

**What was tried.** Each lever had its bars set before its data (#1022).

| lever | result |
|---|---|
| Reuse the WebAssembly memory across a recycle (`PHP_MEMORY_REUSE`; the A/B and E1) | FAIL: deaths and lost writes rose; 76% of E1's deaths came 5 to 7.5 s after a reuse reboot |
| One reused inflate buffer (`LAZY_ARENA`, E3) | FAIL on deaths: 9 against 14, where the bar was half. It is a large latency gain (guest p95 0.38x), parked as E4 |
| Smaller OPcache, 32 MiB (E5) | stopped at its local pre-check: the heap high-water was higher than at 48 MiB |
| A smaller boot file set (#1253) | closed: the file set is what WordPress and WooCommerce include; the engine already holds only what PHP opens |
| OPcache 48 MiB on a store (E6) | queued: the last lever (Conrad, 2026-11-22). Its bars are on #1022 |

E6 is the last lever on this path. After it, b-dosql keeps WooCommerce for a light storefront, and the work moves to the Hyperdrive tiers.

### Parallel REST reads can fail on the built-in database option (#1042)

#1042 is open. Parallel REST reads answer 503 with `x-sql-failure`. The same wc rows count that class: 2 tests on Paid DO, about 6 on WfP. No later wc row has re-run those tiers.

## Requests to the site's own URL (#1157)

A Worker cannot fetch its own site. Cloudflare refuses a same-zone `fetch()` without a service binding (error 1042, `workers.dev` included). The PHP runtime that asks is also busy with the request that asks. So a `wp_remote_get()` of the site's own URL (a "self-fetch") is answered in one of these ways, in this order:

1. **The overflow pool is on** (approach A, `PHP_OVERFLOW` on): the request runs on one named pool object (`ovf-self`), one hop deep (#1170).
2. **The pool is off, and the page is in the front page cache:** a guest GET is answered from the cache (#1326).
3. **Otherwise:** the request is refused. PHP gets a `WP_Error` ("a request to this site itself is refused ..."). A refused self-fetch logs one `self-fetch` line with `outcome: "refused"`.

**One workaround for case 3: url-details** (`GET /wp-block-editor/v1/url-details`, the block editor's link preview; Conrad's choice, 2026-11-22). When the refused request is a GET that core's url-details controller sent (it is tagged through `rest_url_details_http_request_args`), `php/url-details-self.php` answers it in-process, with no HTTP hop. The answer is a 200 whose body is a minimal `<head>` built from WordPress's own data. Core's controller then parses it, caches it (its 1 h site transient) and applies `rest_prepare_url_details`, as it does for a fetched page. The response carries `x-pf-synthetic: url-details-self`. This is the site's own host only, GET only, and url-details only.

**How it differs from stock WordPress:**
- **`title`:** core's document title for the post that the URL names (`url_to_postid`), or for the front page. It uses the same parts and the `document_title_separator`, `document_title_parts` and `document_title` filters, but without the main query. A plugin that changes the title by reading the main query (`pre_get_document_title`, or a `document_title_parts` callback that checks `is_singular()`, as SEO plugins do) gets a different result. A paged URL (`/page/2`) has no "Page 2" part.
- **`icon`:** what `wp_site_icon()` prints (core reads the first `rel=icon`). It is empty when the site has no site icon, as on stock.
- **`description` and `image`:** always empty. Core prints no `meta description` and no `og:image`, so stock is empty too. A plugin or theme that adds them (SEO plugins do) is not reflected, because the page is not rendered.
- **Still refused (404 `no_response`), never guessed:**
  - a URL that names no post or page (an archive, a term, an author, search, a custom route);
  - a post that an anonymous visitor cannot see (draft, private, trash). Stock's anonymous fetch gets a 404 for these too.
  - a classic theme without `title-tag` support, which prints its own `<title>`. A block theme is answered: its template prints core's document title whether or not it declares `title-tag`.

**Other self-fetches on an uncached URL with the pool off stay refused:**
- Site Health's loopback and REST availability tests;
- the theme and plugin file editor's loopback check after an edit;
- HTTPS detection (`wp_update_https_detection_errors` fetches the home URL);
- Action Scheduler's async queue runner (a POST to `admin-ajax.php`; due actions then wait for the cron alarm);
- `spawn_cron()`. #1310's cron self-tick covers cron in another way.
- any plugin that calls its own REST route or front end;
- oEmbed discovery of an own URL that is not a post or page.

oEmbed of the site's own posts and pages is NOT a self-fetch: core resolves it in-process (`wp_filter_pre_oembed_result` on `pre_oembed_result`, through `url_to_postid`). No HTTP request is made, so it is not refused.

**Measured so far:** the decision path only, in `tests/url-details-self-test.php` (23 checks) and `tests/self-fetch.test.mjs`. 16 mutants of the guards each turn one of them red. The live proof on `cf759hw` (pool off) and the two gb navigation specs ("can update page link to a new page link" and "Focus management when using the navigation link appender") are on #1157.

## A new tag added just before Publish can be lost when the site answers slowly (#1403)

**What you see:** in the block editor, you type a NEW tag (one that does not exist yet), press Enter, and click Publish at once. The tag shows in the Tags box, but after a reload the post has no tag. The tag itself was created. Only the post did not get it.

**Why:** the editor does not wait for a new tag to be created before it saves the post. This is upstream Gutenberg behaviour, not something our site adds. At the pinned Gutenberg (`89408c2b`, the one WordPress 7.1.5 ships):

- The Tags box shows the new tag at once ("Optimistically update term values", [flat-term-selector.js](https://github.com/WordPress/gutenberg/blob/89408c2b9bd944575dfa9039bc6870da1c8f56cb/packages/editor/src/components/post-taxonomies/flat-term-selector.js#L205-L237)). It adds the tag's id to the post only when the create call answers (`Promise.all(... findOrCreateTerm ...).then(... onUpdateTerms ...)`).
- Nothing there locks saving while that call runs (no `lockPostSaving`).
- `savePost` saves the edits it has at that moment ([actions.js](https://github.com/WordPress/gutenberg/blob/89408c2b9bd944575dfa9039bc6870da1c8f56cb/packages/editor/src/store/actions.js#L187-L230)).

So whichever answers first wins. On stock WordPress on a local server, the tag create answers in milliseconds, so the tag is in place before Publish. On our sites a REST call takes about half a second (#1078). In #1201's runs, the publish began 160 ms before the tag create answered, and the post was saved without the tag.

**Measured:** the upstream test `taxonomies.spec.js` "should be able to open the tags panel and create a new tag" failed 4 of 4 on the WfP built-in database site `cf759a`. It passed on stock, and it passed on `cf759hw` ([evidence](https://github.com/skyphusion-labs/pagefeather/issues/1403)).

**What to do:** after you add a new tag, wait until the editor has finished saving it (about a second) before you click Publish. Or check the Tags box after the first save, and save again if the tag is missing. Tags that already exist are not affected: their ids are known at once.

## Two upstream block-bindings image tests race the image load (#1400)

**What this is:** two Gutenberg end-to-end tests are excluded from our runs. They test the test, not the site: no editor behaviour you can see is wrong. They are "Registered sources > getValues > should show the returned values in image attributes" and "... setValues > should be possible to edit the value of the text custom field from the image alt", in `custom-sources.spec.js`. The block binding itself works on our sites: the bound values reach the image every time.

**Why they fail:** each test inserts an Image block whose image is a fresh upload, then clicks the `<img>` with `force: true` ([L231](https://github.com/WordPress/gutenberg/blob/89408c2b9bd944575dfa9039bc6870da1c8f56cb/test/e2e/specs/editor/various/block-bindings/custom-sources.spec.js#L223-L231), [L1011](https://github.com/WordPress/gutenberg/blob/89408c2b9bd944575dfa9039bc6870da1c8f56cb/test/e2e/specs/editor/various/block-bindings/custom-sources.spec.js#L1003-L1011)). `force` skips Playwright's wait for the element to be visible. Until the image arrives, the `<img>` has `height: auto` and no height, so the click fails at once: "Element is outside of the viewport". On stock WordPress on a local server, the image arrives in a few milliseconds, before the click. On our sites it takes 142 to 219 ms (#1400), and the click starts about 40 ms after the image is requested.

**Measured:**
- On `cf759hw` (approach A) and `cf759a` (WfP built-in database), both tests failed 8 of 8, always with that error. The traces show each click starting while its image GET was in flight ([evidence](https://github.com/skyphusion-labs/pagefeather/issues/1400#issuecomment-7110538766)).
- **The control on stock:** stock WordPress 7.1.5 in wp-env, with a proxy that delays only `/wp-content/uploads/*`. Both tests passed 6 of 6 at 0 ms, 4 of 6 at 150 ms, and **0 of 6 at 250 ms and at 400 ms**, every failure the same error ([the rule](https://github.com/skyphusion-labs/pagefeather/issues/1400#issuecomment-7111624141), [the reading](https://github.com/skyphusion-labs/pagefeather/issues/1400#issuecomment-7112225805)).

So any host whose uploads take about 150 ms or more fails these two tests, stock WordPress included.

**The engine lever:** #1418. On approach A, every uploads GET crosses to the placed entrypoint and is not stored at the edge. Shortening that would make every image faster for real visitors and editors. It would not reliably get a first image under 40 ms, so the exclusion stays.

## Permalinks: a structure saved with /index.php stays until you re-save it (#1345)

Before #1345, WordPress on this engine believed that URL rewriting was not available. So Settings, Permalinks offered every structure with an `/index.php` prefix: choosing "Post name" saved `/index.php/%postname%/`, not `/%postname%/`. The engine has always sent every path that is not a file to `index.php`, so pretty permalinks without `/index.php` do work. Since #1345, the screen offers them, as on a stock Apache or nginx host.

**What to do on a site set up before #1345:**
- **If your permalink structure starts with `/index.php/`** and you want stock URLs, go to Settings, Permalinks, choose your structure, and save. That is the only change needed. WordPress keeps a stored structure until an admin re-saves this screen, so the engine update alone does not change it.
- **Old links keep working:** WordPress redirects an `/index.php/...` URL to the new permalink.

**Why it matters:** under `/index.php/%postname%/`, a post whose slug is all digits (an untitled post gets its id as the slug) can answer 404. Its URL is read as a year archive, because WordPress only renames such slugs when `%postname%` comes first in the structure. Under `/%postname%/` the slug becomes `<id>-2`, and the post is served.

## The built-in database option

### Deactivating WooCommerce can return 500 on a site that has been running (#219)

Deactivating WooCommerce in wp-admin, on a `b-dosql` isolate that WooCommerce already warmed, can return 500. The cause is the 128 MB isolate cap, and here it is not the WebAssembly heap: on that isolate the heap was at 99 MiB, and the overflow is the JavaScript heap, which `x-wasm-mib` does not show (#219, 2026-11-09). #219 is closed as not planned; this section is its record. A skip of WooCommerce, as the media-upload path uses, cannot apply, because the request is about WooCommerce itself. The lever is memory headroom, mainly lazy MEMFS nodes (`LAZY_NODES=on`, #218). The store Container (approach C) was retired (#214), so it is not the fix here. That is separate from the open question of where wp-admin runs (Workers or a Container), which is decided after the new engine is fully tested.

## The guest page cache

### A page that depends on a request header must say so

The guest page cache stores a page under its path and query string. It does not store a page for a request that has a
WordPress cookie (a logged-in user, a cart, a comment author), an `Authorization` header (Basic auth, application
passwords), or a path in the no-cache list (`/wp-admin`, `/wp-login.php`, `/wp-json`, `/cart`, `/checkout`,
`/my-account` and the others in `PAGE_CACHE_NO_PATH` in `spikes/b2-wordpress/index.js`).

For every other guest GET, the cache follows the response's own headers:

- `Cache-Control: private`, `no-store` or `no-cache`: the page is not stored.
- `Vary`: a page that sends `Vary: X-Something` is not served to a later request that has no `X-Something` header
  (measured). A request with a different `X-Something` value was not measured, so do not rely on `Vary` alone for a
  page that is different for each caller.
- No `Vary` and none of those `Cache-Control` values: the page is stored by URL, and every later guest at that URL gets
  the same copy for the cache time (`PAGE_CACHE_TTL`, 120 s by default).

So a theme or plugin that builds a different guest page from a request header (a custom header, a device or region
header, an API key in a header) must send `Vary` naming that header, or `Cache-Control: no-cache` (WordPress's
`nocache_headers()`) or `private`. For a page that is different for each caller, send `private` or `no-cache`
rather than rely on `Vary`. Without one of them, the first answer at that URL is the one that guests get. This is how any
cache that keys by URL behaves; a site behind a CDN has the same rule.

### On overload, a logged-in or cart visitor gets "site is busy" (HTTP 429), not a stale page (#1328)

When the site is too busy to run a request (the PHP lock sheds it), Cloudflare serves the stored guest copy of that URL, marked STALE, in place of the engine's 503. It does this even for a request that never went to the cached entrypoint, for example one with a WordPress login or cart cookie. Measured on cf759hl, 2026-11-22, 3 of 3. That would show a guest's page to a shopper.

So the engine answers that busy refusal with a **429** instead, with the same "site is busy" text and `Retry-After`, because a 429 reaches the client as is (3 of 3). This applies only to a page GET or HEAD whose URL can have a stored copy but which carries a WordPress cookie, authorization or an operator header (`page-copy.mjs`). Guests keep the stale copy on a shed. REST, ajax, the Store API, admin, cart, checkout and my-account keep their 503.

What this does not cover:
- **Other errors:** a PHP error (500), a write-loss answer, or a Worker that throws or runs out of memory on such a request can still be answered by the stale guest copy. Only the busy answers (`x-overloaded`) are changed. Tracked in #1373, with the options.
- **Not measured yet:** whether a cookie request's 429 replaces the stored guest copy, so that the next guest gets a MISS.

## Memory limits: the three figures

Three memory figures appear in these docs. They are not the same limit.

| Figure | What it is |
|---|---|
| 128 MB per isolate | Cloudflare's documented limit. The Workers limits page, as read in [evidence](../design-394-bundle-out-of-memory.md), 2026-11-13. That page includes the JavaScript heap. |
| about 255 MiB | Measured reachable size in an empty isolate (#394, [evidence](../admin-memory-matrix.md), 2026-11-14). |
| 117 to 119 MiB of wasm | The measured write ceiling (#598). This is the figure that binds a site. |

`x-wasm-mib` is the PHP WebAssembly heap only, so the JavaScript heap is not in that header.

## A heavy plugin set: memory and bundle size (the built-in database option, measured 2026-11-11)

Measured on a real store imported for skyphusion-labs/ggc#101. It runs WooCommerce 11.2.1, Rank Math 1.0.280, skyphusion-ai 0.6.2, MCP Adapter 0.7.1 and twentytwentyfive, on a site in `deploy/wfp`. The test was a guest probe: the home page, the Store API, the shop, a product, the cart and a cheque checkout.

| plugin set | PHP memory per request | result | bundle (the four files the size gate counts) |
|---|---|---|---|
| with Rank Math | 119 MiB, the runtime recycled on every request | every other request 503; no checkout completed | 61.46 MiB |
| without Rank Math | 99 MiB (the shop page alone reaches 119 MiB and recycles, still 200) | 24 of 24 checks pass over 3 runs; checkout works | 58.40 MiB |

So memory, not the code, decides whether a store this heavy runs on b-dosql. With Rank Math the requests reach 119 MiB of wasm: the top of the measured write ceiling (117 to 119 MiB, the figure that binds; see the three figures above). The isolate cap itself is 128 MB. The bundle has a limit too: the Worker limit is 64 MiB uncompressed. `deploy/wfp/lib.sh bundle_size_check` stops an upload above `BUNDLE_MAX_MIB` (default 62), and `build_dosql`, `site.sh up` and `site update` all run it. If your store needs Rank Math, or a plugin set this heavy, approach A (MySQL through Hyperdrive) is the better fit, rather than b-dosql.

## The 18 checked plugins

These are pinned and checked, so you can add them with `PLUGINS="slug slug"` when you deploy. Pinned does not mean it fits: see [How many plugins fit](#how-many-plugins-fit), which names the ones that are too big. The pinned versions are in the evidence file ([evidence](../../tests/plugins/suite.txt)).

| Plugin | Slug |
| --- | --- |
| Elementor | `elementor` |
| Yoast SEO | `wordpress-seo` |
| Contact Form 7 | `contact-form-7` |
| Classic Editor | `classic-editor` |
| LiteSpeed Cache | `litespeed-cache` |
| Site Kit by Google | `google-site-kit` |
| Akismet | `akismet` |
| WPForms Lite | `wpforms-lite` |
| All-in-One WP Migration | `all-in-one-wp-migration` |
| Wordfence | `wordfence` |
| WP Mail SMTP | `wp-mail-smtp` |
| Rank Math SEO | `seo-by-rank-math` |
| UpdraftPlus | `updraftplus` |
| Yoast Duplicate Post | `duplicate-post` |
| Duplicate Page | `duplicate-page` |
| Jetpack | `jetpack` |
| Really Simple SSL | `really-simple-ssl` |
| WPCode (Insert Headers and Footers) | `insert-headers-and-footers` |

## How many plugins fit

The limit is memory per request. It shows up on the heaviest admin pages. It is not a count of installed plugins.

The isolate cap is 128 MiB. On the Durable Object tiers, writes fail at about 117 to 119 MiB of WebAssembly heap (an estimate from #598 and #1022).

PHP's heap tracks the compiled scripts a request loads. The cost is about 38 KiB per compiled script (an estimate from #1022's mem-trace and #1253).

`post-new.php` with WooCommerce is the heavy page. From a fresh runtime, local runs peak at 107 to 115 MiB (#1022). On an older live build, the median is 118 MiB (#598, #724 r3). That median sits where writes fail.

WooCommerce accounts for about 28 MiB of that page (an estimate from #1022's bisect). Its block registration accounts for about 11 MiB of the page (an estimate from the same bisect). Without WooCommerce, the same page is about 81 MiB (an estimate from the same bisect).

A WooCommerce store has little room for more plugins on `post-new.php` today. The local peak is already near the band where writes fail. The older live median is inside that band.

A WordPress-only site has room for several typical plugins (an estimate). That room is the gap from about 81 MiB up to the write failure band.

What does not fit:

- All 18 suite plugins at once. Each of the 18 passes on its own. With all 18 active, the login request answered 1102 (the Worker exceeded its resource limits) at 118 MB of WebAssembly memory ([evidence](../approach-a.md)).
- Rank Math on a WooCommerce store. Requests reach 119 MiB, and every other request answers 503 (#279). #279 measured that on ggc-test on 2026-11-11, with WooCommerce 11.2.1, Rank Math 1.0.280, skyphusion-ai 0.6.2, mcp-adapter 0.7.1 and twentytwentyfive.
- A page builder in the editor. Elementor's editor memory is not measured yet (#758). The block editor already reaches this ceiling (#598).

Yoast SEO (67.94 MiB), All in One SEO (67.53 MiB) and Elementor (83.84 MiB) were over the 64 MiB Worker bundle limit, and SEOPress (63.05 MiB) was over the 62 MiB upload gate. Those figures were measured before remote packs (#279); not re-measured under the default remote packs (#634). Remote packs (SITE_REMOTE) became the default in #595.

#1022 and #1253 are open. #1022 is the memory reset when `post-new.php` runs on a hot isolate. #1253 is the compiled-script set a cold boot opens.

## A killed media upload on approach A (#1039)

On approach A, an upload writes its files and then writes the attachment row. Those are separate steps. If the isolate is killed between them, the files can remain with no attachment, and the file name stays taken.

A killed upload can leave its files for up to one upload or one cron tick after 15 minutes. A partly saved attachment (a row without its sub-sizes) is kept, as WordPress keeps it.

The next media upload, or the cron tick when cron is on, removes a file only when its key is core's dated attachment path (`uploads/YYYY/MM/<file>`, a four-digit year, a month 01-12, and a file name with no further folder) and no attachment names it. A stale marker on any other key under `uploads/` (fonts, WooCommerce downloads and logs, a plugin folder) drops the marker and keeps the file. A database error during that check keeps the file.

## Engineering and operator-only limits

Limits that only an engineer or an operator meets (the WP-CLI operator route, a test-seam write, and the provisioning options) are on [Engineering and operator-only limits](../limits-engineering.md). Each one keeps its issue number and its figures there.
