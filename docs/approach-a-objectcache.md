# Approach A: a write-aware object cache to cut SQL round-trips

> **Status: current design for approach A.** The measured results are in [results.md](results.md) (rows `A (approach-A object cache, live)` and `A (approach-A object cache L2/KV)`, 2026-11-08). Product story: [approach-a-overview.md](approach-a-overview.md).

Issue #218. Refs #32 (A, direct MySQL via Hyperdrive) and #50 (A2, PlanetScale).

Approach A runs WordPress in a Worker with the database on external MySQL through Hyperdrive. The page time is set by the number of SQL **network round-trips**: about 7 ms per query on A (Vultr MariaDB, Hyperdrive host name) and 16 to 20 ms on A2 (PlanetScale), and a page fires many queries (home 76, dashboard 138, editor 172, checkout 393, measured in docs/approach-a2.md and docs/results.md). Cut the round-trips and the page time falls almost linearly. This document is the design; the measured numbers are added by the Paid bracket (below).

## Two facts this design rests on

1. **Approach A has no cross-request object cache today.** build.sh copies object-cache.php and object-cache-js.php into every build, but object-cache.php loads the real drop-in only when `JS_OBJECT_CACHE` is defined, which until now happened only on b-dosql (`PHP_IN_DO=on` and `DB_IN_DO=on`). On A the constant was undefined, so WordPress used core's per-request in-memory cache, dropped at the end of each request. Every A request re-ran every read against MySQL.

2. **The persistent object-cache handler is shared code.** index-a.js is a thin wrapper that injects the MySQL bridge into index.js (`setDbHandler`). The `oc` bridge handler, the module-scope `Map`, the LRU and the `ocCalls` / `ocHits` stats all live in index.js and already serve whichever isolate runs PHP. For A that isolate is the Worker; for b-dosql it is the Durable Object. So turning the cache on for A is gating plus a correctness posture, not a new handler.

## The problem that is unique to approach A

WordPress's object cache is already write-aware. Core itself calls `wp_cache_delete( 'alloptions', 'options' )` inside `update_option`, deletes post keys inside `clean_post_cache`, term keys inside `clean_term_cache`, and so on. A persistent store that honors those calls stays exact with no blind TTL. That is the whole reason the b-dosql cache is correct, and the difference from Hyperdrive's own query cache (a 60 s TTL that is not invalidated on writes, so it serves stale WordPress reads; the deploy turns it off).

b-dosql is exact because **one Durable Object is one Map and the only writer**: core's delete in that one process purges the one store. Approach A is different: **many Worker isolates, each with its own Map, all writing the same external MySQL.** A write in isolate X purges only X's Map. Isolate Y keeps serving the stale value until Y's own entry changes. b-dosql never had this; A does. And `wrangler dev` runs a single isolate, so a local run cannot observe cross-isolate staleness. Only a multi-isolate Paid deploy can.

## Group risk classes

The posture follows from the risk of a stale cross-isolate read, per cache group.

