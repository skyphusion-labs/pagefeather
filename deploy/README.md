# Deploy a WordPress site on Cloudflare, then measure it

One command makes the site, installs WordPress and measures it. Everything the site needs is code: Terraform makes the data plane, Wrangler deploys the code from a config that the script writes from the Terraform outputs. You do not copy an id by hand, and you do not click in a dashboard.

```sh
export CLOUDFLARE_API_TOKEN=...   # Workers Scripts, D1 (and R2 if MEDIA=1)
export ACCOUNT_ID=...
NAME=my-site ./deploy/deploy.sh
```

At the end the script prints the site address, the D1 time per statement, the `e2e.sh` result and the page times, and writes them to `deploy/results/<name>-<time>.json`. Remove the site with `NAME=my-site ./deploy/destroy.sh`.

## The variants

`VARIANT` picks the design. Measured with this script on 2026-11-05 (one run each, from a laptop; numbers from a fixed Vultr runner will replace them). Uncached median seconds, 10 fresh renders per page.

| `VARIANT` | PHP runs in | Database | Plan | Home | Post | Dashboard | Editor | Database per statement | Result file |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `b-dosql` | a Durable Object | the same object's SQLite | Free | 0.73 | 0.67 | 1.11 | 1.40 | below the clock (no network) | `results/wp-ref-dosql-*.json` |
| `a` | the Worker | MySQL through Hyperdrive (`deploy/mysql`) | Paid | 0.87 | 0.96 | 1.03 | 1.96 | 8 to 9 ms | `results/wp-ref-a-*.json` |
| `c1` | a Container | SQLite on the container disk, Litestream to R2 | Paid | 0.84 | 1.09 | 1.07 | 3.17 | (not reported yet) | `results/wp-c1-*.json` |
| `b-do` | a Durable Object | D1, same location hint | Free | 1.89 | 1.71 | 1.62 | 3.49 | 10 to 13 ms | `results/wp-ref-do-*.json` |

Every variant passed `e2e.sh` 17 of 17 after a fresh install. `c1`: first start 85 s (image and install), cold start 22 s.

## What it makes (variant `b-do`)

| Part | Made by | Where |
| --- | --- | --- |
| D1 database (WordPress tables) | Terraform | `deploy/terraform/main.tf`. Primary in region `LOCATION`. |
| Secrets (salt, spike token, admin password) | Terraform (`random_password`) | Terraform state. Sent to the Worker with `wrangler secret bulk`. |
| R2 bucket for the media library (`MEDIA=1`) | Terraform | `deploy/terraform/main.tf` |
| Worker and the PHP Durable Object | Wrangler | `spikes/b2-wordpress`, config `wrangler.deploy.<name>.toml` (written by `deploy.sh`) |
| WordPress install | `deploy.sh` (`/_install`) | Runs inside the PHP object |

The Worker serves static files and the page cache. Every request that needs PHP goes to one Durable Object, which runs WordPress in PHP (WebAssembly) and talks to D1. This runs on Workers Free: the Worker uses 1 to 4 ms of CPU per request (the Free limit is 10 ms), and the object has the CPU for PHP. Measured on 2026-11-05 on a Free account; see [docs/approach-b.md](../docs/approach-b.md) section 8i.

## Variant `c1`: WordPress and WooCommerce in a Container (Workers Paid only)

```sh
export CLOUDFLARE_API_TOKEN=...   # see "Token for c1" below
export ACCOUNT_ID=...             # an account on Workers Paid
VARIANT=c1 NAME=my-shop ./deploy/deploy.sh
```

Containers are on Workers Paid only. On Workers Free the deploy fails. The code is `spikes/c1-woo-container`; [docs/approach-c1.md](../docs/approach-c1.md) explains it and has the measurements.

