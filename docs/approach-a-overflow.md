# Approach A: PHP overflow to a Durable Object pool (opt-in)

**Status:** opt-in, OFF by default (`PHP_OVERFLOW` unset). Default-on waits for Conrad's spend decision (the cost is below). Issue #296 step (3), PR #646. Measured 2026-11-15 on a throwaway approach-A site and a copy of the bench database. The numbers are in #296.

## The problem it answers

Approach A runs PHP in the Worker isolate, one request at a time (`php-lock.mjs`). Under concurrent checkout, Cloudflare keeps sending new requests to an isolate whose PHP is waiting on MySQL, so requests queue inside isolates.
- Baseline at main `2632672`: at 250 concurrent all-buyer clients, 13 requests queued on an isolate at the median, waits passed 60 s (86 s max), and 9 isolates died of memory (`exceededMemory`), each taking its whole queue with it.
- Measured with `tests/load/load.py` checkout ladders from a VPS (lax): 25 to 250 users, 15 s per level, `BUYERS=1.0`.

## What it does

With `PHP_OVERFLOW=on`, a request that finds its isolate busy (a run in flight AND `PHP_OVERFLOW_DEPTH` requests waiting) is sent, **before it has run**, to one of `PHP_OVERFLOW_POOL` Durable Objects (`ovf-0`..), each with its own isolate and one PHP runtime.
- A request is never run twice.
- Spike paths (`/_*`), media uploads and bodies over 1 MiB never move.
- Pool objects never run WordPress cron, and their page-cache purges go back to the front Worker.
- Each move logs `m: php-lock`, `event: overflow`.

| setting | default | meaning |
|---|---|---|
| `PHP_OVERFLOW` | off | `on`: overflow. `always`: every eligible request (a functional test only) |
| `PHP_OVERFLOW_POOL` | 8 | the number of pool objects (1 to 128) |
| `PHP_OVERFLOW_DEPTH` | 1 | move when this many are already waiting (0 to 50) |
| `PHP_OVERFLOW_HINT` | `wnam` | the objects' location hint (measured best) |
| `PHP_OVERFLOW_BUSY` | off | `on`: a busy object answers busy, and the Worker tries elsewhere (see below) |

The site needs the `PHP_RUNTIME` Durable Object binding (class `PhpRuntime`) and a SQLite migration declaring it.

## Recommended setting for a busy approach-A store

**`PHP_OVERFLOW=on`, `PHP_OVERFLOW_POOL=32`, `PHP_OVERFLOW_BUSY` off.** It is the only measured setting with **0 memory deaths at 250 concurrent checkouts**: errors first.

Measured at 250 concurrent (checkout ladder, copy of the bench DB, 2026-11-15):

| setting | checkouts completed | checkout p50 | `exceededMemory` (whole ladder) |
|---|---|---|---|
| no overflow (baseline, main `2632672`) | 206 of 245 | 13.6 s | 9 |
| pool 8 | 112 of 155 | 7.1 s | 11 |
| pool 16 | 193 of 230 | 7.9 s | 9 |
| **pool 32 (recommended)** | **237 of 250** | **10.3 s** | **0** |
| pool 32 + busy | 249 of 256 | 11.3 s | 5 |
| pool 64 + busy | 234 of 249 | 14.0 s | 1 |

**Reading it:**
- **Small pools are worse than none:** the queue moves into the objects (at pool 32, 507 of 699 waits were in objects).
- **Busy stops objects from queueing,** but moves the queue back into the Worker isolates, and their memory deaths come back.
- **At 250 all-buyer clients the PHP capacity is saturated wherever the queue sits:** 72% of busy-mode attempts found an object busy at pool 32, and 60% at pool 64.
- **Pool objects are slower per query** (SELECT 1: 26 ms p50 from an object with hint `wnam`, against 8 ms from the placed Worker). So the latency bar is a per-request cost problem; #296 step (2) and step 3.
- **Every memory death in every arm was in a Worker isolate.** No pool object died.

## Cost

Durable Object duration bills 128 MB for each object's wall time while it handles a request, and it counts time a request waits inside the object.
- **Measured at pool 32:** 763 moved requests, wall time mean 23.6 s (p50 13.8 s, p90 63.2 s), so **about 3.0 GB-s per moved request**.
- That is **about 38 USD per million moved requests** (duration 37.78, requests 0.15, at 12.50 USD per million GB-s).
- A store moves requests only while its isolates are busy. At low load nothing moves and nothing is billed.
- Anything past bench use is Conrad's spend call: default-on, or a production site.

## Limits

- The p50 target (9 s at 250) is not met by any setting. Capacity is the limit, and a checkout runs 313 to 393 queries.
- The pool size depends on the load; it is not self-tuning.
- Measured on one store and one database (Azure `wpref-mysql`, West US 2), from one VPS client.