| Group | Written by | What a stale cross-isolate read costs | Tier on approach A |
| --- | --- | --- | --- |
| `options` / `alloptions` | `update_option` (core deletes `alloptions`) | a settings change shows late in another isolate | L1 Map, allowlisted, bounded TTL |
| `terms` | `clean_term_cache` | a taxonomy edit shows late | L1 Map, allowlisted, bounded TTL |
| `theme_json` | core recompute | block styling shows late | L1 Map, salted (#199) plus bounded TTL |
| `posts` / `post_meta` | `save_post`, `clean_post_cache` | stale post content or meta | L0 per request only (NOT allowlisted); a salted or versioned L1 is a measured later step |
| `users` / `user_meta` | `clean_user_cache` | stale capabilities or session | L0 per request only |
| `woocommerce_*`, `wc_*`, sessions, product and stock meta | checkout, stock decrement, admin edits | a wrong stock, price or cart read: oversell or a wrong total | **never the L1 Map.** L0 per request, or L2 KV with explicit invalidation |

The rule is an **allowlist, not a block list**: on A the drop-in persists a group only if it is on `JS_OBJECT_CACHE_PERSIST_GROUPS` or carries a salt. A group nobody vetted stays per request. That is what keeps a correctness-critical group off the cross-isolate Map by construction, rather than by remembering to exclude it.

## The invalidation path

- **Within one isolate (one writer):** core's own `wp_cache_delete` / `wp_cache_flush_group` calls purge that isolate's Map, so a write is exact. On A this holds only for the isolate that did the write.
- **Across isolates, an allowlisted group:** the bounded TTL caps staleness. Every isolate re-reads from MySQL after `JS_OBJECT_CACHE_TTL` seconds (default 10). This is deliberate, bounded, measurable staleness, and it replaces Hyperdrive's unbounded-on-write 60 s. It is acceptable only for the low-write, non-correctness-critical groups on the allowlist.
- **Across isolates, a salted group (`theme_json`):** the salt is a fingerprint of every input (theme and version, locale, active plugins, and a counter bumped on every global-styles write). A write that changes an input changes the salt, so every isolate's next read misses and reloads. **But on approach A the salt is only as fresh as its inputs' own cache.** `theme_json`'s salt reads `get_option( 'skyphusion_global_styles_changed' )`; if the `options` group is itself cached with a TTL, the salt is stale until that TTL expires, so a salt alone is not a complete cross-isolate guarantee on A. For `theme_json` (styling, not checkout) the bounded lag is acceptable. For a correctness-critical group it is not, which is the second reason those stay off the Map entirely.
- **Removing even the bounded TTL** needs a shared version signal that every isolate reads cheaply (an L2 KV counter, or one small indexed DB read) and that a writer bumps. Whether that beats the MySQL round-trip it saves is the open question the Paid run answers. Do not assume it; measure it.

## The design

Tiers:
- **L0, the per-request PHP array** (already in object-cache-js.php): collapses duplicate reads within one page. Free, and the only tier the correctness-critical groups use.
- **L1, the in-isolate Map** (index.js module scope): zero network on a hit, survives across the requests one isolate serves. Allowlist plus bounded TTL plus the salted path.
- **L2, KV** (not built here): cross-isolate shared store that honors core's delete. A measured next lever, only if the KV hop beats the MySQL hop and the group tolerates KV's eventual consistency. The WooCommerce correctness groups probably do not.

Off switch and knobs (written into wp-runtime.php as PHP constants):
- `OBJECT_CACHE=on` turns the A object cache on. **Default off on A** until it is measured. (On b-dosql the same var stays on unless set to `off`; a deploy is one engine, so the var is unambiguous per deploy.)
- `OBJECT_CACHE_GROUPS` is the persist allowlist, sanitized to `[A-Za-z0-9_,-]`. Default `options,terms,theme_json`.
- `OBJECT_CACHE_TTL` is the bounded TTL in seconds, clamped to 0 to 3600. Default 10.
- `THEME_JSON_CACHE` (unless `off`) also enables the salted theme.json cache (php/theme-json-cache.php), the worked example of the salted path.
- The request header `x-oc-off` forces the cache off for one request, and is honored only with a valid spike token (like `x-ast-cache-off`), so a visitor cannot disable it. It gives a clean same-binary off bracket.

## Instrumentation

Emitted so the bracket can be read off the response, with the cache off and on:
- `x-d1-calls` and `x-d1-ms` (every engine): total query count and total DB time for the request.
- `x-oc-stats` (JSON, emitted when non-empty): `{ dbN, dbMs, tables, groups, ocKeys, ocKiB }`.
  - `tables` is the per-table query count on the approach-A path (`wp_options`, `wp_posts`, `wp_postmeta`, `wp_terms`, `wp_usermeta`, `wp_woocommerce_*`, ...), so the alloptions / posts / Woo split is visible directly from the DB layer, cache on or off.
  - `groups` is the per-group object-cache tally (`options.get`, `options.hit`, `options.miss`, `options.set`, `options.del`, ...), so the hit rate per group is visible when the cache is on.
  - Both diffs follow the existing per-request snapshot pattern, so a nested request (WordPress calling its own URL) cannot reset an outer one.
- `x-perf` (b-dosql only) now also carries `dbTables` and `ocGroups`.

Local verification (no DB), run in CI:
- `php spikes/b2-wordpress/tests/object-cache-isolated-test.php`: the allowlist, the bounded TTL, the salted-group override, and the force-off, with a stubbed bridge. The load-bearing check is that a WooCommerce group never reaches the persistent store; a mutation that adds a Woo group to the allowlist makes it persist, which proves the gate is load-bearing.
- `node spikes/b2-wordpress/tests/oc-isolated-test.mjs`: the source invariants of the gate, the x-oc-off bracket, and the instrumentation in index.js.

## What local proves, and what the Paid bracket must measure

A single-isolate `wrangler dev` is the same correctness model as b-dosql (one writer), so it can prove the query-count reduction and single-writer correctness, but not the two things that decide approach A:

The Paid bracket (the lead runs it) on A (#32) and A2 (#50):
1. Deploy with `OBJECT_CACHE=on`. Bracket each page (home, post, shop, product, cart, checkout) cache off / on / off again on the same binary, using `x-oc-off` with the spike token for the off bracket. Record `x-oc-stats.tables`, `x-oc-stats.groups` and `dbN` into docs/results.md. Target: a large drop in round-trips per page on the cached pages.
2. **Cross-isolate correctness:** concurrent load (tests/load) where a write lands in one isolate and a read in another, asserting no stale stock, price or cart; and tests/woo.py plus tests/cache_check.py with the cache on.
3. **The KV question:** whether an L2 KV hop beats the MySQL round-trip, and whether it is worth building for any group.
4. Widen `OBJECT_CACHE_GROUPS` (for example add `posts,post_meta`) and re-bracket to weigh the larger win against the correctness cost; cache_check.py must stay green at each width.