| Part | Made by | Where |
| --- | --- | --- |
| R2 bucket `<name>-db` (the Litestream replica of the SQLite file) | Terraform | `deploy/terraform/c1.tf`. Location hint `LOCATION`. |
| R2 bucket `<name>-media` (uploads) | Terraform | `deploy/terraform/main.tf`. Always made for c1. |
| R2 key for Litestream: object read and write on `<name>-db` only | Terraform (`cloudflare_account_token`) | `deploy/terraform/c1.tf`. The S3 access key id is the token id; the secret is the SHA-256 of the token value. |
| Secrets (salt, admin password, ops token) | Terraform (`random_password`) | Terraform state. Sent with `wrangler deploy --secrets-file`, in the same version as the code. |
| Worker, the container application `<name>-store` and its Durable Object | Wrangler | `spikes/c1-woo-container`, config `wrangler.deploy.<name>.toml` (written by `deploy/variants/c1-config.sh`) |
| WordPress and WooCommerce install | The first container | `php/install.php`, when the replica bucket is empty |

There is no D1 database for c1. WordPress uses SQLite on the container disk, and Litestream copies every change to `<name>-db` (1 s interval). The container has no key for the media bucket: the Worker serves and writes uploads through its R2 binding.

What `deploy.sh` does for c1 (`deploy/variants/c1.sh`):

1. Terraform: the buckets, the Litestream key and the secrets.
2. Build the image tree (`spikes/c1-woo-container/build.sh`).
3. Write the Wrangler config from the Terraform outputs. `PUBLIC_HOST` is `<name>.<subdomain>.workers.dev`; the script reads the subdomain from the API before the deploy, because WordPress uses it as its address.
4. `wrangler deploy --secrets-file ... --containers-rollout immediate`. Wrangler builds the image with Docker, so Docker must run on the machine.
5. Wait `ROLLOUT_WAIT` (60 s), then stop the container once (`POST /_store-stop`). A container that starts within about a minute of a deploy can run the old image; the next request starts one from the new image. On a new site there is no container yet, and the stop does nothing.
6. Wait for `GET /` to answer 200 (`first_start_s`). On a new site this includes the install.
7. `e2e.sh`, `tests/a/bench.py`, then one cold start: stop the container and time until a new container (a new id in `/_boot.txt`) restored the database from R2 and answers `GET /` (`cold_start_s`).

The query count per page comes from the mu-plugin `php/query-count.php`: it sends `x-d1-calls`, the header the harness reads, with the number of SQLite queries of the request. C1 sends no database time per query (the SQLite driver times queries only with `SAVEQUERIES`), so `db_ms` for C1 is empty, not 0.

### c1 options

