# Support matrix

This page says what works on each tier and each deploy path, what is limited, and why. Conrad asked for it in #759: "document things that are limited and why".

**State on 2026-11-16, main `345cef4`.** The conformance runs of #759 will fill in the cells that say "not measured". They run the upstream WordPress, WooCommerce and Gutenberg suites, plus a stock baseline (`tests/conformance/`).

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
| Install, pages, login, dashboard | yes (#638) | yes ([results.md](results.md) 2026-11-07, `cochk4`); limited: the first page after a fresh install (#756) | limited: the first page after a fresh install (#756) | yes ([results.md](results.md) 2026-11-05, `e2e.sh` 17 of 17) |
| The block editor | yes, plain WordPress (#638); limited on a store (#638) | limited: memory ceiling (#768) | limited: memory ceiling (#768) | not measured |
| REST API | limited: fresh installs (#760) | limited: fresh installs (#760) | limited: fresh installs (#760) | not measured |
| Application passwords and HTTP Basic | yes in code (#762); live run pending | yes in code (#762); live run pending | yes in code (#762); live run pending | not measured |
| Permalinks | limited: plain on a fresh install (#760), soft 404 (#772) | limited: (#760), (#772) | limited: (#760), (#772) | not measured |
| Cron | not measured | not measured | not measured | not measured |
| Mail | not measured | not measured | not measured | not measured |
| Media uploads | not measured | yes without WooCommerce ([results.md](results.md) 2026-11-07 and 11-08: R2 and Cloudflare Images); with WooCommerce not measured | not measured | not measured |
| Search | not measured; semantic search limited (opt-in, plugin change) | the same | the same | not measured |
| Comments | not measured | not measured | not measured | not measured |
| Multisite | not measured | not measured | not measured | not measured |
| Installing plugins and themes from wp-admin | no, by design ([why](#plugins-and-themes-are-not-installed-from-wp-admin-by-design)) | no, by design | no, by design | no, by design |

## WooCommerce

| feature | Free DO | Paid DO | WfP | Hyperdrive |
|---|---|---|---|---|
| Catalog: shop and product pages | yes (#638); limited: false 404 (#766; fix in PR #770, open) | yes ([results.md](results.md) 2026-11-07, `cochk4`); limited: false 404 (#766; fix in PR #770, open) | limited: false 404 (#766; fix in PR #770, open); stock on cached pages (#628) | yes ([results.md](results.md) 2026-11-09, `wp-a-lean` 12 of 12) |
| Cart and checkout | yes (#638) | yes ([results.md](results.md) 2026-11-08, `woocap`; the flaky failure fixed in #208) | yes (#704, `pf704`: `load.py` checkouts placed orders) | yes ([results.md](results.md) 2026-11-09, three runs of 12 of 12) |
| Editing the store in wp-admin | no: memory (#638) | not measured | not measured | not measured |
| Payments | not measured | cash on delivery: yes ([results.md](results.md) 2026-11-07, `cochk4`); other gateways not measured | not measured | not measured |
| Orders and HPOS | not measured | orders placed: yes (checkout rows above); HPOS not measured | the same | orders screen: yes ([results.md](results.md) 2026-11-09); HPOS not measured |
| Stock | not measured | yes: checkout lowers stock ([results.md](results.md) 2026-11-07); limited on cached pages (#628) | limited on cached pages (#628) | yes: checkout lowers stock ([results.md](results.md) 2026-11-09) |
| Coupons | not measured | not measured | not measured | not measured |
| Tax | not measured | not measured | not measured | not measured |
| Emails | not measured | not measured | not measured | not measured |
| PDF invoices | limited by deploy path (#765) | limited by deploy path (#765) | limited by deploy path (#765) | not measured |
| REST API keys in the Basic header | yes in code (#762); live run pending | yes in code (#762); live run pending | yes in code (#762); live run pending | not measured |

## The deploy paths

| feature | `deploy/deploy.sh` | `deploy/wfp` | one-click |
|---|---|---|---|
| PDF invoices | no: no `BROWSER` binding (#765; PR #769 is open) | no: no `BROWSER` binding (#765; PR #769 is open) | yes (#765) |
| Update a site | yes: `CODE_ONLY=1` in `.github/workflows/deploy-workers.yml` (the live sites `woocap`, `zarapo`) | yes: `deploy/wfp/site update` (#642; the #724 throwaways, 2026-11-16; ggc.sh) | no: add only (#765; an issue for it is being filed) |
| Remove a site | not measured (`deploy/destroy.sh`) | yes: `deploy/wfp/site remove` (`pf704`, #704; the #724 throwaways) | no: add only (#765) |

## Limited, and why

### The first page after a fresh install can fail (#756)

This was measured on b-dosql with the npm engine, on 2026-11-16. Five of 5 deploys ran `/_install`, and then the first page died with `exceededMemory`. A fresh install boots a new PHP runtime on purpose, and the old one is still held at that moment.

Live sites do not update that way. They update with a code-only deploy (`CODE_ONLY=1`), with no install. On the lean engine (`pf724l0`, 2026-11-16), all 9 first pages after code-only updates answered 200. The one failure there was the `/_install` request itself. Its logs are being re-run.

So this may be a fresh-install defect only. Whether a code-only update fails is still being measured. #756 is open.

### The block editor reaches the memory ceiling (#768)

A b-dosql site has one PHP object, and that object has a memory ceiling. `post-new.php` alone takes it from about 65 MiB at boot to a median of 118 MiB. That is the write ceiling. It was measured on b-dosql in the #724 runs on 2026-11-16, on the sample store. About 1 in 5 admin requests answers 500, even on the lean engine with reuse off. Memory reuse cannot help, because the page reaches the ceiling within one request. #768 is open, to find and cut the page's own peak.

On Workers Free, a WooCommerce store's editor does not fit the memory limit (#638). Use Workers Paid to edit a store.

### Fresh installs keep plain permalinks (#760, #772)

Our HTTP bridge refuses the installer's loopback probe, so a fresh install keeps plain permalinks. Then `/wp-json/` and every unknown path answer the home page with 200. Stock WordPress with working rewrites chooses pretty permalinks.

- **The workaround today:** set a permalink structure in Settings, or call REST as `/?rest_route=/`.
- **The fix:** PR #773 is open.
- **#772:** under a plain structure, an unknown path still answers 200 and not 404. It is a soft 404, and stock WordPress on Apache answers 404. #772 is open.

### HTTP Basic auth was broken, now fixed in code (#761, #762)

Before #762, PHP never received `PHP_AUTH_USER` and `PHP_AUTH_PW`. So application passwords and WooCommerce REST keys in the `Authorization: Basic` header failed. The lead confirmed it live on 2026-11-16. #762 maps the header and is merged. A live run on a site built from main is still pending, so the cells say "yes in code".

### Guests can get 404 for products that exist (#766)

After a SQL failure at the memory ceiling, a later guest can get 404 for a real product. No header or log marks it. It was measured on b-dosql in the #724 runs on 2026-11-16. In one arm, 15 of 15 false 404s came within 3 s of a memory failure. The likely cause is a failed request that still writes the object cache. PR #770 is open.

### A cached product page can show an old stock number (#628)

A logged-out product page comes from the edge cache. A checkout that lowers stock does not clear that copy. A store caches its product, shop and category pages for 30 s by default (`PAGE_CACHE_PRODUCT_TTL`). So the number is at most about 30 s old. Checkout always reads the real stock, so it never sells more than the store has. When a product sells out, the page is cleared. See the README.

### PDF invoices work on one-click only (#765)

The feature needs the `BROWSER` binding. `deploy/wfp` and `deploy.sh` render none, so only one-click sites can make invoices. PR #769 is open: it adds `PDF_INVOICE=on` to both paths.

### One-click can add a site, not update or remove it (#765)

The one-click CLI implements only `site add`. Its `update` and `remove` refuse, and they name `deploy/wfp/site`, which cannot manage a one-click site. An issue for it is being filed.

### Semantic search needs a plugin change

The `vectorize-search` descriptor is opt-in. The search engine is the skyphusion-ai plugin, which needs a change (skyphusion-ai#193). See [known-limitations.md](known-limitations.md).

### Plugins and themes are not installed from wp-admin (by design)

WordPress, its plugins and its themes run from the Worker's code bundle. The bundle is read-only at run time: a site has no writable disk to install into. So plugins and themes ship in the build, pinned by content hash, and a change is a code deploy (#458).

To make that plain in wp-admin, every site is code-locked. `wp-config.php` sets `DISALLOW_FILE_MODS` and `DISALLOW_FILE_EDIT`, so the install, update and editor screens are off. See [from-lamp-to-wfp.md](from-lamp-to-wfp.md).

## Not measured, and what will measure it

The conformance runs (#759) cover most of the "not measured" cells. They run the upstream WordPress and Gutenberg browser suites, WooCommerce's core browser profile, and the API half. Each runs on a throwaway, with and without the page cache. Each is compared with stock WordPress at the same versions. Where no upstream test covers a cell (multisite, cron, mail), it stays "not measured" until we write our own test.
