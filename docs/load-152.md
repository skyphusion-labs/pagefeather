# Multi-site concurrent load: the b-dosql ceiling (issue #152)

Where a b-dosql site stays fast, and where a store must move to a VPS or to
Approach A (cached). Measured 2026-11-08 against live Workers Paid deploys.

## The harness

Two standard-library harnesses already in the tree, merged in #153:

- `tests/load/multi.py`: concurrent load across several sites at once. Per-site
  p50/p95/p99, requests a second, status mix, cache-status mix, a one-shot
  checkout probe, an isolation mode, and the generator's own 1-minute load each
  step so a saturated generator is visible. Usage in `tests/load/multi.md`.
- `tests/load/load.py`: single-site WooCommerce. Shoppers browse, a fraction
  check out over the Store API (cart, add item, checkout, cash on delivery, so
  nothing is charged). Counts error 1102 (the 128 MiB isolate limit) and any
  503 shed.

This run added no harness code. It is the measured result the issue was open for.

## Targets

Three live b-dosql Paid deploys, no credentials needed, HTTP load only:

- `woocap.skyphusion.workers.dev`: WooCommerce active (Store API answers,
  `x-db: object-sqlite`, PHP 8.3.36, 20 purchasable in-stock products).
- `wp-blog.skyphusion.workers.dev`, `wp-news.skyphusion.workers.dev`: read-heavy
  blogs.

## Vantage, and what it can and cannot prove

The run was driven from Conrad's 6-core laptop, not the Vultr VPS that
`tests/load/multi.md` prescribes. This is disclosed, not hidden, and it bounds
the claims:

- The uncached-read and checkout ceilings are set by the single Durable Object.
  Each such request takes seconds, so the client completes few at a time and is
  not the bottleneck. The recorded 1-minute client load stayed at 2 to 5 of 6
  cores through these steps. These numbers are Durable-Object-bound and sound.
- The cached-read throughput figures are a LOWER bound. A clean multi-core VPS
  could drive more requests a second than a busy laptop, so the real cache
  ceiling is at least what is reported here, likely higher. The flat cached p50
  is sound; the cached p95/p99 tail at the top steps may carry client jitter.

Each point was run at least twice. Run-to-run variance is dominated by cold
starts (a first hit boots the object in about 4 to 5 seconds; a warm hit is
about 0.2 seconds), noted per section.

## The ceiling in one line

A b-dosql site serves cached (edge) reads fast and scales with concurrency
(about 25 to 30 requests a second per site at the tested load, p50 near 200 ms),
with clean cross-site isolation. Its limit is the ONE Durable Object on any
request the cache cannot answer. Uncached dynamic reads and the checkout write
path are served one at a time, so their throughput is pinned near one over the
per-request CPU time, and latency grows linearly with concurrency. Within the
tested range the failure mode is latency, not errors: no 503 shed and no error
1102 were seen. So b-dosql holds a store whose uncached dynamic concurrency stays
in the low single digits. Move to a VPS or to Approach A once sustained uncached
dynamic traffic, or concurrent checkouts, climb past that.

## Scenario results

### 1. Uncached reads (every request wakes the object)

`CACHE=miss` puts a unique query on each request so the Workers Cache cannot
answer and the request reaches the object. Per-site concurrency in parentheses.

| Site | 1/site | 2/site | 4/site | 8/site | 16/site | 32/site |
| --- | --- | --- | --- | --- | --- | --- |
| shop (Woo) p50 | 3.2 s | 4.1 s | 5.5 s | 7.9 s | 14.5 s | 23.0 s |
| shop rps | 0.34 | 0.48 | 0.61 | 0.91 | 1.23 | 1.41 |
| blog (reg) p50 | 0.5 s | 0.6 s | 1.3 s | 2.6 s | 4.2 s | 8.6 s |
| blog rps | 0.87 | 2.95 | 2.92 | 2.93 | 2.32 | 2.78 |
| news (reg) p50 | 0.4 s | 0.4 s | 0.7 s | 1.2 s | 2.2 s | 4.1 s |
| news rps | 1.54 | 4.71 | 5.69 | 5.15 | 5.67 | 4.24 |

Throughput is flat from the first client: the object serializes work, so adding
concurrency does not add throughput, it adds queue depth, and latency climbs
about linearly. Woo render is the heaviest (about 0.6 to 1.4 req/s per object);
a regular page is 2 to 5 req/s. Across all uncached steps to 32 per site every
response was 200: 0 of each of 5xx, exceptions, and error 1102.

### 2. Cached reads (the Workers Cache lever)

`CACHE=hit`, so the edge cache can answer and most requests never touch the
object. Total concurrency across the three sites in parentheses.