| Variable | Default | Meaning |
| --- | --- | --- |
| `INSTANCE_TYPE` | `standard-1` | Container instance type. c1 is CPU bound: about 3 requests per second on `standard-1` (1/2 vCPU, 4 GiB), about 6 on `standard-2` (1 vCPU, 6 GiB), measured with APCu (docs/approach-c1.md). |
| `PHP_WORKERS` | 2 on `basic`, 4 on `standard-1`, 8 on `standard-2` | PHP processes, 256 MB each. `basic` (1 GiB) dropped a connection with 4. |
| `IDLE_SECONDS` | `900` | The container stops itself after this many seconds with no request (see below). |
| `OBJECT_CACHE` | `apcu` | `apcu`: the APCu object cache drop-in (about 20 % less CPU per page, docs/approach-c1.md). `none`: no object cache. |
| `REPLICA_PATH` | `store` | Path of the Litestream replica in the replica bucket. Another path restores and writes another database; `store` stays as it was. |
| `QUEUE_RUNNER` | `local` | `local`: WP-Cron and Action Scheduler run from inside the container every `CRON_SECONDS` (60), and the Action Scheduler async loopback is off (issue #45). `loopback`: the loopback, as before. |
| `PAGE_CACHE_TTL` | `120` | Seconds a storefront page stays fresh at the edge (visitors with no cart, session or login; docs/approach-c1.md, Storefront edge cache). A change purges it sooner. |
| `PAGE_CACHE_SWR` | `600` | Seconds after that during which the edge serves the old copy while it renders a new one |
| `QUEUE_LIMIT` | `16` | Requests the container may have in hand before a page, cart or add to cart gets 503 with Retry-After (0 = no limit). Checkout, payment callbacks and admin are always let in (docs/approach-c1.md, Bounded queue). |
| `RETRY_AFTER` | `5` | The Retry-After seconds of that 503 |
| `WARM_START` | `off` | `product`: a product view (`/product/`, `/shop`, a product category or tag) starts the sleeping container in the background, so the first cart after a sleep is warm. At most once per `WARM_GAP_S` (`60`). `WARM_PATHS` (a regular expression) replaces the product paths. Cost: a container that would have slept stays awake up to `IDLE_SECONDS`. Issue #73; not measured yet. |
| `CHECK_WAIT` | `600` | Seconds to wait after the deploy until the Store object is from this deploy (c1_check) |
| `PUBLIC_HOST` | `<name>.<subdomain>.workers.dev` | The address WordPress uses |
| `ROLLOUT_WAIT` | `60` | Seconds to wait after the deploy before the one stop |
| `START_TIMEOUT` | `900` | Seconds to wait for the first 200 |

### How the container sleeps

The container disk is lost when the container stops. The next request starts a new container, which restores the database from `<name>-db` (`litestream restore`), then serves.

The `sleepAfter` of the Container class did not stop the container (measured 2026-11-04, docs/approach-c1.md). So the container stops itself: every request except `/ping` and `/_boot.txt` marks the time, and a loop in `container/entrypoint.sh` checks once a minute. After `IDLE_SECONDS` with no request it sends SIGTERM to Litestream, which finishes its sync, and the container exits. Platform health checks hit `/ping`, so they do not keep it awake.

### What c1 costs

From [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/), read 2026-11-05. Memory and disk bill for the provisioned size of the instance type while the container runs; CPU bills only while busy.

| | Included in Workers Paid each month | Then |
| --- | --- | --- |
| Memory | 25 GiB-hours | $0.0000025 per GiB-second |
| CPU | 375 vCPU-minutes | $0.000020 per vCPU-second |
| Disk | 200 GB-hours | $0.00000007 per GB-second |

`standard-1` is 1/2 vCPU, 4 GiB memory, 8 GB disk. The 25 included GiB-hours are about 6 awake hours of `standard-1` a month (about 25 of `basic`, 1 GiB). After that, an awake `standard-1` is about $0.038 an hour for memory and disk ($0.036 + $0.002), about $27 for a month awake all the time, plus CPU while busy. A site that sleeps (`IDLE_SECONDS`) bills only for its awake hours. R2 storage and operations for the two buckets bill as R2.

### Token for c1

The token in `CLOUDFLARE_API_TOKEN` must be able to: deploy Workers (Workers Scripts edit), make Containers and push their image, make R2 buckets (Workers R2 Storage edit), and make an account API token (Account API Tokens edit), because Terraform makes the Litestream key. Without the last one, `terraform apply` fails at `cloudflare_account_token.litestream`.

### Remove a c1 site

```sh
NAME=my-shop ./deploy/destroy.sh
```

`destroy.sh` reads the variant from `deploy/terraform/sites/<name>.tfvars` and runs `deploy/variants/c1-destroy.sh`: it deletes the container application `<name>-store`, then the Worker, then empties both buckets (R2 refuses to delete a bucket that has objects), then Terraform deletes the buckets, the Litestream key and the secrets. To empty the media bucket, Terraform first gives the Litestream key that bucket too (`teardown = true`); the Worker and the container are deleted at that point. The database replica and the uploads are deleted. Nothing is kept.

## Variant `b-dosql`: the database in the PHP object

The same Worker and PHP object as `b-do`, with `DB_IN_DO=on`: each statement runs on the object's own SQLite storage (`ctx.storage.sql`), so a query is not a network call. There is no D1. One object holds the site: one writer, data in the object, point-in-time recovery for 30 days ([Durable Objects](https://developers.cloudflare.com/durable-objects/)). Move a site in or out with `spikes/b2-wordpress/dbmove.py` (`/_dbexport`, `/_dbimport`). Details: [docs/approach-b.md](../docs/approach-b.md) section 8j.

To import an existing WordPress site from a mysqldump, use `deploy/import.sh`: see [deploy/import/README.md](import/README.md).

On Workers Free the object's SQLite has daily limits: 5 million rows read and 100,000 rows written (a public page reads about 160 to 220 rows; an admin page writes about 30 to 40). A page cache hit costs neither.

## Variant `a`: PHP in the Worker, MySQL through Hyperdrive (Workers Paid)

```sh
VARIANT=a MYSQL=vultr VULTR_API_KEY=... MYSQL_ZONE_ID=<zone> MYSQL_HOST=mysql-mysite.example.com NAME=my-site ./deploy/deploy.sh
```

`MYSQL=vultr` makes the database box with `deploy/mysql` (MariaDB with SSL; port 3306 open to Cloudflare's IPv4 ranges only; no SSH; $10 a month). `MYSQL=external` uses your own server: `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`; it must have SSL. Give Hyperdrive the host **name**: by IP address it measured about 44 ms per query, by name about 7 ms ([docs/approach-a.md](../docs/approach-a.md)). On Workers Free this variant stops at the CPU limit.

## Why `LOCATION` matters

`LOCATION` is the location hint for both the D1 primary and the PHP object. The same hint puts them in the same region. Measured on 2026-11-05 (`tests/do/probe`): 14 to 20 ms per D1 statement in the same region, 38 to 60 ms in different regions. A page makes 30 to 70 statements. Pick the region of your readers: `enam` (Eastern North America), `wnam`, `weur`, `eeur`, `apac`, `oc`.

The hint is not a promise. An `enam` object landed in EWR two times in three and in ORD once. The script measures D1 from the object after the install (`/_d1ping`), so you see where it landed.

## Options

| Variable | Default | Meaning |
| --- | --- | --- |
| `NAME` | (required) | Site name: the Worker, the D1 database and the bucket |
| `LOCATION` | `enam` | Region hint for D1 and the PHP object |
| `MEDIA` | `0` | `1` makes an R2 bucket for uploads. Without it, uploads do not persist. R2 must be turned on for the account first. |
| `BENCH` | `1` | `0` skips the measurements |
| `N` | `10` | Runs per page in the page benchmark |
| `VARIANT` | `b-do` | `b-do`, `b-dosql`, `a`, `c1` (see above) |
| `SITE_ORIGIN` | `https://<name>.<subdomain>.workers.dev` | The site's own address (`scheme://host[:port]`). WordPress's `WP_HOME` and every link come from it, not from the first request (issue #33). Give it for a custom domain. On workers.dev the deploy stops if Wrangler's address differs. `c1` uses `PUBLIC_HOST` instead. |
| `DEPLOY_STATE` | `local` | `r2` keeps Terraform state in an R2 bucket (`STATE_BUCKET`, `STATE_ENDPOINT`, and an R2 key in `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) |

Each `NAME` has its own Terraform workspace, so two sites never share state.

## Terraform state holds secrets

The admin password, the salt and the spike token are in the state. Keep it private: the local state is in `deploy/terraform/terraform.tfstate.d/` (ignored by git). To read the admin password:

```sh
cd deploy/terraform && terraform workspace select my-site && terraform output -raw admin_password
```

## What is measured

| Measure | How |
| --- | --- |
| D1 per statement, from where PHP runs | `/_d1ping`: 20 reads, three times |
| Pages and admin work end to end | `spikes/b2-wordpress/e2e.sh` (17 requests: pages, login, editor, a REST write) |
| Uncached page times | `tests/a/bench.py`: home, a post, search, dashboard, editor, posts list; 10 fresh renders each; median, queries and database time per page |

## Not yet in this directory

- Variant: approach B in a plain Worker on Workers Paid.
- Measurements from a fixed vantage (a Vultr runner), with p95 and p99, concurrency and the cold path.
- Plugins and WooCommerce runs (`tests/plugins/plugins.py`, `tests/woo.py`) as part of `deploy.sh`.
- A custom domain. The site is on `<name>.<subdomain>.workers.dev`.
- The SSH import (`SSH=`, `deploy/import/README.md`) run against a real server, and `a` on MariaDB with a separate target (issue #31). `b-dosql`, `c1`, `a` and `a2` have the import from a dump and a `wp-content` archive, or from a server over SSH.
