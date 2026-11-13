# Admin memory: where it goes, and what can move out (#434, for #394)

**Status: measured on 2026-11-13; this is a design for the lead's ruling. Nothing here is built.** Throwaway site pf422a (the WooCommerce sample store, 2,609 products, WooCommerce primed, OPcache 48). Instrument: `php/mem-trace.php`, read by `tests/wfp/admin-mem.py` (#435, #438, #439, #440). Each request runs on a fresh runtime (`/_evict` first). Every number below is a median of 3. A `woo` switch row is that same page with one component switched off for one request.

## The passes

| Pass | Build | Allocator | Window (UTC, 2026-11-13) | What it gives |
| --- | --- | --- | --- | --- |
| A | `8248bec` | system malloc (`USE_ZEND_ALLOC=0`, production) | 16:26:29 to 16:38:34 | the WASM heap at each mark, and the switches |
| front | `8248bec` | production | 16:39:12 to 16:43:41 | 210 warm front requests, one runtime |
| B | `9bd4053` | production | 16:52:26 to 17:07:45 | each editor preload route, and the footer marks |
| Z | `cfa6bcd` | Zend (`USE_ZEND_ALLOC=1`) | 17:56:04 to 18:14:38 | PHP's own memory at each mark (`memory_get_usage`) |

Zend's allocator changes how WASM grows, so pass Z's numbers are compared only within pass Z.

## Finding 1: the big WASM steps are the allocator's 20 % over-growth, not a component's cost

On the production build, the heap reads only 76.7, 92.1, 110.5 and 132.6 MiB. Each value is exactly **1.2 times** the one before it. The PHP runtime's loader (`@php-wasm/web-8-3` 3.1.62, `jspi/php_8_3.js`, `_emscripten_resize_heap`) grows the heap to `max(requested, old * 1.2)`. When the next allocation does not fit, the heap grows by a fifth of its size, however small the allocation.

