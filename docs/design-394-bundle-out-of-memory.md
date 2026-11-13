# Design: the site bundle out of isolate memory (pagefeather#394)

Status: DESIGN ONLY. Nothing here is built. Written 2026-11-13 by rollins (seat rollins-sb1114b),
at main `66b849c`. It stops at the lead's gate.

## 0. The problem in one paragraph

On b-dosql, everyday wp-admin work (`/wp-admin/`, `profile.php`, `post-new.php`, a REST page
create) answers 500 `skyphusion_write_loss`, and a quiet store boots a new PHP runtime on most
page views (179 of 200 steady product GETs, p50 3642 ms against about 0.7 to 1.2 s warm). The
cause is isolate memory, not idle time and not the runtime recycle line (pagefeather#394
comments of 2026-11-13). The PHP object holds the site bundle in module memory for the whole life
of the isolate. A probe measured that this bundle costs about 44 MiB of the isolate's memory. This
design takes the bundle out of module memory and fetches only what a request needs.

Product rule (Conrad, 2026-11-13): Pagefeather must look and feel like WordPress. A broken
dashboard is a product defect.

Every number below cites a measurement or a `file:line`. A number with no source is labeled
**unmeasured**.

## 1. Where the bundle lives now, and what each part costs

### 1.1 The seams (`spikes/b2-wordpress/index.js` at `66b849c`)

