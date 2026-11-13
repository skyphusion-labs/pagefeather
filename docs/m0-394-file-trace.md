# M0: which bundle files a request reads (pagefeather#394)

Step M0 of `docs/design-394-bundle-out-of-memory.md` (design PR #403). Measured 2026-11-13 by
rollins (seat rollins-sb1114b), LOCAL only: `wrangler dev --local` (Wrangler 4.107.0),
`DEV_ENV=dosql-local`, WooCommerce active, main `66b849c` plus this branch. The store is the
priming store (`e2e.sh` and `tests/woo.py` data), NOT the 2,609-product sample store, so absolute
sizes can differ on a real site. The WASM build is the one a site runs (`prepare.sh`).

## How to repeat

```
./build.sh && ./prepare.sh
DEV_ENV=dosql-local WOO_ACTIVE=1 ./opcache.sh       # the primed build, as CI and deploy make it
DEV_ENV=dosql-local WOO_ACTIVE=1 ./file-trace.sh    # FILE_TRACE=on, e2e + woo.py + admin pages
python3 file-trace-report.py build/file-trace.json
```

`FILE_TRACE=on` records the path of each bundle file a request reads (`file-trace.mjs`), and
`GET /_trace` (spike token) returns and clears the record. It changes no behavior and is off by
default.

## Results

### 1. A warm request reads OPcache files, not site source

43 requests (`build/file-trace.json`, 0 dropped), 35 of them warm:

| per warm request | files | uncompressed | deflated |
|---|---|---|---|
| OPcache `.bin` | 716 | 21.95 MiB | 5.07 to 9.77 MiB, p50 5.86 |
| site source (json, php, html, css) | about 52 | about 0.16 MiB | n/a |

Over ALL route classes, the site source read is 0.99 MiB of the 69.15 MiB in `site.zip`. A boot
reads 51 to 66 MiB of `.bin` files (uncompressed).

### 2. Why: OPcache shared memory is full

`GET /_mem` after warm requests (`opcache.memory_consumption` 32, the default in
`index.js:1106`): `used_memory` 33,551,848 bytes, `free_memory` 2,584, 776 scripts cached (a second
run: 33,540,256 used, 14,176 free, 776 cached). The scripts that do not fit are loaded from the
OPcache FILE cache on every request. That is the about 21.7 MiB a warm request inflates on a real
site (#394 comment 1: `inflateKiB` 21,698 to 21,848). The same cause explains build 2 of #394
(16 MiB shared memory, WASM 115 MiB): more scripts come from the file cache into the request's
own memory.

### 3. Admin pages grow WASM far past the front pages

Same local build, OPcache 32 (the default), logged in, `x-perf` `wasm1MiB`:

| page | WASM after the render |
|---|---|
| front (`/`, `/?post_type=product`) | 99 MiB |
| `/wp-admin/` | 119 MiB |
| `/wp-admin/profile.php` | 99 MiB |
| `/wp-admin/post-new.php?post_type=page` | 143 MiB |

The #394 data-module probe saw a lone WASM memory reset near 188 MiB without the bundle and near
144 MiB with it (#394 comment 6). So a `post-new.php` render (143 MiB) plus the bundle (about 44
MiB) is at that reset point before any JS heap. This fits the admin write-loss of #394 (comment 5,
and the lead's comment of 12:05Z). Not yet measured on a deployed site.

### 4. OPcache size sweep (local, one run each, 13 requests: front, then admin)

| `memory_consumption` | front WASM | dashboard | post-new | front warm inflate | front warm phpMs | boots of 13 |
|---|---|---|---|---|---|---|
| 32 (today) | 99 | 119 | 143 | about 20.2 to 21.1 MiB | 271 to 325 | 3 |
| 40 | 97 | 116 | 139 | about 12.1 to 13.0 MiB | 242 to 327 | 3 |
| 44 | 104 | 104 | 124 | 8.1 MiB (then every request recycled) | n/a | 12 |
| 48 | 92 | 111 | 133 | about 4.0 to 4.7 MiB | 159 to 205 | 7 |
| 52 | 98 | 117 | 141 | about 0.4 to 2.7 MiB | 125 to 175 | 3 |
| 56 | 104 | 104 | 124 | 0.4 MiB (then every request recycled) | n/a | 12 |

- WASM grows in coarse steps, and the step depends on which request booted the runtime. At 44 and
  56 the first boot went to 104 MiB, just over the 100 MiB recycle line (`index.js:45`), so every
  later request booted again. The numbers are therefore NOT monotonic in the size.
- Every admin page above 100 MiB recycles the runtime at every size. That is the recycle line,
  not the isolate limit.
- A larger shared memory cuts the per-request file-cache load hard (20 MiB to under 3 MiB at 52)
  and the PHP time by up to about 45% (front, local).
- One run per size, on an empty store. This is a lead to measure on the sample store, not a
  setting to ship.

### 5. What this changes in the design

- **L1 as designed regresses.** It fetched the `.bin` files at boot and released them after the
  boot request. At OPcache 32, a warm request reads 716 `.bin` files (5 to 10 MiB deflated), so
  after the release most warm requests would compile from source. L1 needs either a per-request
  fetch of those files, or a shared memory big enough that warm requests stop reading them.
- **L2 is much smaller than estimated.** Requests read about 1 MiB of the 69 MiB site source in
  this crawl. The source is needed when a script is not in OPcache (a compile), which is the miss
  path.
- **The runtime is the JSPI build.** `prepare.sh:8` builds `vendor/php_8_3.js` from
  `@php-wasm/web-8-3/jspi`. Option E of the design (an async file layer, rejected as "a different
  runtime build") may be closer than the design says. Not measured.