| Per-site concurrency | rps/site | p50 | cache |
| --- | --- | --- | --- |
| 2 (6 total) | about 10 | 177 ms | HIT |
| 4 (12 total) | about 18 | 196 ms | HIT |
| 8 (24 total) | about 24 | 245 ms | HIT |
| 16 (48 total) | 26 to 30 | 385 ms | HIT |

Cached throughput is 20 to 100 times the uncached figure and scales near
linearly with concurrency, with p50 flat near 200 ms, because the single object
is off the path. The first step after a cold cache shows MISS and UPDATING
(stale-while-revalidate) before settling to HIT. The cache hit ratio, not the
object, sets a read-heavy b-dosql site's ceiling.

### 3. Cross-site isolation

Isolation mode drove shop heavy (24 concurrent, uncached, p50 to 15.6 s) while
blog and news stayed light (4 each).

| Light site | p95 baseline | p95 under heavy neighbour |
| --- | --- | --- |
| news | 1120 ms | 1097 ms |
| blog | (cold-boot outlier in baseline) | 1843 ms |

A neighbour under heavy uncached load did not degrade the other sites: news was
flat. Each site is its own Durable Object, so load does not cross between sites.
The blast radius of one site's overload is that one site.

### 4. Checkout write path

`load.py` on woocap, 40 percent of loops buy (cart, add item, checkout, cash on
delivery). Two samples; checkout p50 shown.

| Concurrent buyers | 1 | 3 | 6 | 10 |
| --- | --- | --- | --- | --- |
| checkout p50, sample A | 1.07 s | 2.30 s | 5.80 s | -- |
| checkout p50, sample B | 4.15 s | 4.79 s | 8.02 s | 8.07 s |

Every checkout returned an order id. Across both samples: 0 error 1102, 0 shed
(503), 0 aborted. A buy is three Store-API writes through the one object, so
checkout throughput caps near 0.5 to 0.7 a second per store and latency grows
with concurrency just as reads do. The variance at one buyer is a cold start.

The known 1102 memory boundary (a checkout memory spike past the 128 MiB isolate
limit, docs `approach-b` 8f) was NOT provoked here: the issue says to note it,
not to stress a shared live store to failure. It is a heavier-path boundary that
low-concurrency COD checkout did not reach.

## What did NOT appear, and the denominator

No 503 overload shed was observed on any of the three live deploys, to 96 total
and 32 per site, over 10 to 23 second steps. b-dosql does carry a 503 overload
answer (PR #47), but it is intermittent and was measured on a Workers Free perf
rig (`perf-dosql.md`), not on these Paid deploys. So the honest statement is
narrow: these deploys queued rather than shed within the tested range. Finding
the exact concurrency where a Paid object starts to shed, or where a request
finally crosses a duration wall, would need a clean multi-core VPS generator to
drive more real concurrency than this laptop can; it is scale-regime work, which
is the VPS / Approach A territory this ceiling points a store toward anyway.

## Product positioning

- Read-heavy site that caches well (blog, brochure, catalogue with few logged-in
  users): b-dosql is a good fit. The edge serves the load; the object wakes only
  for cache misses and admin.
- Store with real, concurrent, uncached dynamic traffic (logged-in carts, many
  concurrent checkouts, search-heavy): the single object is the ceiling. Latency
  climbs with concurrency well before any error. This is the signal to move to a
  VPS, or to Approach A with caching in front.
- The move-off trigger is not a request-a-second number, it is concurrency of
  uncached dynamic work. Low single digits is comfortable; steady double digits
  of uncached dynamic concurrency means seconds of p95 and a move is due.

## Reproduce

```sh
S="shop:woo:https://woocap.skyphusion.workers.dev \
   blog:reg:https://wp-blog.skyphusion.workers.dev \
   news:reg:https://wp-news.skyphusion.workers.dev"

# uncached read ramp
SITES="$S" LEVELS="3,6,12,24" SECONDS=12 CACHE=miss python3 tests/load/multi.py
SITES="$S" LEVELS="48,96"     SECONDS=10 CACHE=miss python3 tests/load/multi.py
# cached read ramp
SITES="$S" LEVELS="3,6,12,24,48" SECONDS=10 CACHE=hit python3 tests/load/multi.py
# cross-site isolation
SITES="$S" MODE=isolation ISO_HEAVY=24 ISO_LIGHT=4 SECONDS=10 CACHE=miss \
  HEAVY_SITE=shop python3 tests/load/multi.py
# checkout write path
B=https://woocap.skyphusion.workers.dev LEVELS="1,3,6,10" SECONDS=12 BUYERS=0.4 \
  SETUP=0 WOO=1 python3 tests/load/load.py
```

Run the generator on a VPS, not the box under test, for clean upper numbers.
