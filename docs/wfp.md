# Workers for Platforms: what works (verification spike)

Issue #35 asks for a reference deployment for a Workers for Platforms (WfP) user: a dispatch Worker, one user Worker per site, all as code. This page answers the "Verify first" list of #35 with evidence. It is not the design. The design comes after this, in #35.

Each answer names its source: a Cloudflare documentation page (read on 2026-11-05; the page's own "last updated" date is in the table at the end) or a test in `tests/wfp/` that ran on 2026-11-05 on the Skyphusion Labs account (Workers Paid, WfP already on). The result files are in `tests/wfp/results/`.

## The reference deployment

`deploy/wfp/` (issue #35, slice 2) is the deployment that these findings lead to: one `b-dosql` user Worker per site, a dispatcher per site on `workers.dev` (phase A of the #35 design), a site map in KV and an outbound Worker, every resource as code. Its README has the day-one commands. Its live runs answered the open question (b) below: the Workers Cache works in a namespace script. Phase B of that design (one dispatcher `wp-dispatch` with a Workers Custom Domain per site under `wfp-test.skyphusion.org`) is in the code behind `WFP_CUSTOM_DOMAIN=1`; its live attach routes a zone and is governed by CR #138, so `workers.dev` stays the default.

## Summary

| # | Question | Answer | Evidence |
| --- | --- | --- | --- |
| 1 | Durable Objects with SQLite storage in a user Worker | **Yes.** The real `b-dosql` WordPress runs as a user Worker: install, `e2e.sh` 17 of 17, all bench pages 10 of 10. Two tenants have separate objects and data. **The Workers Cache works in a namespace script too** (open (b), answered 2026-11-06). | Test. The docs do not say either. |
| 2 | Containers from a user Worker | **Yes, with two workarounds.** A container of a namespace user Worker answered HTTP through the dispatcher (#43). Wrangler cannot make the container application of a namespace script, so it is made through the API; and an image cannot be pushed to the registry on its own, so the user Worker reuses an image that a normal Worker deploy pushed. The first answer came about 1.5 to 2 minutes after the application was made. | Test. The docs say "Run containers" and no more. |
| 3 | D1, R2 and Images bindings; how bindings attach | **Yes, all three.** Bindings go in the upload metadata. `wrangler deploy --dispatch-namespace` writes them from the Wrangler config, with secrets (`--secrets-file`) and static assets. | Test and docs. |
| 4 | Limits per call; the outbound Worker | `subRequests` was exact in this test, which ran without an outbound Worker (not measured with one). `cpuMs` is enforced but **not exact**: calls ran up to about 2 s of CPU over a 1 ms limit. The outbound Worker sees `fetch()` from the user Worker, **not from its Durable Object**. | Test and docs. |
| 5 | Added latency of the dispatch hop | **About +5 ms at p50** (+4.9 ms p50, +3.2 ms p95, +5.6 ms mean; N=300 each), measured from the Vultr runner in Chicago. The first tries from the laptop were too noisy to settle it. | Test (Vultr runner, `ord`). |

## What ran

`tests/wfp/` (all on `workers.dev`; no zone is routed):

- `terraform/`: the dispatch namespace `wp-on-cf-spike`, a D1 database, an R2 bucket and the secrets of the WordPress site. State is in R2 (`wp-on-cf-tfstate`, key `wfp/terraform.tfstate`).
- `user-min/`: a small user Worker with a SQLite-backed Durable Object, D1, R2 and Images bindings, and endpoints that use CPU and subrequests. It is uploaded twice, as `tenant-a` and `tenant-b`.
- `user-container/`: a user Worker with a Container class (`tenant-c`).
- `echo/`: a Worker that answers `ok`, uploaded twice: as a normal Worker and as a user Worker.
- `dispatcher/`: the dispatch Worker. `/<script>/<path>` runs `<path>` on that user Worker. Query options set custom limits (`cpuMs`, `subRequests`) and choose the binding with the outbound Worker. With the var `SITE_SCRIPT` it sends every path to one script (one hostname, one customer, as a platform does).
- `outbound/`: the outbound Worker. It marks each answer with `x-wfp-outbound`.
- `run.sh`: Terraform, then the uploads in order (the outbound Worker and the namespace scripts before the dispatcher that names them), then `check.py` and `latency.py`. A failed upload is recorded as a result.
- `dosql.sh`: builds the real `b-dosql` WordPress (`spikes/b2-wordpress`), uploads it into the namespace, puts a site dispatcher in front, installs WordPress and measures it.
- `container-app.sh`: makes the container application for a namespace script through the API (see item 2). It does nothing if the application exists.
- `run.sh` with `CONTAINER=1` runs the whole container test: `tenant-c` in the namespace (uploaded without a container rollout), its application through `container-app.sh`, and the same Worker as a normal Worker (`<prefix>-cdirect`) as the control.
- `list.sh`: lists from the API (read only) which of the spike's names exist; `destroy.sh` runs it at the end.
- `destroy.sh`: removes all of it, by exact name: the two container applications (by id from the API, for the names `tenant-c-box` and `<prefix>-cdirect-box` only), the namespace scripts, the workers.dev Workers (with the `dosql.sh` site dispatchers, `SITES`), then the Terraform resources.

## 1. Durable Objects with SQLite storage in a user Worker

**Docs.** The bindings page lists "Store data with KV, R2, D1, or Durable Objects" among what a user Worker can do. The limits page says "Workers for Platforms do not have a limit for the number of Durable Object namespaces." No WfP page says if SQLite storage (`new_sqlite_classes`) works in a user Worker. We did not read support into silence.

**Test** (`tests/wfp/results/wfp-20261105T215253Z.json`):

- `tenant-a` and `tenant-b` were uploaded with `wrangler deploy --dispatch-namespace wp-on-cf-spike`, with the migration `new_sqlite_classes = ["Counter"]`. Both uploads passed.
- `/tenant-a/do` uses `ctx.storage.sql`: the counter went 3, 4 on two calls; `/tenant-b/do` answered 2 at the same time. **Each user Worker has its own object and its own data.** `databaseSize` was 12288 bytes.
- The account's Durable Object namespace list (`GET /accounts/{id}/workers/durable_objects/namespaces`) shows one namespace per user script and class, named `<script>_<class>` (`tenant-a_Counter`, `tenant-b_Counter`, `tenant-c_Box`), each with `use_sqlite: true`.

**The real build** (`tests/wfp/dosql.sh`, `tests/wfp/results/dosql-20261105T222621Z.json`). The `b-dosql` WordPress, the variant from `deploy/` with PHP and its SQLite database in one Durable Object, was uploaded as the user Worker `wp-dosql`:

- The upload has 3665 static asset files and 46 MB of Worker modules (the PHP WebAssembly, WordPress, OPcache). The first upload, with all assets, took 96 s; a later upload took 28 s (wall time from `dosql.sh`).
- Through the site dispatcher: the install answered `installed` after 12 s (wall time); `e2e.sh` passed 17 of 17 requests; `tests/a/bench.py` (N=10, from the laptop) answered every page 10 of 10. The object's SQLite answered `/_dbping` with 0 ms per statement: below the clock resolution in the object.

| Page | Median (s), from the laptop | Queries |
| --- | --- | --- |
| home | 0.51 | 32 |
| post | 0.82 | 40 |
| search | 0.71 | 37 |
| dashboard | 0.67 | 47 |
| post-new | 1.02 | 72 |
| edit | 0.71 | 48 |

These times are from the laptop, so they do not compare with the Vultr runner numbers in `deploy/results/`.

**Open.**

- (a) The Durable Object namespace name is `<script>_<class>`. We did not test if a normal Worker and a namespace script with the same name share or collide.
- (b) **The page cache.** The limits page says that `caches.default` (the Cache API) is off in namespace scripts. `b-dosql` does not use `caches.default`: its page cache is the **Workers Cache** (`[cache] enabled = true` in its config, `cache-control` and `cache-tag` headers on the response, and `ctx.cache.purge({ tags })` in `spikes/b2-wordpress/index.js`). No WfP page says if the Workers Cache works in a namespace script, and we did not test it. This is open, and it matters: the page cache is half of what makes `b-dosql` fast for logged-out readers. The bench numbers above are fresh renders (`?nocache=`), so they do not depend on it.

  **Answered: yes, the Workers Cache works in a namespace script** (2026-11-06, `deploy/wfp` at `7655176`, the fourth day one, run by the lead, `deploy/wfp/results/day1-20261106T213116Z.json`).
  - **The probe** (below): the namespace script `site-cacheprobe`, through its dispatcher, answered `made` 1794000669915 with `MISS`, then the SAME `made` with `HIT` and `Age: 3`. The control `wp-cacheprobe-direct`, a normal Worker, did the same (1794000663471, `MISS`, then `HIT`, `Age: 3`). The verdict was "yes: the namespace script was served from the cache".
  - **`b-dosql`'s own page cache, in the same run:** a logged-out page of `site-one` (`/?wfpcache=<n>`) was `MISS`, then `HIT` with `Age: 2`.
  - **The first run's `MISS`, `MISS`** (below) is therefore not "off". The likely reason is the second read's timing against a cold cache, or the two reads reaching different locations. One pair of reads per run cannot tell which, and the probe makes that question moot.

  **First live read, inconclusive (2026-11-06, `deploy/wfp` day one at `b94e9ae`, run by the lead, `deploy/wfp/results/day1-20261106T204900Z.json`).** A logged-out page of the `b-dosql` site `site-one` (`/?wfpcache=<n>`, a fresh key) was read twice through its dispatcher. Both reads answered 200 with `cf-cache-status: MISS`, `cache-control: no-cache` and no `Age`. That does not decide it. `b-dosql` sends `cache-control: no-cache` from BOTH branches: on a page it caches (the edge rule is in `cloudflare-cdn-cache-control`, which Cloudflare consumes and does not pass on), and on a page where WordPress itself said `no-cache`, which it does not cache. So the reads cannot tell "the Workers Cache is off in a namespace script" from "this page was not cacheable".

  **The probe that decides it** (`deploy/wfp/cache-probe/`, `CACHE_PROBE=1` in `up.sh`, read by `check.py`): one tiny Worker with `[cache] enabled`, which answers JSON that says when it was made, with `cloudflare-cdn-cache-control: max-age=120`. It is deployed twice: as the namespace script `site-cacheprobe` behind the dispatcher copy `wp-cacheprobe`, and as the normal Worker `wp-cacheprobe-direct`, the control, where the Workers Cache is known to work (`docs/results.md`, B with the Workers Cache). Two reads of one fresh URL with the same `made` were served from the cache, whatever `cf-cache-status` says. The verdict is "yes", "no", or "inconclusive" when the control itself was not cached.

## 2. Containers from a user Worker

**Docs.** The bindings page says a user Worker can "Run containers with Containers (bound as a Durable Object)". No other WfP or Containers page says more.

**Test:**

1. `wrangler deploy --dispatch-namespace` with a `[[containers]]` block uploads the script, then fails: it looks the script up at `/accounts/{id}/workers/scripts/tenant-c/versions/<id>`, the path of normal Workers, and gets `This Worker does not exist on your account. [code: 10007]`. No container application is made. A call then answers "There is no container application assigned to this Durable Object namespace". (Wrangler 4.107.0.)
2. The upload with `--containers-rollout none` passes. `tests/wfp/container-app.sh` then makes the container application through the API, as Wrangler does for a normal Worker (`POST /accounts/{id}/containers/applications` with `durable_objects.namespace_id` = the namespace of `tenant-c_Box`). The API accepted it.
3. After that, a call through the dispatcher **starts a container**: the answers change to "The container just exited" (image `httpd:2.4`), then "The container is not listening in the TCP address 10.0.0.1:8080" (image `cloudflare/hello-world:1.0`), which means the container runs.
4. **Control:** the same Worker and the same images, deployed as a normal Worker with a Wrangler-made container application, gave the same answers. So the failure is the test image (its port), not WfP.

**Answered (2026-11-06, #43): a container of a user Worker answers HTTP.** Run by the lead from `7289258` with `CONTAINER=1 LATENCY_N=0 ./tests/wfp/run.sh` (`tests/wfp/results/wfp-20261106T023546Z.json`), with the image `tests/wfp/user-container/Dockerfile` (busybox `httpd` on port 8080):

- The control's normal deploy pushed `registry.cloudflare.com/<account>/wp-on-cf-wfp-cdirect-box@sha256:8390d887...`, and `container-app.sh` made `tenant-c`'s application with that image (the result file, `deploys`, entry `container-image`).
- The run's own two container calls came too early: both answered 503 "There is no Container instance available at this time" (the instance was not made yet).
- Then, by hand (the lead, with `curl`, 30 s apart; these calls are not in the result file): the control `<prefix>-cdirect/container` answered 200 "container in a user Worker" from the 2nd try (28 to 46 ms). **Through the dispatcher, `/tenant-c/container` answered 503 on tries 1 to 3 and 200 "container in a user Worker" on try 4 (1486 ms, a cold start).**
- So a new container application needs about 1.5 to 2 minutes before its first instance answers, for a user Worker as for a normal one. `check.py` now waits for it after the other checks (`container_1` repeats every `CONTAINER_EVERY` s, default 20, up to `CONTAINER_WAIT` s, default 240, and records the tries and the wait; `container_2` is then a warm call).
- All other checks of the run repeated the results above (SQLite Durable Object per tenant, D1, R2, Images, `subRequests` 2 of 6, the outbound Worker on, off and from the Durable Object, a missing script 404).
- **Teardown:** the first `destroy.sh` removed everything but the image; `list.sh` caught it (`container image wp-on-cf-wfp-cdirect-box EXISTS`, exit 1). The application holds the image by digest, and `destroy.sh` expected a tag. The lead deleted it by its exact name and only tag (`wp-on-cf-wfp-cdirect-box:cba7602e`); `list.sh` then read every name gone. `destroy.sh` now takes the tags from the registry listing by the exact repository name.

**Finding (2026-11-06, #43): the image cannot be pushed to the account registry on its own.** `wrangler containers build -p -t wfp-spike-box:1 tests/wfp/user-container` and `wrangler containers push wfp-spike-box:1` (Wrangler 4.107.0) both failed at the push: "push access denied, repository does not exist or may require authorization: insufficient_scope". The token had Workers Containers write, the registry credentials call answered, and a new `docker login` made no difference. Every image in the account registry is named `<worker>-<class>` and was pushed by `wrangler deploy` of a normal Worker with a `[[containers]]` image from a Dockerfile. So, as far as we could see, a new repository is made only by such a deploy; we found no documentation either way. A namespace user Worker cannot make it (Wrangler cannot deploy its container, item 2 above). **So a user Worker reuses an image that a normal Worker deploy pushed.**

`tests/wfp/run.sh` with `CONTAINER=1` does that: it deploys the control `<prefix>-cdirect` (a normal Worker) first, so Wrangler builds the Dockerfile and pushes `<prefix>-cdirect-box:<tag>` (this needs Docker); it reads that image from the control's container application, and gives it to `tenant-c`'s application through `container-app.sh`. `destroy.sh` deletes the applications and then that image (by its exact name and tag), and `list.sh` checks the image is gone:

```sh
CONTAINER=1 LATENCY_N=0 ./tests/wfp/run.sh   # BOX_PORT defaults to 8080 for the built image
./tests/wfp/destroy.sh                        # ends with list.sh
```

**For the design:** a platform that offers `c1` per customer must (1) make the container application through the API for each customer script (Terraform or the deploy script), not through Wrangler; (2) push each image through a normal Worker deploy (for example one build Worker per image) and give the customer's application that image; (3) expect about 1.5 to 2 minutes after an application is made before its first container answers, and a cold start (about 1.5 s here) after it sleeps.

## 3. D1, R2 and Images bindings, and how bindings attach

**Docs.** The bindings page: "When using the API to upload scripts, bindings must be specified in the `metadata` object of your multipart upload request." The upload API (`PUT /accounts/{id}/workers/dispatch/namespaces/{namespace}/scripts/{script}`) has binding types `d1` (`database_id`), `r2_bucket` (`bucket_name`), `images` and `durable_object_namespace`, and `migrations` with `new_sqlite_classes`. The static assets page and the platform examples page describe assets for namespace scripts (an upload session, then `assets.jwt` in the metadata).

**Test** (`tests/wfp/results/wfp-20261105T215253Z.json`): on `tenant-a`, `/d1` answered `{"one": 1}`, `/r2` wrote, read and deleted an object, `/images` read a 1x1 PNG (`image/png`, 1 by 1).

- `wrangler deploy --dispatch-namespace` reads the bindings, vars, migrations and `[assets]` from the Wrangler config and sends them in the metadata. `--secrets-file` set the secrets of `wp-dosql` in the same upload (WordPress used the salt to install and log in).
- D1 refuses `sqlite_version()` ("not authorized to use function"). This is D1, not WfP.

## 4. Limits per call, and the outbound Worker

**Docs.** Custom limits: "You can set limits for the maximum CPU time and number of subrequests per invocation. If a user Worker hits either of these limits, the user Worker will immediately throw an exception." The example is `env.dispatcher.get(workerName, {}, { limits: { cpuMs: 10, subRequests: 5 } })`. Outbound Workers: "Outbound Workers do not intercept fetch requests made from Durable Objects or mTLS certificate bindings", and with an outbound Worker the customer's Worker can no longer use `connect()`.

**Test, `subRequests`.** With `subRequests=2`, a user Worker that makes 6 `fetch()` calls: the first 2 answered 200, the next 4 threw "Too many subrequests by single Worker invocation". The user Worker can catch this exception, so the dispatcher sees a normal answer.

**Test, `cpuMs`** (`tests/wfp/results/cpu-limit-tail-20261105.txt`, CPU times from `wrangler tail`):

- Over the limit, the call failed with "Worker exceeded CPU time limit." (outcome `exceededCpu`). The dispatcher can catch it.
- But the limit is **not exact**. With `cpuMs=1`: calls used 418, 580 and 1447 ms of CPU and **finished**; one call stopped at 322 ms; two calls stopped at 2001 ms. With `cpuMs=3000`, a call used 3039 ms and finished. With `cpuMs=1000` and `cpuMs=4000`, longer burns stopped (wall time 3.4 s and 6.7 s; these two calls ran before the tail was on, so there is no CPU record).
- So a per-call `cpuMs` below about 2 s does not reliably bound a customer. The docs do not describe a grace or a granularity. A plan that sells small CPU limits cannot rely on `cpuMs` alone.

**Test, outbound Worker.** Through the binding with the outbound Worker (`outbound=1`), a `fetch()` from the user Worker came back marked `x-wfp-outbound: tenant-a` (the dispatcher's parameter reached the outbound Worker). Without it, no mark (control). A `fetch()` **from the user Worker's Durable Object** came back with no mark, as the docs say.

**For the design (#26).** In `b-dosql`, PHP runs in the Durable Object. So PHP's outbound HTTP does **not** pass the outbound Worker. Allowlists, metering and logging for PHP's HTTP calls must be in the user Worker's own code (the object can send its `fetch()` through the user Worker, which the outbound Worker sees), or in a service the object calls.

**A missing script.** `get()` of a script that is not in the namespace throws "Worker not found." (the dispatcher answers 404).

## 5. The dispatch hop's added latency

`tests/wfp/latency.py` calls the `echo` Worker direct and through the dispatcher, in turns (direct, then dispatched), each on its own kept-alive HTTPS connection, after 5 warm-up calls. Percentiles are nearest rank.

| Run (laptop) | N | Direct p50 / p95 (ms) | Dispatched p50 / p95 (ms) | Added p50 / p95 (ms) |
| --- | --- | --- | --- | --- |
| `wfp-20261105T214724Z.json` | 100 | 43.2 / 69.1 | 45.2 / 69.5 | +1.9 / +0.4 |
| `latency-laptop-20261105T222856Z.json` | 300 | 68.6 / 89.6 | 82.5 / 98.7 | +13.9 / +9.2 |

These two laptop runs were the first try. The direct time itself moved by 25 ms between them, so the laptop cannot settle a difference of a few ms. This is the reason for the Vultr runner.

**From the runner (the answer).** The same test as a runner job (`KIND=latency N=300 ./tests/bench-runner/run.sh <direct-url> <dispatched-url>`), from the Vultr box in Chicago (region `ord`, plan `vc2-2c-4gb`), on 2026-11-05 at 22:50 UTC, with the repository at `52ce048` (`deploy/results/bench-runner-20261105T224951Z-ff13d4.json`):

| Vantage | N | | p50 | p95 | p99 | mean | min | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Vultr `ord` | 300 | direct (ms) | 12.90 | 26.60 | 58.40 | 15.47 | 8.83 | 183.78 |
| Vultr `ord` | 300 | dispatched (ms) | 17.76 | 29.75 | 73.19 | 21.07 | 11.81 | 232.37 |
| | | **added (ms)** | **+4.86** | **+3.15** | | **+5.60** | | |

All 600 calls answered 200. The dispatch hop (the dispatch Worker, then `get()` and `fetch()` of the user Worker) adds about 5 ms at p50 and 3 ms at p95 to a trivial Worker. For a WordPress page of 0.5 s or more (item 1) that is about 1%. This is one run from one vantage, at one time of day; it does not include a cold user Worker (the warm-up calls ran first).

## Pricing and limits (docs)

From the pricing page:

- "The Workers for Platforms Paid plan is $25 monthly."
- 20 million requests included per month, then $0.30 per million.
- 60 million CPU milliseconds included per month, then $0.02 per million.
- 1000 scripts included, then $0.02 per script.
- "Workers for Platforms only charges for 1 request across the chain of dispatch Worker -> user Worker -> outbound Worker. CPU time is charged across these Workers."

From the limits page: "Gradual Deployments is not supported yet for user Workers." "For isolation, `caches.default` is disabled for namespaced scripts." Up to eight tags per script. The limits page says "an unlimited number of scripts", and the pricing page includes 1000 and charges for more; the pages do not explain the difference.

## Reproduce and remove

The spike was removed on 2026-11-05 after the runner measurement: `destroy.sh` ended with `list.sh` showing every name as gone (namespace, five Workers, two container applications, D1, R2), and the Terraform state is empty. The other dispatch namespaces in the account were not changed. To run it again:

```sh
export CLOUDFLARE_API_TOKEN=...   # Workers Scripts, R2, D1, Containers edit; account settings read
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...   # the state bucket key
./tests/wfp/run.sh                     # namespace, test Workers, checks, laptop latency
CONTAINER=1 LATENCY_N=0 ./tests/wfp/run.sh   # the container test and its control
./tests/wfp/dosql.sh                   # the real b-dosql site in the namespace
./tests/wfp/destroy.sh                 # everything above
```

## Pages read (2026-11-05)

| Page | Last updated (as shown) |
| --- | --- |
| [WfP overview](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/) | 2026-10-15 |
| [Bindings](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/) | 2026-10-31 |
| [Custom limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/custom-limits/) | 2026-04-21 |
| [Outbound Workers](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/) | 2026-04-21 |
| [Dynamic dispatch](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/) | 2026-10-31 |
| [Static assets](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/static-assets/) | 2026-10-12 |
| [Limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/) | 2026-11-03 |
| [Pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/) | 2026-04-21 |
| [Worker isolation](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/worker-isolation/) | 2026-04-21 |
| [Platform examples](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/platform-examples/) | 2026-05-05 |
| [Upload a namespace script (API)](https://developers.cloudflare.com/api/resources/workers_for_platforms/subresources/dispatch/subresources/namespaces/subresources/scripts/methods/update/) | not shown |
| [Multipart upload metadata](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/) | 2026-10-28 |
| [Containers](https://developers.cloudflare.com/containers/), [FAQ](https://developers.cloudflare.com/containers/faq/), [Limits](https://developers.cloudflare.com/containers/platform/limits/) | 2026-10-12, 2026-10-05, 2026-11-02 |
