# Workers for Platforms: what works (verification spike)

Issue #35 asks for a reference deployment for a Workers for Platforms (WfP) user: a dispatch Worker, one user Worker per site, all as code. This page answers the "Verify first" list of #35 with evidence. It is not the design. The design comes after this, in #35.

Each answer names its source: a Cloudflare documentation page (read on 2026-11-05; the page's own "last updated" date is in the table at the end) or a test in `tests/wfp/` that ran on 2026-11-05 on the Skyphusion Labs account (Workers Paid, WfP already on). The result files are in `tests/wfp/results/`.

## Summary

| # | Question | Answer | Evidence |
| --- | --- | --- | --- |
| 1 | Durable Objects with SQLite storage in a user Worker | **Yes.** The real `b-dosql` WordPress runs as a user Worker: install, `e2e.sh` 17 of 17, all bench pages 10 of 10. Two tenants have separate objects and data. | Test. The docs do not say it. |
| 2 | Containers from a user Worker | **Partly shown.** The platform starts a container for a user Worker's Durable Object class, the same as for a normal Worker. Wrangler cannot make the container application for a namespace script; the API can. An HTTP answer from the container is not shown yet (test image problem, the same in the control). | Test. The docs say "Run containers" and no more. |
| 3 | D1, R2 and Images bindings; how bindings attach | **Yes, all three.** Bindings go in the upload metadata. `wrangler deploy --dispatch-namespace` writes them from the Wrangler config, with secrets (`--secrets-file`) and static assets. | Test and docs. |
| 4 | Limits per call; the outbound Worker | `subRequests` is exact. `cpuMs` is enforced but **not exact**: calls ran up to about 2 s of CPU over a 1 ms limit. The outbound Worker sees `fetch()` from the user Worker, **not from its Durable Object**. | Test and docs. |
| 5 | Added latency of the dispatch hop | **Not settled.** From the laptop: +1.9 ms (p50) in one run, +13.9 ms in another; the laptop's own noise is larger than the effect. The Vultr runner can now run this test (`KIND=latency`); its box must be replaced first. | Test (laptop only). |

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
- `container-app.sh`: makes the container application for a namespace script through the API (see item 2).
- `destroy.sh`: removes all of it.

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

**Open.** (a) The Durable Object namespace name is `<script>_<class>`: we did not test if a normal Worker and a namespace script with the same name share or collide. (b) WfP turns off `caches.default` in namespace scripts (limits page). The `b-dosql` page cache uses the Workers cache; we did not check if it caches in a namespace script.

## 2. Containers from a user Worker

**Docs.** The bindings page says a user Worker can "Run containers with Containers (bound as a Durable Object)". No other WfP or Containers page says more.

**Test:**

1. `wrangler deploy --dispatch-namespace` with a `[[containers]]` block uploads the script, then fails: it looks the script up at `/accounts/{id}/workers/scripts/tenant-c/versions/<id>`, the path of normal Workers, and gets `This Worker does not exist on your account. [code: 10007]`. No container application is made. A call then answers "There is no container application assigned to this Durable Object namespace". (Wrangler 4.107.0.)
2. The upload with `--containers-rollout none` passes. `tests/wfp/container-app.sh` then makes the container application through the API, as Wrangler does for a normal Worker (`POST /accounts/{id}/containers/applications` with `durable_objects.namespace_id` = the namespace of `tenant-c_Box`). The API accepted it.
3. After that, a call through the dispatcher **starts a container**: the answers change to "The container just exited" (image `httpd:2.4`), then "The container is not listening in the TCP address 10.0.0.1:8080" (image `cloudflare/hello-world:1.0`), which means the container runs.
4. **Control:** the same Worker and the same images, deployed as a normal Worker with a Wrangler-made container application, gave the same answers. So the failure is the test image (its port), not WfP.

**Not shown yet:** an HTTP answer from a container of a user Worker. The next step is an image with a known port (for example `FROM busybox` with `httpd -f -p 8080`), built with Docker; the spike seat has no Docker access.

**For the design:** a platform that offers `c1` must make the container application through the API for each customer script (Terraform or the deploy script), not through Wrangler.

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

The direct time itself moved by 25 ms between the runs, so the laptop cannot settle a difference of a few ms. This is the reason for the Vultr runner.

**From the runner.** `tests/bench-runner` now takes a latency job: `KIND=latency ./tests/bench-runner/run.sh <direct-url> <dispatched-url>` (N default 100). The job runner script is part of the box's `user_data`, so this needs a new box (`./tests/bench-runner/tf.sh apply` replaces it). Not run yet.

## Pricing and limits (docs)

From the pricing page:

- "The Workers for Platforms Paid plan is $25 monthly."
- 20 million requests included per month, then $0.30 per million.
- 60 million CPU milliseconds included per month, then $0.02 per million.
- 1000 scripts included, then $0.02 per script.
- "Workers for Platforms only charges for 1 request across the chain of dispatch Worker -> user Worker -> outbound Worker. CPU time is charged across these Workers."

From the limits page: "Gradual Deployments is not supported yet for user Workers." "For isolation, `caches.default` is disabled for namespaced scripts." Up to eight tags per script. The limits page says "an unlimited number of scripts", and the pricing page includes 1000 and charges for more; the pages do not explain the difference.

## Reproduce and remove

```sh
export CLOUDFLARE_API_TOKEN=...   # Workers Scripts, R2, D1, Containers edit; account settings read
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...   # the state bucket key
./tests/wfp/run.sh                     # namespace, test Workers, checks, laptop latency
CONTAINER=1 LATENCY_N=0 ./tests/wfp/run.sh
./tests/wfp/container-app.sh tenant-c Box docker.io/cloudflare/hello-world:1.0 lite
./tests/wfp/dosql.sh                   # the real b-dosql site in the namespace
./tests/wfp/destroy.sh                 # everything above
```

`destroy.sh` does not delete the container applications that `container-app.sh` made; delete them with `wrangler containers delete <id>`.

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
