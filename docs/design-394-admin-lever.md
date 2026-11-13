# Design: the admin lever (pagefeather#394, alpha gate #422 Gate 3)

Status: DESIGN ONLY, at the lead's gate. Written 2026-11-13 by rollins (seat rollins-sb1114b).
Gate 3 asks for 100% everyday wp-admin success over 50 rounds, 0 write-loss and 0 answer/state
disagreements. This picks the lever among L1 (opcache.zip out), L2 (site.zip out) and an
admin-aware recycle line. It uses only today's measurements. A number with no source is labeled
unmeasured.

## 1. The budget, from today's numbers

| item | MiB | source |
|---|---|---|
| reset point, lone WASM memory, no bundle | about 188 | data-module probe (#394, 2026-11-13 11:13Z), 3 of 3; contradicts the 128 MB doc (#411) |
| bundle in module memory | about 44 (site.zip 19.3, opcache.zip 21.1, WASM module code about 3.5) | same probe: 188 without the bundle, 144 with it |
| front page WASM | 92 at OPcache 48, 99 at 32 | pf394a op48 and op32b `x-wasm-mib` |
| dashboard and profile WASM | 111 at 48, 117 to 119 at 32 and 52 | pf394a op48, op52; M0 local |
| post-new.php WASM | 133 at 48, 141 to 143 at 32 and 52 | M0 local sweep; pf394a op52 (141 on the 3 that answered) |
| JS heap in a request (inflated files, runtime objects) | **unmeasured**; live inflated copies are capped at 8 MiB (`index.js:358`), but each admin request inflates 8 to 68 MiB in total | M0 sweep `inflateKiB` |

The peak of a post-new.php request today: WASM 133 to 143, plus bundle 44, is 177 to 187 MiB
before any JS heap, against a reset point near 188. That is about 0 to 11 MiB of room for the JS
heap. It fits what we see: admin requests fail about half the time, whatever came before.

## 2. What each lever changes in that peak

| lever | in-request peak of post-new (before JS heap) | room for the JS heap | gets admin to 100%? |
|---|---|---|---|
| today | 177 to 187 | 1 to 11 | no: about 50% fail (pf394a, 4 runs) |
| admin-aware recycle line (raise 100 MiB for admin) | unchanged: the line acts AFTER a request | unchanged | **no.** A recycle never fails the request it follows. It only decides whether the NEXT request boots. Raising it keeps a 111 to 143 MiB WASM resident between requests, which leaves LESS room for the next one. It is a speed lever for admin (fewer boots), never a success lever. |
| L1: opcache.zip out (21.1) | 156 to 166 | 22 to 32 | **unknown.** It depends on the unmeasured JS heap. The boot request of an admin page reads 59 to 66 MiB (raw) of .bin files (M0), about 15 to 19 MiB deflated, so the BOOT request still holds most of that pack while it runs. |
| L2: site.zip AND opcache.zip out (40.4) | 137 to 147 | 41 to 51 | **the only option with real room**, if the JS heap of an admin request is under about 40 MiB |

A side check against the data, and why the recycle line is not the cause: requests right after a
recycle failed 17 of 56 (30%). Requests after an OK request failed 26 of 57 (46%), and after a 500,
45 of 82 (55%) (all four pf394a runs, my headers). So in-isolate re-boots are not what fails admin
pages. The steady peak is.

## 3. Recommendation: L2, built as two slices, with L1 first

**Pick: take BOTH zips out of module memory.** Ship L1 first as the first slice, measured. Then
L2 (site.zip), unless L1 alone reaches the bar. The recycle line comes after, for speed only.

M0 makes L2 much cheaper than the #403 estimate:
- **site.zip:** over the whole M0 crawl, requests read 0.99 MiB (raw) of the 69 MiB of source. The
  source is read only when a script is NOT in the OPcache file cache. So L2 keeps a small HOT SET
  resident: the files the priming crawl read, about 1 MiB raw (about 0.3 MiB deflated,
  **unmeasured** as a pack). Everything else lives in Assets. A miss (a file outside the hot set)
  takes the stop-and-rerun path of #403 section 2.6. Before any side effect, the request reruns
  after a fetch. After a SQL write, it reruns after a request-level undo (the #60 `_wp_undo`
  triggers). After an irreversible op, it answers the honest write-loss 500 (`missUnsafe`). With
  the hot set resident, misses should be rare: the measurement counts them.
- **opcache.zip:** per-route-class packs in Assets (core plus class, M0 sizes 4 to 19 MiB
  deflated). Each is fetched BEFORE `php.run` (async, so no sync problem), held in a capped LRU,
  and dropped after the request. An OPcache miss compiles from source, which is OPcache's normal
  path, so it is always safe. At OPcache 48 a warm admin request reads 8 to 13 MiB raw of .bin
  (M0 local), so the class pack is needed on warm requests too, not only at boot.
- **Fallback when the ASSETS binding is missing** (the lead's L1 condition): keep today's
  in-memory path behind a dynamic import, and log it. Its memory cost when never imported is
  unmeasured (the dmprobe question). It only matters on a misconfigured site.
- **Plumbing:** `binding = "ASSETS"` plus `run_worker_first = ["/_pf/*"]` in the WfP template, and
  the Worker refuses `/_pf/` to everyone (#412). The stranger test is part of done.
- **JSPI:** the runtime is already the JSPI php-wasm build (`prepare.sh:8`). An async file read
  could later replace the stop-and-rerun miss path. That needs its own spike; it is not in this
  plan.

## 4. How we know it worked (pf394a, same build discipline as today)

- `measure394.py` admin, **50 rounds** (Gate 3), plus `gap` and a 1 rps `crawl`, at OPcache 48,
  on: the op48 baseline (have it), L1, then L1 plus L2.
- **Bar:** admin 50 of 50 on every request type. 0 `x-write-loss`. 0 REST answer/state
  disagreements (`stateFound` vs code). 0 "exceeded its memory limit" in Workers Logs for the
  admin window. `missUnsafe` 0.
- New `x-perf` fields: `packN`, `packKiB`, `packMs`, `miss`, `missUnsafe`, so the cost is visible.
- The first step of L1 also answers the unknown in section 2: the room the JS heap takes. If L1
  alone reaches 50 of 50, L2 waits.

## 5. Risks

- **The reset point itself (#411).** All of this rests on the measured 188 MiB. If the real
  budget is the documented 128 MB for WASM plus JS, a post-new.php render (WASM 133 or more) can
  never fit on b-dosql, whatever leaves module memory. Then the admin answer is a smaller PHP heap
  for the block editor (its REST preload), or approach A. #411's repeat probe should run alongside
  L1; it is about half a day.
- **The JS heap of an admin request is unmeasured.** It decides L1 versus L2. It is read off the
  L1 run, not guessed.
- **Rerun safety (L2):** a rerun after an undo must leave the database exactly as before. Test it
  with a forced miss on each writing class, comparing a table hash before and after.
- **Cost:** Assets requests are free per the Cloudflare docs (read 2026-11-13). Whether a binding
  fetch from inside a Durable Object is billed is unmeasured: read it on the bill (M5 of #403).

## 5a. Approach a (Hyperdrive MySQL), added 2026-11-13

The Hyperdrive path stays open (Conrad, 2026-11-13).
- **The same problem:** `index-a.js` imports `index.js`, so every `a` isolate holds the same about
  44 MiB bundle as data modules, next to its MySQL client.
- **L1 carries over:** the `a` envs bind `ASSETS`. But `a` is not on WfP, so its asset router serves
  `build/public` before the Worker runs. The packs need `run_worker_first = ["/_pf/*"]` in the `a`
  config, and the stranger test (#412).
- **L2 carries over for reads.** Its write half does not: the stop-and-rerun after a SQL write uses
  the #60 `_wp_undo` triggers, which exist only in the object's SQLite. On `a`, the equivalent is a
  request-level MySQL transaction on the request's Hyperdrive connection. That is unbuilt; until it
  exists, a post-write miss on `a` answers `missUnsafe`.
- **The budget question is the same isolate question:** the #411 probe measures the isolate, not
  the object.

## 6. Estimate

- L1 with the Assets plumbing, the fallback, tests and a 50-round run: 3 days.
- L2 with the hot set, the miss path, the undo frame, tests and a 50-round run: about 1 week.
- #411 repeat probe: half a day, in parallel, needs the lead's OK for two throwaway Workers.