So in passes A and B, a step at a mark (for example +22.1 MiB at the editor's REST index) shows **where the heap crossed a line**. It does not show what that component costs. A page that needs 111 MiB is given 132.6 MiB. A page that ends at 132.6 MiB is the one that resets for memory (post-new, #394).

## Finding 2: PHP's own memory on an admin page is 22 to 29 MiB, and WooCommerce is most of it

Pass Z (Zend), PHP's peak by page:

| Page | With WooCommerce | WooCommerce switched off |
| --- | --- | --- |
| dashboard | 29.2 MiB | 8.7 MiB |
| profile | 28.8 MiB (1 of 3 answered) | 8.7 MiB |
| post-new | 23.9 MiB (1 run, a trace cut at `screen`) | 13.8 MiB |
| wc-settings | 23.0 MiB | n/a |
| orders | 26.0 MiB | n/a |
| plugin install (REST) | no answer | 7.5 MiB |

So of the production heap of 111 MiB on the dashboard, about 29 MiB is PHP's own request memory. The rest is the 76.7 MiB floor (next finding) plus the allocator's over-growth.

**Where WooCommerce's 20.5 MiB goes on the dashboard** (Zend usage between marks, with WooCommerce against without):

| Stretch | With | Without | WooCommerce's share |
| --- | --- | --- | --- |
| plugin files included | +3.0 | +0.4 | +2.6 |
| `init` (WooCommerce init, wc-admin features) | +6.5 | +0.8 | +5.7 |
| `wp_loaded` to `admin_init` (admin includes, menus) | +6.8 | +0.5 | +6.3 |
| `admin_init` | +2.0 | +0.2 | +1.8 |
| head scripts | +2.7 | +2.0 | +0.7 |
| footer scripts | +2.0 | 0 | +2.0 |

**The editor preload, without WooCommerce** (post-new, pass Z):
- the REST server start (`rest_api_init`): +1.2 MiB;
- the REST index `/` (one preload path): **+3.5 MiB**, the largest single route;
- all preload routes together: +6.5 MiB.

With WooCommerce, the REST server registers its routes too, and `/` lists them all. The with-WooCommerce figure was not captured: post-new reset before its trace returned in every pass Z run with no switch. The lead's log join by request id (#440) can supply it.

## Finding 3: the floor is 76.7 MiB before any plugin loads

At the first mu-plugin, every page is at 76.7 MiB of WASM: the PHP runtime, OPcache's 48 MiB of shared memory, and core. With WooCommerce off, the dashboard, profile and install request end there (77 MiB). This is Rollins's lane (L1, L2, OPcache sizing), and it is the largest single block.

## Finding 4: the small switches are small

PHP peak saved, pass Z: `wcadmin` and `wcfeatures` 0.6 to 1.1 MiB; update checks 0.2 to 0.4; admin notices 0.1; translations 0 (the site is `en_US`). The dashboard widgets made no visible change in passes A and B. The 95 wc-admin files that wp-login loads (98 on the front) cost about 1 MiB of PHP memory by the `wcfeatures` switch. They are worth removing for tidiness, not for memory.

## Ranked: MiB saved per day of work

Each item says whether it also works on the Hyperdrive path (approach `a`, PHP in the Worker). Both paths run the same php-wasm runtime and the same WordPress, so all of these do.

| Rank | Change | Saving | Measured how | Work | Path `a` | Lane |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **Grow the heap to need, not by 20 %.** Patch `_emscripten_resize_heap` in `prepare.sh` (which already patches this loader) to grow to the request plus a small slack | **Up to one step at the top: 18.4 MiB on the dashboard, 22.1 MiB on post-new.** This is the step that turns a 111 MiB page into 132.6 and a reset | The 1.2 ratio is measured on every step, and the code reads it. **The saving on a patched build is unmeasured**: the bound is one sixth of the high-water | about half a day, plus one pass | yes, the same loader | Rollins (runtime loader) |
| 2 | **Load WooCommerce only on the screens that need it** (filter `option_active_plugins` per admin screen; the `woo` switch is the prototype) | **20.5 MiB of PHP memory** on the dashboard and profile (Zend), and 34 MiB of WASM on the production build | `woo` switch, passes A, B and Z | 2 to 4 days, mostly compatibility: WooCommerce adds dashboard widgets, admin bar items and editor blocks, so post-new and the store screens keep it | yes | Joan (PHP side) |
| 3 | **Take the REST index `/` out of the editor preload, or answer it from a cache** (the `rest-route-cache` pattern, #53) | **3.5 MiB** of PHP without WooCommerce, more with its routes. It is also where post-new crosses into its last 22.1 MiB step | pass Z marks (without WooCommerce); passes A and B (the crossing) | about half a day | yes | Joan |
| 4 | **Serve the whole preload from the Worker** (the answers depend on the user and the content version) | the preload's +6.5 MiB without WooCommerce, more with | pass Z | 2 to 3 days | yes | Joan |
| 5 | wc-admin code on wp-login and the front | about 1 MiB | `wcfeatures` switch | half a day | yes | Joan |
| no | update checks, admin notices, translations, dashboard widgets | 0 to 0.4 MiB | switches | n/a | n/a | not worth it |

**Rank 3, built (2026-11-13, #394):** `spikes/b2-wordpress/php/rest-index-lean.php`. Core's `get_index()` builds the whole route list before the editor's `_fields` drops it; for that request the plugin hands it an empty endpoint list, for that one callback only. Measured on a real WordPress 7.1.4 on SQLite (`spikes/b2-wordpress/tests/rest-index-lean/run.sh`), PHP peak of the one preload call: plain 1,149 KiB to 359 KiB; with WooCommerce and the tier 1 stack 8,787 KiB to 4,571 KiB. The live WASM effect on post-new is measured on pf394a.

**Recommended order:** rank 1 first. It is the cheapest, and it changes every other number: once the heap grows to need, a saving in PHP is a saving in WASM byte for byte, rather than only when it lands under a 20 % line. Then rank 3 (cheap), then rank 2.

## Open

- **Pass Z's 500s with no reset header: answered** (the lead's log pull, [#394 comment](https://github.com/skyphusion-labs/pagefeather/issues/394#issuecomment-6861287266), 2026-11-13). They are `RangeError: Invalid array buffer length`, thrown inside the WASM stack, on 53 distinct requests: `edit.php` 18, profile 16, dashboard 12, post-new 3, `/` 3. The next heap step's ArrayBuffer could not be allocated, so PHP died and the isolate was not reset. 3 more requests hit a platform "Internal error in Durable Object storage caused object to be reset" (post-new among them). Counts for the window by `m`: req 69, boot 176, isolate-reset 19, write-loss 28, memory-exceeded requests 75. This is Zend's allocator reaching the same wall sooner. Pass Z is an attribution instrument only, and Zend's allocator is not proposed for production.
- **The 92 to 111 MiB front jump** (Rollins, pf394a) was not seen. 210 warm front requests stayed at 92. One isolate memory reset was logged, after 77 requests served at 92 MiB, between requests, followed by 5 single-request runtimes.
- **WooCommerce's share of the editor preload: not measured.** The post-new no-switch traces died before the preload marks, so the log join had nothing to join (the lead, same comment). It needs a run in which post-new with WooCommerce survives its preload, for example after rank 1.