| seam | line | what it does |
|---|---|---|
| `import siteZip from './build/site.zip'` | 26 | the WordPress tree, a Data module (rule `**/*.zip` in `deploy/wfp/lib.sh:177`) |
| `import opcacheZip from './build/opcache.zip'` | 28 | the OPcache file cache made by `opcache.sh` |
| `import wasmModule from './vendor/php_8_3.wasm'` | 20 | the PHP runtime code |
| `zipEntries(zip)` | 316 to 348 | walks a zip's central directory; `data()` inflates from the in-memory zip (343) |
| `LAZY_CACHE_BYTES` = 8 MiB, `noteInflated`, `evictLazy` | 358 to 377 | caps the inflated copies inside a request, drops all of them after it (3143) |
| `attachLazyContents` | 382 to 412 | the MEMFS `contents` getter: inflate on first read. It is SYNCHRONOUS |
| `lazyFile` | 414 to 417 | one eager MEMFS node per site file |
| `mountLazyZip` (`LAZY_NODES=on`) | 419 to 470, 1133 to 1137 | lazy nodes; OFF for b-dosql today |
| `boot()` file setup | 1115 to 1162 | eager nodes for site.zip (1139 to 1150), opcache.zip entries under `/internal/shared/opcache` (1153 to 1160) |
| OPcache ini | 1101 to 1109 | `memory_consumption` 32, `validate_timestamps` 0, `file_cache_only` 0 |
| `RECYCLE_WASM_BYTES` = 100 MiB | 45, 3153 | drop the runtime when WASM is past it |
| request undo log (#60) | 1736 to 1870 | triggers write the inverse SQL to `_wp_undo`; ROLLBACK replays it |
| `x-perf` fields (`inflates`, `inflateKiB`, `wasm1MiB`) | 3161 to 3175 | the instrument this design extends |

### 1.2 The bytes

| part | size | source |
|---|---|---|
| `site.zip`, deflated | 20,251,516 bytes = 19.31 MiB | `build.sh` at `66b849c`, run 2026-11-13 by rollins (no imports, WooCommerce 11.2.1). Same as the `site update` bundle check on `shed1113a` (19.31 MiB, #394 comment 1) |
| `site.zip`, raw | 69.15 MiB in 6,817 files | same build, read with Python `zipfile` |
| of which `.php` | 45.30 MiB raw, 11.08 MiB deflated | same |
| of which plugin `.js` | 15.52 MiB raw, 4.16 MiB deflated | same. `build.sh:99` keeps them because WooCommerce checks that a block script EXISTS |
| of which WooCommerce | 43.86 MiB raw, 11.23 MiB deflated | same |
| `opcache.zip`, deflated | 21.12 MiB (21.17 MiB in the probe build) | `site update` bundle check on `shed1113a`; dmprobe build of `8b69800` (#394 comments 1 and 6) |
| `opcache.zip` files | 2,131 (a WooCommerce-primed build) | `opcache.sh:12` comment (#313). Not re-measured today |
| `php_8_3.wasm` | 17.23 MiB of code | `site update` bundle check (#394 comment 1) |
| bundle cost in isolate memory | **44 MiB** | data-module probe (#394 comment 6): a lone WASM memory held 188 MiB without the imports, 144 MiB with them, 3 of 3 runs |
| WASM after one render | 99 MiB | `x-perf` `wasm1MiB`, every build on the sample store (#394 comment 3) |
| inflated at a boot | 54,737 KiB (1,722 files) | `x-perf` on `shed1113a` (#394 issue body) |
| inflated on a warm request | about 21.7 MiB | `inflateKiB` 21,698 to 21,848 (#394 comment 1) |
| MEMFS node cost | about 1 KiB each, about 6,800 nodes eager | `index.js:421 to 424` comment (#218). **Not re-measured** |

So between requests the isolate holds WASM 99 MiB plus the bundle about 44 MiB, before any JS
heap. The probe's reset point was 188 MiB for a lone WASM memory (measured once, in one probe;
the Cloudflare page states 128 MB, see section 6). On the real site the per-request JS heap fills
the rest, and the isolate resets after most requests.

## 2. The prefetch manifest design

### 2.1 Shape: three layers, each shippable and measurable alone

- **L0: a trace, no behavior change.** The `contents` getter records the path of each file a
  request reads (site and OPcache), with its size. A spike-token header returns the list. This
  builds the manifest AND answers an open question: WHY a warm request still inflates about 21.7
  MiB when OPcache holds the compiled scripts (`validate_timestamps` 0). If those reads are PHP
  source that OPcache does not need, the fix may be an ini or include-path change, and L2 gets
  much smaller. **Unmeasured**; L0 answers it before L2 is built.
- **L1: `opcache.zip` out of module memory.** Saves up to 21.12 MiB resident.
- **L2: `site.zip` out of module memory, with the per-page prefetch manifest.** Saves up to
  19.31 MiB resident.

L1 has a free miss path (2.5). L2 needs the careful miss path (2.6). So L1 ships first and is
measured; L2 is built only if L1 alone does not meet the success line (section 4).

### 2.2 Where the bytes come from: the Assets binding (R2 is the fallback)

The build cuts the bundle into PACKS: small deflated zips, each under the 25 MiB per file limit.
They are uploaded as static assets of the SAME Worker version, under a private prefix
`/_pf/<build-id>/`. The object reads them with `env.ASSETS.fetch('https://assets.local/_pf/...')`.

Why Assets first:

| | Assets binding | R2 (`MEDIA` bucket, prefix `bundle/<build-id>/`) |
|---|---|---|
| request cost | "Requests to static assets are free and unlimited" (Workers pricing and Static Assets billing pages, read 2026-11-13). A binding fetch from inside a Durable Object is not named on either page: **unmeasured**, read on the bill in step M5 | Class B $0.36 per million; 10 M a month free per ACCOUNT (R2 pricing, read 2026-11-13) |
| storage cost | "no additional cost for storing Assets" (Static Assets billing, read 2026-11-13) | $0.015 per GB-month; about 40 MiB per site per build |
| version skew | none: the packs ARE the Worker version | a deploy step must upload `bundle/<build-id>/` BEFORE the version goes live, and remove old builds after |
| limits | 25 MiB per file; 100,000 files per version on Paid (Workers limits, read 2026-11-13). `build/public` has 3,991 files today (`build.sh` output, 2026-11-13) | none that bind here |
| range reads | none: a Range header gets the whole file (Static Assets billing, read 2026-11-13). Packs avoid the need | yes |
| privacy | packs hold PHP source, including a customer's IMPORTED themes and plugins. They must never be public. On WfP the dispatcher invokes the Worker, and `index.js:2707` never serves a `/_` path from Assets. On a non-WfP deploy, `run_worker_first = ["/_pf/*"]` is required (Static Assets binding page, read 2026-11-13). A stranger test is part of done | private bucket |

R2 is the fallback only if the binding is absent inside the object or is billed.

Open item for the build: `deploy/wfp/lib.sh:179` writes `[assets]` with no `binding` line, but
`index.js:2707` reads `env.ASSETS`, and the binding test fixture names `ASSETS`
(`deploy/wfp/tests/bindings-test.py:24`). ggc.sh serves `/wp-includes/css/dashicons.min.css` as 200
with no `x-php-ms` (curl, 2026-11-13 about 13:31Z), so assets do reach users there. L1 must assert
`env.ASSETS` exists in the OBJECT and fail loud at boot if it does not.

### 2.3 How a request's files are known: build-time manifest, plus a runtime miss path

**Route classes, known before PHP runs** (from the method and URL only):

| class | match |
|---|---|
| `admin:<script>` | `/wp-admin/<script>.php` (dashboard, `post-new`, `post`, `profile`, `edit`, ...) |
| `ajax:<action>` | `/wp-admin/admin-ajax.php` with its `action` |
| `rest:<ns>` | `?rest_route=/<ns>/` or `/wp-json/<ns>/` (`wp/v2`, `wc/store/v1`, ...) |
| `login` | `/wp-login.php` |
| `cron` | the alarm path |
| `front` | everything else: home, shop, product, cart, checkout all enter through `index.php` |

`front` cannot be split before WordPress resolves the query. It is one class.

**Build time:** `opcache.sh` already drives real pages (`e2e.sh`, `tests/woo.py`, the plugin
suite) through one runtime. With L0's trace on, it also writes `build/manifest.json`: for each
class, the paths it read. `build.sh` then cuts packs:
- `core`: files read by EVERY class (the WordPress bootstrap).
- one pack per class: the files that class reads, less `core`.
- `rest-<n>`: every file no class read, in packs under 16 MiB. Every file is in exactly one pack.

Each pack has an `opcache` twin with the `.bin` files of the same scripts (for L1).

**In memory, always:** an index from path to (pack, size). About 6,817 entries; **unmeasured**,
estimated well under 1 MiB. MEMFS nodes keep their size, so `stat()` and `file_exists()` never
fetch. With the index in hand, `LAZY_NODES=on` (#218) also comes for free: it saves the eager
nodes (about 5 MiB by the `index.js:424` comment, not re-measured).

**Per request:** fetch `core` and the class pack before `php.run`, in parallel. Inflate on read,
as today (the getter does not change shape; only its source does).

### 2.4 The cache within an isolate

- Packs are held as their deflated bytes in an LRU capped by `PACK_HOLD_MB`.
- The cap is the whole point: it must stay well under the 44 MiB the probe measured, or nothing is
  saved. The default is set from step M2's numbers: hold `core` plus the last class pack if they
  fit, drop the rest after the request (where `evictLazy` runs today, `index.js:3143`).
- Inflated copies keep today's 8 MiB in-request cap and per-request drop.
- Packs are keyed by build id, so a held pack can never be from another version.

### 2.5 L1: an OPcache miss is free

OPcache loads a script from the file cache only on a cold runtime. With `opcache.zip` out:
- at boot, fetch the `.bin` twins of `core` and the class, before the first render;
- release them after that request, since OPcache shared memory (in WASM) now holds the scripts;
- a later include of a script with no `.bin` present COMPILES it from source. That is OPcache's
  normal path: correct, it only costs CPU on that one request.

So L1 cannot fail a page. Its only risk is CPU, measured as `opMisses` and `phpMs` in M3.

### 2.6 L2: a site file miss must never fail a page or lose a write

The `contents` getter is synchronous (`index.js:391 to 397`). It cannot await a fetch. So a miss
is handled by STOPPING the run and running it again, and the design makes the re-run safe:

1. **On a miss**, the getter records the path and throws an Emscripten `ErrnoError(EIO)`. PHP sees
   a read failure. The request is marked `missed`. **Unmeasured:** that php-wasm returns cleanly
   (not a crashed runtime) on EIO from a read. L0 tests it; if it crashes, the runtime is dropped,
   as for any crash today (`index.js:3147`).
2. **Before any side effect** (no SQL write, no outbound op, no media put; the object already
   counts all three: `rowsWritten`, `httpCalls`, R2 ops in `stats`): discard PHP's output, fetch the
   missing file's pack, run the request again. Safe: nothing was changed.
3. **After a SQL write:** every request of a WRITING class (any non-GET, any `admin:*`, `ajax:*`,
   `login`, `cron`, and `rest:*` with a non-GET method) runs inside a request-level undo frame,
   the same `_wp_undo` triggers #60 uses (`index.js:1736 to 1870`). On a miss: roll the frame
   back, drop the request's held mail (as #368 already does), fetch, re-run. A `GET /wp-admin/`
   writes an auto-draft (`INSERT wp_posts`, #394 comment 5), so admin GETs ARE writing requests.
4. **After an op that cannot be undone** (an outbound non-GET HTTP call, a media put, a sent
   mail): do not re-run. Answer the existing honest 500 (`write-loss.mjs`, `x-write-loss`), and
   log `{"m":"pack-miss-unsafe", "class", "path"}`. The success line requires 0 of these on the
   measured pages.
5. **Learning:** every miss is written to the object's SQLite as (build id, class, path). The next
   request of that class also fetches the pack that holds it. This survives an isolate reset.
   A build-time manifest gap therefore costs at most one re-run per class per build.

An admin who activates a plugin not in the manifest gets misses on that plugin's first pages,
then learns. Every file is in some pack, so a miss is always servable.

### 2.7 What changes in the build and deploy

- `build.sh`: cut packs from `manifest.json`; write the path index as a small Data module.
- `opcache.sh`: trace on during priming; write `manifest.json`; split `opcache.zip` into twins.
- `deploy/wfp/lib.sh`: put the packs in `build/public/_pf/<build-id>/`; add `binding = "ASSETS"` if
  the open item in 2.2 says it is missing. `deploy/deploy.sh`: `run_worker_first = ["/_pf/*"]`.
- The Worker size drops by about 40 MiB, from 57.95 MiB of the 64 MiB limit (#394 comment 1).
  That also gives room for imported plugins.

## 3. The other options, weighed

| option | what it would change | measured evidence | verdict |
|---|---|---|---|
| A. Higher recycle line | the runtime recycle at 100 MiB | 0 recycles in 75 requests on main; WASM 99 MiB, under the line (#394 comment 3) | **Loses.** It changes nothing the reset depends on |
| B. A lower peak per render | WASM high-water | 16 MiB OPcache made it WORSE: 115 MiB, 75 of 75 recycled, 74 of 75 boots (#394 comment 3). To give back 44 MiB, WASM must fall from 99 to about 55 MiB with 32 MiB of OPcache inside it: no lever is known that does this (**unmeasured**) | **Loses** as the main fix. Fewer plugins on a page is a per-site choice, against the product rule |
| C. Keep inflated files across a recycle | re-inflation per request | Build 1 (`evictLazy` off): 68 of 75 boots, worse than main's 51 (#394 comment 3). Also, the event is an ISOLATE reset: nothing in memory survives it | **Loses.** It ADDS resident memory |
| D. OPcache only out (L1 alone) | 21.12 MiB resident | gives back about half the 44 MiB. Whether that is enough is **unmeasured**: the stable stretches on main (1 to 4 isolates for 15 requests at a 10 s gap, #394 comment 3) suggest the site is near the line, and admin pages carry a bigger JS heap (**unmeasured**) | **First step, not the whole fix.** 1 to 2 days, a free miss path. Ship it, measure, decide on L2 |
| E. Async file layer (JSPI or asyncify php-wasm) | a miss can await | none measured; a different runtime build; whether workerd runs JSPI is **unmeasured** | **Loses** for now: 2 weeks or more, and it changes the runtime under every page |
| F. Approach A for stores this size | PHP in the Worker, MySQL by Hyperdrive | the chosen scale path (#296); 6.02 to 6.70 rps at 50 concurrent (`docs/results.md:181 to 182`, 2026-11-09) | **Not a fix for b-dosql.** b-dosql stays the low and moderate tier and still needs a working dashboard |
| G. Keep-warm alarm | idle | D build: 52 of 75 boots, no change (#394 comment 3) | **Loses.** Idle is not the cause |
| **H. L1, then L2 (this design)** | 44 MiB resident, the size of the gap | the probe (#394 comment 6) | **Recommended.** About 1.5 weeks with measurement |

## 4. Measurement plan

### 4.1 What I do without a site (local, `wrangler dev`, priming as `opcache.sh` does)

- **M0 (L0 trace):** the file list per class; warm vs boot reads; why warm requests inflate about
  21.7 MiB; whether EIO from the getter crashes php-wasm. Half a day.

### 4.2 The site I need (the lead creates it and removes it)

- One throwaway b-dosql site on the WfP namespace, `workers.dev` only, named by the lead (for
  example `bom1114a`).
- The SAMPLE store imported first (2,609 products; `wpref-mysql` database `wordpress`, or the R2
  fixture when it lands), WooCommerce active. Never an empty site.
- Turnstile as on `tsv1113w` (the #396 build), so admin logins keep their session.
- Workers Logs on for that site (the reset line is visible only there).
- An admin login handed to me by the lead's normal route, and the spike token.
- The lead deploys each build I name: baseline main, L1, then L1 plus L2.

### 4.3 Page types and requests

| page type | request | n per build |
|---|---|---|
| home | `GET /` with `?nocache=` | 10 back-to-back |
| shop | `GET /?post_type=product` (NOT `/?page_id=5`, which 302s to an edge-cached answer, #394 comment 1) | 10 |
| product | `GET` a product, gap table 0, 2, 10 s | 15 per gap |
| cart | add to cart, then `GET` cart | 10 |
| checkout | `GET` checkout, then one order on a test gateway | 5 orders |
| wp-admin | `GET /wp-admin/` | 10 |
| post-new | `GET /wp-admin/post-new.php?post_type=page` | 10 |
| profile | `GET` then `POST /wp-admin/profile.php` | 10 |
| REST page | `POST /?rest_route=/wp/v2/pages` | 10, each checked in the database after |

Plus the 180 s crawl at 1 request a second (as #394 comment 1) and one burst (as #391).

### 4.4 Metrics, and the line each must cross

| metric | instrument | baseline (main) | success line |
|---|---|---|---|
| boot share | `x-boot`, `x-perf` `boot` | 51 of 75 (68%) on the gap script (#394 comment 3) | under 10% on every page type |
| isolate resets | Workers Logs "exceeded its memory limit and was reset" lines | 8 in 4.5 min on `tsv1113w` (#394 comment 5) | 0 in the steady runs |
| write-loss | `x-write-loss`, Workers Logs | 12 rows in 7.5 min on admin pages (#394 comment 5) | 0, and every REST create's state matches its answer |
| WASM after render | `x-perf` `wasm1MiB` | 99 MiB | no higher than 99 MiB |
| client p50 / p99 | client timing | product 3.6 / 4.8 s quiet (#394 comment 1) | warm render p50 about 1.2 s (measured warm, #394 comment 1) |
| pack fetches | NEW `x-perf` `packN`, `packKiB`, `packMs` | n/a | reported per request |
| misses | NEW `x-perf` `miss`, `missUnsafe` | n/a | `missUnsafe` 0 |
| OPcache misses (L1) | `opHits`, `opMisses` | from M0 | CPU per request within 10% of baseline warm |

- **M1:** baseline main on the throwaway (the numbers above are from other throwaways; re-measure,
  never relay).
- **M2:** L1 build. If boots under 10% and 0 resets: stop, L2 is not needed.
- **M3:** L1 plus L2 build.
- **M4:** removal check: a stranger `GET /_pf/<build-id>/core.zip` answers 404 (and the same on a
  non-WfP deploy).
- **M5:** cost reading: R2 Class B count (if R2 is used) or the Workers request count, from account
  GraphQL, for the M3 window.

## 5. Risks

### 5.1 Request cost per page view (fund forward)

Fetches per page view: 2 packs (core and class) when not held, plus at most one per miss. With
`PACK_HOLD_MB` holding `core`, 1.

| case | Assets binding | R2 |
|---|---|---|
| at rest (a quiet store, 10,000 views a month) | $0 if binding fetches are free (doc: static asset requests are free; binding from a DO **unmeasured**) | 20,000 Class B a month, inside the 10 M free tier: $0 |
| one busy store, 1 M views a month | $0 (same caveat) | 2 M Class B: $0 if the account's other use leaves room in the free 10 M, else $0.72 |
| 100 sites at 1 M views each in one account | $0 (same caveat) | 200 M Class B, less 10 M free = 190 M x $0.36 = **$68.40 a month** |

The free tier is per account, not per site: on WfP every site shares it. This is why Assets is
first.

### 5.2 Cold fetch latency

An Assets or R2 read from inside the object: **unmeasured**. A boot already costs about 2.5 s more
than a warm render (#394 issue body), so a few tens of ms at boot is small; on a WARM request it
is pure added time. M3 reports `packMs`. If a warm request pays more than 50 ms, raise
`PACK_HOLD_MB` within the headroom M3 shows.

### 5.3 The isolate memory reset class

- The Workers limits page (read 2026-11-13) states 128 MB per isolate, "including the JavaScript
  heap and WebAssembly allocations", and that the runtime "lets in-flight requests complete and
  creates a new isolate for subsequent requests". That matches what we see (resets between
  requests, no http `exceededMemory` in GraphQL).
- The probe saw a lone WASM memory reset near 188 MiB, not 128 MB. Measured once, in one probe,
  undocumented. The design does NOT depend on that number; it depends on the DIFFERENCE the
  bundle makes (44 MiB, 3 of 3 runs).
- If an admin page's JS heap alone exceeds the room this gives back, resets continue on that page.
  M3 measures every admin page type separately.
- A reset in the middle of a request still loses writes; `write-loss.mjs` (#350, #353) keeps
  answering it honestly. This design removes the pressure, not that guard.
- Related: #335 and #350 (503 on the first request of a fresh runtime) should fall with fewer
  boots. Not claimed until M3 measures it.

### 5.4 Other risks

- **The re-run (2.6):** a re-run after an undo must leave the database exactly as before. Test:
  a forced miss on each writing class, then compare a table hash before and after.
- **Privacy:** packs hold PHP source, including a customer's own code. M4 is part of done.
- **Version skew:** none with Assets. With R2, a deploy that skips the upload makes every request
  miss: fail the deploy, not the page.
- **The manifest drifts** from the real pages (a new plugin, a new admin screen): handled by
  learning (2.6 step 5); visible as the `miss` rate.

## 6. Cloudflare pages read (all on 2026-11-13)

- Workers limits, https://developers.cloudflare.com/workers/platform/limits/ (page dated Nov 13, 2026):
  memory 128 MB per isolate; Worker size 64 MiB; static asset files 100,000 per version on Paid;
  25 MiB per asset file.
- Workers pricing, https://developers.cloudflare.com/workers/platform/pricing/ (Nov 13, 2026):
  static asset requests are free and unlimited.
- Static Assets billing and limitations,
  https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/ (Nov 12, 2026):
  free requests, no storage cost, no range requests.
- Static Assets binding, https://developers.cloudflare.com/workers/static-assets/binding/
  (Nov 12, 2026): `env.ASSETS.fetch` with any hostname; `run_worker_first` as an array.
- R2 pricing, https://developers.cloudflare.com/r2/pricing/ (Oct 30, 2026): Class B $0.36 per
  million, 10 million a month free, storage $0.015 per GB-month.
- Durable Objects limits, https://developers.cloudflare.com/durable-objects/platform/limits/
  (Nov 13, 2026): states no memory figure of its own; the Workers memory limit applies.

## 7. Estimate

- M0 (L0 trace, local): half a day.
- L1 plus M1, M2: 2 days.
- L2 plus M3 to M5: about 1 week.
- Parked, not in this design: the plugin `.js` files (4.16 MiB deflated) may need only their SIZE,
  not their bytes (`build.sh:99`); if M0 shows their contents are never read, they can be stubs.
