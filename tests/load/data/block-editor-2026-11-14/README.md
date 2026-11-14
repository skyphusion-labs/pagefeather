# Block editor in a real browser: HostlessWP against pagefeather b-dosql (2026-11-14)

The raw data of the block editor round on #394. It holds names, numbers, statuses and headers only: no host, no cookie, no nonce, no credential and no response body. Everything is plain text: the repo's dash check reads every tracked file, and a gzip file can match it by chance (it did, on this PR).

## What ran

- **Client:** one headless Chromium 156 (Playwright 1.64.1), sequential, on Conrad's laptop.
- **Steps per iteration (14):**
  - for a post: open post-new, type a title and a paragraph, Publish, reload and verify;
  - for the store's existing published post: open, append a paragraph, Save, reload and verify;
  - then the same 7 steps for a page.
- **Verify:** a step passes only when BOTH the reloaded editor AND a REST read (`context=edit`) hold the text. A 200 alone never passes.
- **Retries:** a failed step gets ONE user-style retry. The row keeps `ok=0` and adds `retry_ok`.
- **Chains:** a step not passed even after its retry stops its own chain (post or page); the other chain still runs. An iteration is complete only when all 14 steps passed on the first try.
- **Setup:** a block editor check: `body.block-editor-page`, the `wp.blocks` count, classic-editor not active. Up to 3 attempts. Anything except a clean first attempt counts as a failure of step 1.

## The two sites

| site | build | data | cron |
|---|---|---|---|
| **HostlessWP** `hwpbe1114` | v0.1.1 at `739e8e7`, its own CLI. PHP in the Worker on Paid, placement aws:us-west-2. Precompile SKIPPED (Node 26), as for hwp504. Local CLI TLS patch only (`tools/hostlesswp-739e8e7-tls-local.diff`); the runtime as shipped | pf394a's rows, copied by the #479 M3 export into MySQL on `wpref-mysql` (`tools/copy-run.sh`): 52 tables, 99,128 rows, 0 count differences | Cron Trigger cleared to `[]` |
| **pagefeather b-dosql** `pf394a` | round 1: main `e2d8cad`; rounds 2 to 4: main `437599e` (the #578 fix, #579 and #580). LAZY_ARENA off, LAZY_CACHE_MB 2, MEM_LEDGER on, WOO | its own store | `/_hold` held for the whole run, released at the end |

Both sites have WordPress 7.1, twentytwentyfive, and WooCommerce as the only plugin. The block editor was active on both: 270 block types, classic-editor absent (`setup-*.json`). The store has 1 published post (id 1) and the first non-shop page (`sample-page`, id 2); both rounds used them as the existing items.

**Not equal, and not equalised:** WooCommerce's Action Scheduler async loopback on admin requests. pagefeather turns it off (`action-scheduler-alarm-only.php`); HostlessWP ships it. It runs on the server and the browser cannot see it.

## Rounds and driver versions

| dir | when (UTC) | sites | driver sha256 (prefix) | what it is |
|---|---|---|---|---|
| `round0a-1817Z-loginfix` | 18:17 to 18:23 | both | `44e32cf0e444` | stopped: the driver clicked Log In before pf's Turnstile test widget filled its token (about 3.2 s) |
| `round0b-1825Z-pf-first-sight` | 18:25 to 18:30 | both | `0a1f87080040` | stopped: pf post-new.php 500 with `x-isolate-reset: memory`, `x-write-loss: 1` (cf-ray `a5a80fb37e9b90b3-ORD`); on the retry the HTML and scripts answered 200 but the canvas never became usable in 120 s |
| `round1-hwp-full-pf-578-wall` | 18:32 to 20:09 | both, interleaved | `46a6362b96ba` | **the HostlessWP column**, and pf failing before the editor loads (#578) |
| `round2-pf-437599e-setupbug` | 20:09 to 20:20 | pf | `46a6362b96ba` | pf after #579: the editor LOADED on a retry (11 REST calls, all 200), but the driver then skipped pf (a driver bug, fixed below) |
| `round3-pf-437599e` | 20:26 to 22:09, cleanup 22:31 | pf | `384c1afdb7ac`, cleanup `1b494f571ada` | **the pf column past the #578 wall** |
| `round4-hwp-spot` | 22:09 to 22:30 | HostlessWP, 2 iterations | `384c1afdb7ac` | HostlessWP on the same driver as round 3 |

Driver changes after `46a6362b96ba` (in `tools/be-run.mjs`; the round 1 version is `tools/be-run-46a6362b96ba.mjs`):
1. A step that passes on its one retry lets its chain go on. It still counts as failed.
2. Cleanup uses plain `fetch` with a REST nonce from admin-ajax, so it works on a page whose JavaScript did not boot. A DELETE that answers 404 counts as already gone.
3. Modals (the welcome guide and the block theme's "Choose a pattern" on a new page) are closed after each editor load and before each Publish or Save. **This adds up to about 2 s to each load step in rounds 3 and 4.**

Round 4 shows the timings did not move: HostlessWP loads p50 50.7 to 53.2 s, against 51.7 to 53.6 s in round 1.

## Files

- `steps.csv`: one row per step: ok, ms, verified, fail_reason, the visible editor error, failing_call (the first 5xx or no-answer in the step), retry_ok, php_calls, php_5xx, aborted.
- `requests.csv`: every same-origin http(s) PHP request (kind html, rest or ajax). Columns: method, kind (html, rest, ajax, static), path, rest_route (ids as `<id>`), query KEYS only, status or NO-ANSWER plus the failure text, ms, and the headers `x-perf`, `x-hostlesswp`, `x-hostlesswp-cache`, `x-isolate-reset`, `x-isolate-retry`, `x-write-loss`, `x-runtime-recycled`, `x-wasm-mib`, `x-boot`, `cf-ray`. Each header is capped at 300 characters.
- `static-summary.csv`: the static-asset requests (theme, plugin and core files), one row per platform, iteration and step: the count, the count by status (200, 304, 404, other, no answer), and the no-answer count by failure (for example `net::ERR_QUIC_PROTOCOL_ERROR`). The per-request static rows (98,283 in all) were dropped to keep the data small. Their counts are kept here.
- `events.csv` (rounds 1 to 4): browser console errors and warnings and `pageerror`, with the origin and nonces removed.
- `round3-pf-437599e/cleanup-pf.json`: what the cleanup found before deleting: the tagged items that existed, and our markers inside the existing post and page.
- `tools/summary.py <round dir>`: the per-step table. p50 and p95 are nearest-rank over first-try passes only.

Cleanup: every item the run created was hard-deleted (tag `sb1114e-be-`). The existing post and page got their content back, read back equal. Our revisions on those two stay: 20 on HostlessWP in round 1, 25 after round 4; 6 on pf after round 3.
