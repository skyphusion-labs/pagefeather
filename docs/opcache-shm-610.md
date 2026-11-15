# OPcache shared memory vs the file-cache fallback (#610)

Status: **measured again after #582 M2b (#614), locally, 2026-11-15.** The runtime default
`opcache.memory_consumption` 48 is **unchanged**. This page is the re-measure #610 asked for.

The first reading (issue #610, 2026-11-15, M2a delta engine) was 1,311 scripts in shared memory at
48 MB and **765** of 2,076 taking the file-cache fallback; 128 MB held all 2,076 at 69.8 MB used.

## Finding

On this lean engine pair, after M2b, the admin e2e still fills 48 MB. The fallback is **not gone**.

| memory_consumption | scripts in SHM | file-cache fallbacks | SHM used | SHM free | wasm heap | e2e s | wall s |
|---|---|---|---|---|---|---|---|
| 48 (production default) | 1,314 | **765** | 48.00 MB, full | 1,376 B | 113.31 MiB | 12 | 23 |
| 64 | 1,888 | 191 | 63.99 MB, full | 14,800 B | 110.19 MiB | 11 | 21 |
| 96 | 2,079 | **0** | 66.54 MB | 29.46 MB | 140.25 MiB | 11 | 24 |
| 128 | 2,079 | **0** | 66.54 MB | 61.46 MB | 172.25 MiB | 12 | 23 |

96 is the first size that holds every admin-e2e script. 128 holds the same 2,079 and spends the extra
32 MB of shared memory as unused headroom inside the wasm heap.

`opcache_get_status()["pagefeather_lazy_bodies"]` was **null** on every run. This pair is the eager
lean engine, not the lazy-body build: scripts still persist whole into shared memory on the empty-cache
compile path that #610 measures.

## Recommendation

**Keep 48.** Do not raise the default.

- At 48 the fallback is still 765 of 2,079, the same overflow as the M2a reading (765 of 2,076).
- 96 is the first size with zero fallbacks (66.54 MB used). It costs about **27 MiB** of wasm heap
  (113.31 to 140.25) and sits on the lean-site recycle line of 140 MiB (#598).
- 128 costs about **59 MiB** of wasm heap (113.31 to 172.25), over that 140 line. The extra 32 MB of
  shared memory is unused (the working set is 66.54 MB).
- 64 still overflows (191 fallbacks) and ends at 110.19 MiB, over the default recycle line of 100.
- Shared memory lives inside wasm memory. The memory wall is the constraint, so a larger
  `memory_consumption` is not free.

A site that already sets `RECYCLE_WASM_MIB=140` for the lean engine could try 96 as a **per-site**
`PHP_INI` override and re-measure on the primed load path. That is not this PR.

## Method

Local only: `wrangler dev --local` on this laptop, Wrangler 4.107.0. No deploy, no Cloudflare API.

Tree: `origin/main` `373cd1e16c6902db25d65b75eefb61956ac358ec` (the measurement scripts in this PR
do not change PHP, OPcache, or the 48 default).

Engine pair, checked before the build:

| file | sha256 |
|---|---|
| `PF_ENGINE_JS` `php_8_3.js` | `7683d509aadc4b9bfa9f75bca655d178e6a9d8fe8a9b1707350866203105047b` |
| `PF_ENGINE_WASM` `php_8_3.wasm` | `dcd408efff98d8f5007d6eb42fba784e2c9c8229dbf2cbf1ce22614ffc7165f0` |

Sequence, once per size, matching `opcache.sh`'s setup and `tests/lazy-bodies-e2e.sh`:

1. Empty `build/opcache.zip`. Fresh `PERSIST_TO`. `PHP_RECYCLE:off` so one runtime holds the whole run.
2. `PHP_INI={"opcache.memory_consumption":"N"}` for N in 48, 64, 96, 128.
3. `POST /_install`, activate WooCommerce, `spikes/b2-wordpress/e2e.sh`.
4. `GET /_mem`: `ini.cached` is `opcache_get_status()["opcache_statistics"]["num_cached_scripts"]`;
   `ini.mem` is `memory_usage`; `wasmMemoryBytes` is the runtime heap.
5. `GET /_opcache-dump`: count `.bin` files. The dump walk skips `wp-runtime.php.bin`, which still
   counts in `cached`, so when shared memory is full, fallbacks = `dump_bins - cached + 1`. When it
   is not full, every compiled script fitted and fallbacks are 0. That is the issue's 765:
   2,079 at 128 minus 1,314 at 48.

Runner: `spikes/b2-wordpress/tests/opcache-shm.sh`. Parser: `tests/opcache-shm.py`. Unit test:
`tests/opcache-shm-test.sh` (synthetic `/_mem` JSON and dump zips; no wrangler).

```
cd spikes/b2-wordpress
PF_ENGINE_JS=.../php_8_3.js PF_ENGINE_WASM=.../php_8_3.wasm ./prepare.sh
WOO=1 ./build.sh
PORT=8761 tests/opcache-shm.sh 48 /tmp/mc48.json
```

`e2e s` is the `e2e.sh` wall after install and activation. `wall s` is the whole size, including
boot, install, and WooCommerce activation.

## What this does not measure

- The **primed** load path (a shipped `opcache.zip`). M2b's lazy load keeps only the script head in
  shared memory on that path. This method compiles from an empty cache, so it does not exercise that.
- A live site, a Durable Object, or `DEV_ENV=dosql-local`. The spike default env, as
  `tests/lazy-bodies-e2e.sh` uses.
