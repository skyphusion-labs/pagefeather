# Multi-site WfP load harness (issue #152)

`tests/load/multi.py` drives concurrent load against several Workers for Platforms sites at the same time, so they contend on the one dispatch namespace, and reports per-site latency, throughput and status mix at each concurrency step. It is pure Python standard library: on a fresh Ubuntu VPS there is nothing to install but `python3`, which Ubuntu already has. It parallels the single-site harness `tests/load/load.py`.

Run it ON the load-generator VPS, not on the box under test, so the generator is kept out of the measurement path. Each step reports the generator's own 1-minute load and CPU count, so a saturated generator is visible and not mistaken for the sites slowing down.

## On the VPS: setup

```sh
# python3 is on Ubuntu already; this only confirms it.
python3 --version

# fetch just the harness (no clone needed):
curl -fsSLO https://raw.githubusercontent.com/skyphusion-labs/wordpress-on-cloudflare/main/tests/load/multi.py
```

## Run

Set the four site base URLs (a site is `name:type:url`; type is `woo` or `reg`):

```sh
export SITES="shop:woo:https://wp-shop.skyphusion.workers.dev \
              store:woo:https://wp-store.skyphusion.workers.dev \
              blog:reg:https://wp-blog.skyphusion.workers.dev \
              news:reg:https://wp-news.skyphusion.workers.dev"
```

Two ramp runs, one that misses the Workers Cache (reaches the Durable Object) and one that hits it:

```sh
CACHE=miss SECONDS=30 python3 multi.py > miss.json 2> miss.txt     # cache-miss: the site's own render
CACHE=hit  SECONDS=30 python3 multi.py > hit.json  2> hit.txt      # cache-hit: what the edge answers
```

The default ramp is `LEVELS="10,50,100,250"` TOTAL concurrent workers per step, split evenly across the four sites (so each site gets a quarter). Set `PER_SITE=1` to make each level per site instead. `SECONDS` is the time per step.

Confirm the WooCommerce checkout memory boundary once, without stressing it (one `GET /checkout/` per Woo site; a 5xx naming error 1102 is the isolate memory limit, expected):

```sh
CHECKOUT_PROBE=1 LEVELS="10" SECONDS=10 python3 multi.py > probe.json 2> probe.txt
```

Cross-site isolation (does one site's heavy load degrade the others on the shared namespace?): one site heavy, the rest light, compared against an all-light baseline:

```sh
MODE=isolation HEAVY_SITE=shop ISO_HEAVY=200 ISO_LIGHT=10 SECONDS=30 python3 multi.py > iso.json 2> iso.txt
```

The isolation summary prints, for each light site, its p95 at the all-light baseline, its p95 while `shop` is heavy, and the delta. A small delta is isolation holding.

## What it reports

Per site, per step: p50/p95/p99 latency (ms), requests per second, the status classes `2xx/3xx/4xx/5xx/exc`, the count of error-1102 responses (the isolate memory limit), and the `cf-cache-status` mix (so cache-hit vs cache-miss is confirmed, not assumed). Each step also carries the generator's 1-minute load and CPU count.

`multi.py` prints one JSON object per step to stdout as it goes (for a live tail), a short human table to stderr, and one final JSON object with everything on the last stdout line. Redirect stdout to a `.json` file and stderr to a `.txt` file, as above.

## Paths hit

- `woo` sites: `/`, `/shop/` (home and the storefront/product-archive query). Override with `WOO_PATHS` (comma list). The stores have no seeded products, so no individual product URL is hit; `/shop/` exercises the archive query.
- `reg` sites: `/`, `/?page_id=2` (home and the default Sample Page). Override with `REG_PATHS`. A 404 on the second path shows in the status counts rather than being hidden.
- Checkout is never in the sustained load; use `CHECKOUT_PROBE=1` for the one-shot boundary check above.

## Offline self-check

`tests/load/multi-stub-test.py` runs `multi.py` against a local stub (no real sites): it checks the plan, the per-site stats at two levels, the cache mix, the checkout-probe 1102 detection and the isolation delta. Run it before trusting a change:

```sh
python3 tests/load/multi-stub-test.py
```

## Teardown

The VPS is a same-day load generator (cents). Destroy it when the run is done. It holds no site data; it only sends requests.
