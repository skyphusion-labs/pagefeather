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
5. Wait for the container rollout of the deploy to complete (issue #106): the containers API, application `<NAME>-store`, the newest rollout whose `target_version` is the application's `version`, until its `status` is `completed`. The application's version moves only when a rollout completes (issue #126, measured on `wp-c1-w92b`: version 2 for about 6 minutes while "2 -> 3" ran). So when a rollout starts FROM that version (`current_version` is the version, `target_version` above it), the deploy follows the newest such rollout. A `reverted` rollout, a `replaced` one with no rollout from its version for `ROLLOUT_REPLACED_POLLS` reads, or none completed in `ROLLOUT_TIMEOUT`, fails the deploy. The version comes from `GET .../applications/<id>` on each read (the list answer is stale), and a new application at version 1 with no rollout at all counts as placed. If the API cannot be read 3 times in a row, it waits a fixed `ROLLOUT_WAIT` instead and says so. Then stop the container once (`POST /_store-stop`). A container that starts before the rollout ends runs the old image; the next request starts one from the new image. On a new site there is no container yet, and the stop does nothing.
6. Wait for `GET /` to answer 200 (`first_start_s`). On a new site this includes the install.
7. `e2e.sh`, `tests/a/bench.py`, then one cold start: stop the container and time until a new container (a new id in `/_boot.txt`) restored the database from R2 and answers `GET /` (`cold_start_s`).

The query count per page comes from the mu-plugin `php/query-count.php`: it sends `x-d1-calls`, the header the harness reads (the Worker sends it only on a request with the valid `x-spike-token`, or on every request when `PERF_HEADERS=on`; the harness sends `SPIKE_TOKEN` when it is set), with the number of SQLite queries of the request. C1 sends no database time per query (the SQLite driver times queries only with `SAVEQUERIES`), so `db_ms` for C1 is empty, not 0.

### c1 options

| Variable | Default | Meaning |
| --- | --- | --- |
| `INSTANCE_TYPE` | `standard-1` | Container instance type. c1 is CPU bound: about 3 requests per second on `standard-1` (1/2 vCPU, 4 GiB), about 6 on `standard-2` (1 vCPU, 6 GiB), measured with APCu (docs/approach-c1.md). |
| `PHP_WORKERS` | 2 on `basic`, 4 on `standard-1`, 8 on `standard-2` | PHP-FPM children (issue #99; PHP built-in server processes before), 256 MB each. `basic` (1 GiB) dropped a connection with 4. |
| `IDLE_SECONDS` | `900` | The container stops itself after this many seconds with no request (see below). |
| `OBJECT_CACHE` | `apcu` | `apcu`: the APCu object cache drop-in (about 20 % less CPU per page, docs/approach-c1.md). `none`: no object cache. |
| `REPLICA_PATH` | `store` | Path of the Litestream replica in the replica bucket. Another path restores and writes another database; `store` stays as it was. |
| `QUEUE_RUNNER` | `local` | `local`: WP-Cron and Action Scheduler run from inside the container every `CRON_SECONDS` (10), and the Action Scheduler async loopback is off (issue #45). `loopback`: the loopback, as before. |
| `AS_TIME_LIMIT` | `5` | Seconds one queue run may take (Action Scheduler's default is 30). A long run holds one PHP server process, and a shopper whose connection lands there waits for it. |
| `PAGE_CACHE_TTL` | `120` | Seconds a storefront page stays fresh at the edge (visitors with no cart, session or login; docs/approach-c1.md, Storefront edge cache). A change purges it sooner. |
| `PAGE_CACHE_SWR` | `600` | Seconds after that during which the edge serves the old copy while it renders a new one |
| `QUEUE_LIMIT` | `16` | Requests the container may have in hand before a page, cart or add to cart gets 503 with Retry-After (0 = no limit). Checkout, payment callbacks and admin are always let in (docs/approach-c1.md, Bounded queue). |
| `RETRY_AFTER` | `5` | The Retry-After seconds of that 503 |
| `FLOW_LIMIT` | 2 x `QUEUE_LIMIT` | The higher cap for a shopper already in a cart flow (a Cart-Token or a WooCommerce session); never below `QUEUE_LIMIT` |
| `CONTAINER_TIMEOUT_S` | `60` | Seconds a shopper request (pages, cart, checkout, payment callbacks) or an operator request (`/_*`) waits for the container to answer before a 504 and its queue slot back (0 = no limit, issue #93). |
| `CONTAINER_EXEMPT_TIMEOUT_S` | `900` | The same for wp-admin, wp-login.php, logged-in users and REST with an Authorization header, which can be long (an import, an export). Never unbounded by default: unbounded requests to a dead container pinned the Store object to an old deploy (issue #105). 0 = no limit. |
| `WARM_START` | `off` | `product`: a product view (`/product/`, `/shop`, a product category or tag) starts the sleeping container in the background, so the first cart after a sleep is warm. At most once per `WARM_GAP_S` (`60`). `WARM_PATHS` (a regular expression) replaces the product paths. Cost: a container that would have slept stays awake up to `IDLE_SECONDS`. Issue #73: the first add to cart after a sleep, median 10.0 s with `off` and 5.1 s with `product` (3 trials each, docs/approach-c1.md). |
| `WARM_WP` | `on` | After every container start, one request from inside the container (`container/warm.php`, through nginx on `127.0.0.1:8081` only) boots WordPress and WooCommerce in PHP-FPM and compiles the Store API files, so the first shopper request finds OPcache and APCu warm. It writes nothing and sends no cookie. Issue #92: in the clean warm-start trial the first PHP request took 5.04 s and the next 0.26 s (docs/approach-c1.md). The boot log shows `warm: start` and `warm: done {...}`. |
| `CHECK_WAIT` | `600` | Seconds to wait after the deploy until the Store object is from this deploy (c1_check) |
| `PUBLIC_HOST` | `<name>.<subdomain>.workers.dev` | The address WordPress uses |
| `ROLLOUT_TIMEOUT` | `600` | Seconds to wait for the container rollout to complete |
| `ROLLOUT_POLL_S` | `10` | Seconds between two reads of the rollout |
| `ROLLOUT_REPLACED_POLLS` | `6` | Reads of a `replaced` rollout with no rollout from its version (and no newer version) before the deploy fails |
| `ROLLOUT_WAIT` | `60` | The fallback: seconds to wait before the one stop when the containers API cannot be read |
| `START_TIMEOUT` | `900` | Seconds to wait for the first 200 |
| `BOOT_LOG_WAIT` | `180` | Seconds after a container is first seen running until its boot log must exist in the replica bucket |
| `STALL_S` | `300` | Seconds with no new boot log line and no 200 before the deploy fails the start as stuck |

The wait for the first 200 also reads the boot log (issue #103, `deploy/variants/c1-bootwatch.py`). The container PUTs it to the replica bucket as `<REPLICA_PATH>.boot-<start epoch>.log` (`container/bootlog.sh`). The deploy reads the newest log with a start epoch at or after the stop (less 10 s for the clocks), with the Litestream key, and prints each new line as `boot: ...`. It fails before `START_TIMEOUT` in two cases:

- A container runs (`running` in `/_store-info`), but there is no such log `BOOT_LOG_WAIT` s after it was first seen running: the container did not reach `bootlog.sh`. While the platform has placed no container (`running` false), the deploy waits on, up to `START_TIMEOUT`, and then says that the platform started no container, which is a placement or start problem that a redeploy does not fix (issue #120: a new application's first container came after 4 minutes on 2026-11-06). That message also shows each distinct error the containers API gave during the rollout wait, and the API's state now, so the log names the platform as the cause. If `/_store-info` cannot be read, `BOOT_LOG_WAIT` counts from the stop, and the deploy says so.
- The log got no new line for `STALL_S` s and there is still no 200: the start stopped. The message shows the last line, which is the last step that ran.

Every failure names the answers that the `GET /` probes got (for example `probes 36 (503 x36)`). Both stuck messages give the recovery for a stuck container (a deploy with a changed `INSTANCE_TYPE`, issue #93). If the bucket cannot be listed (for example a 403), the deploy says so once and waits only for the 200, up to `START_TIMEOUT`, as before. The stall age is measured on the laptop, from when the deploy last saw the log grow, so a container clock that is off does not change it. The log is uploaded every 10 s for 10 minutes and then every 60 s, so `STALL_S` must stay well above 60 s. The longest silent step is the install on a new site, which now has a line before and after it; a whole first start on a new site took 98 s on 2026-11-06 (`docs/results.md`).

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

The token in `CLOUDFLARE_API_TOKEN` must be able to: deploy Workers (Workers Scripts edit), make Containers and push their image, make R2 buckets (Workers R2 Storage edit), and make an account API token (Account API Tokens edit), because Terraform makes the Litestream key. Without the last one, `terraform apply` fails at `cloudflare_account_token.litestream`. The deploy also reads the container rollout (`c1_wait`, issue #106); "Workers Containers Write", which making Containers needs, is enough for that (read 2026-11-06: applications and rollouts both 200 with a token that had only that group).

### Mail for b-dosql

`b-dosql` has no mail program either. `php/wp-mail-queue.php` hands each `wp_mail()` to the Worker, which sends it with the `send_email` binding after the request. The From address is `MAIL_FROM` when you set it. When you do not, and the site host is a domain that can send (not `workers.dev`), the address is `wordpress@<that host>`. A `workers.dev` site sends nothing until you set `MAIL_FROM`. The display name is `MAIL_FROM_NAME` only. It is not the name WooCommerce, and it is not `wordpress@skyphusionwp.dev`, unless you set that address yourself for a demo.

The binding can send from that one address. A different From on the message becomes the Reply-To, except an address that cannot receive mail (`example.com`, `workers.dev`, and the other reserved names). The domain has to be onboarded for Email Sending or the send fails. The c1 mail section below says how to onboard a domain. `skyphusionwp.dev` is one such domain only when you set `MAIL_FROM` to an address on it.

### Mail for c1 (issue #104)

The container has no mail program. `php/c1-mail.php` (a mu-plugin on `pre_wp_mail`) sends each `wp_mail()` to the Worker through the outbound path (`http://worker.internal/`). The Store object then sends it with a [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) `send_email` binding. Without the settings below, the site sends no mail, and every `wp_mail()` returns false with the code `c1_mail_not_configured`. The failure fires `wp_mail_failed` and is counted in `/_store-info` (`mail`) and `/_stats.php?what=mail`. Mail is never lost in silence.

Before you deploy:

1. Your sending domain must use Cloudflare DNS, on the same account. Email Sending is in beta and needs Workers Paid to send to any address: 3,000 messages a month are included, then $0.35 per 1,000 (Email Service pricing, read 2026-11-06).
2. Onboard the domain or a subdomain for sending. Wrangler 4.107 can do it: `deploy/wr email sending enable mail.example.com`, or `./deploy/email-sending.sh enable mail.example.com`. The dashboard can too: Email Service, Email Sending, Onboard Domain. This adds DNS records: an MX, an SPF TXT and a DKIM TXT on a `cf-bounce` name, and a DMARC TXT on `_dmarc`. Read them with `deploy/wr email sending dns get mail.example.com`, or `./deploy/email-sending.sh status mail.example.com` for the account list. A subdomain keeps the records off your main domain, so mail already set up there is not changed. `skyphusionwp.dev` is the demo sending domain for this repository when `MAIL_FROM` is an address on it. Onboarding it is a zone change. The script does not run it for you.
3. Set `MAIL_FROM` to an address on that domain.

`deploy.sh` checks the domain before the deploy, with the same API that `wrangler email sending list` uses. If the domain is not onboarded and enabled, it stops. That check needs a token with Zone Read and "Email Sending Write". Email Sending Write is an ACCOUNT-scoped permission group, not a zone one (read from the account's permission groups, 2026-11-06). The onboarding itself needs Email Sending Write, Zone Read and DNS Read. Removing records that are left behind needs DNS Write on the zone. Whether a deploy with a `send_email` binding needs Email Sending Write as well is NOT measured: both live deploys of #104 used a token with every group. It matters only with `MAIL_CHECK=0`, because the check itself needs that group (the open question is recorded on #104).

| Option | Default | Effect |
| --- | --- | --- |
| `MAIL_FROM` | none | The address the site sends from. The binding can send from this address only. When WordPress asks for another From (a plugin, a contact form), that address becomes the Reply-To. |
| `MAIL_FROM_NAME` | the name WordPress asks for | The sender name |
| `ADMIN_EMAIL` | `MAIL_FROM` | The admin user's address and the site's address, set when a NEW site is installed. New-order mails go here, so use a mailbox that someone reads. With `MAIL_FROM` set, the install also sets WooCommerce's From address (Emails settings) to `MAIL_FROM`. |
| `MAIL_ALLOWED_TO` | none | For a test deploy: comma-separated addresses. The binding can send to these only. |
| `MAIL_CHECK` | `1` | `0` skips the domain check (for a negative test only) |

The Reply-To: when WordPress or a plugin asks for another From, that address becomes the Reply-To, so a reply reaches it. A Reply-To that cannot receive mail is dropped: the reserved `example.com`, `example.org`, `example.net`, `.invalid`, `.test` and `localhost`, and `workers.dev`. On an EXISTING site (one restored from a replica, so not installed again), the install values stay as they were. Set the admin email (Settings, General) and WooCommerce's From address (WooCommerce, Settings, Emails) to real addresses once. The customer mails otherwise carry the old From, `admin@example.com` from the first install, which the Worker now drops as a Reply-To, and no reply reaches you.

To stop sending from a domain: `deploy/wr email sending disable mail.example.com --force`. Without `--force`, in a shell with no terminal, it prints "Not disabling." and EXITS 0, so a script reads success where nothing changed (Wrangler 4.107, measured 2026-11-06). The disable removed 5 of the 6 records and left the DMARC TXT on `_dmarc`, so delete that record yourself, then check that the domain is gone from `deploy/wr email sending list`.

Limits (Email Service): 50 recipients a message (to, cc and bcc together), 25 MiB with attachments, and 32 attachments. The mu-plugin refuses a message over a limit before it is sent. The Worker does not retry: a transient send error is a failure that the counter shows.

### Remove a c1 site

```sh
NAME=my-shop ./deploy/destroy.sh
```

`destroy.sh` reads the variant from the site's Terraform state and runs `deploy/variants/c1-destroy.sh`: it deletes the container application `<name>-store`, then the Worker, then empties both buckets (R2 refuses to delete a bucket that has objects), then Terraform deletes the buckets, the Litestream key and the secrets. To empty the media bucket, Terraform first gives the Litestream key that bucket too (`teardown = true`); the Worker and the container are deleted at that point. The database replica and the uploads are deleted. Nothing is kept. A key change can take some seconds to reach R2: `deploy/variants/r2-empty.sh` tries a refused (401 or 403) list or delete again for up to `R2_RETRY_S` (90 s), and logs the first refusal and when it was accepted. On 2026-11-06 the first delete in a media bucket that had objects got 403 just after the key was widened (issue #115).

## Variant `b-dosql`: the database in the PHP object

The same Worker and PHP object as `b-do`, with `DB_IN_DO=on`: each statement runs on the object's own SQLite storage (`ctx.storage.sql`), so a query is not a network call. There is no D1. One object holds the site: one writer, data in the object, point-in-time recovery for 30 days ([Durable Objects](https://developers.cloudflare.com/durable-objects/)). Move a site in or out with `spikes/b2-wordpress/dbmove.py` (`/_dbexport`, `/_dbimport`). Details: [docs/approach-b.md](../docs/approach-b.md) section 8j.

To import an existing WordPress site from a mysqldump, use `deploy/import.sh`: see [deploy/import/README.md](import/README.md).

On Workers Free the object's SQLite has daily limits: 5 million rows read and 100,000 rows written (a public page reads about 160 to 220 rows; an admin page writes about 30 to 40). A page cache hit costs neither.

## Variant `a`: PHP in the Worker, MySQL through Hyperdrive (Workers Paid)

```sh
VARIANT=a MYSQL=vultr VULTR_API_KEY=... MYSQL_ZONE_ID=<zone> MYSQL_HOST=mysql-mysite.example.com NAME=my-site ./deploy/deploy.sh
```

`MYSQL=vultr` makes the database box with `deploy/mysql` (MariaDB with SSL; port 3306 open to Cloudflare's IPv4 ranges only; no SSH; $10 a month). `MYSQL=external` uses your own server: `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`. A public server must have SSL. For a server behind a Cloudflare Tunnel and Access (CR #141, `tests/ssh-source`), set `MYSQL_ACCESS_CLIENT_ID` and `MYSQL_ACCESS_CLIENT_SECRET` instead: Hyperdrive reaches it with the service token, the box opens no inbound port, and no SSL is needed. Give Hyperdrive the host **name**: by IP address it measured about 44 ms per query, by name about 7 ms ([docs/approach-a.md](../docs/approach-a.md)). On Workers Free this variant stops at the CPU limit.

### Variant `a`: the measured site (#666)

A plain `VARIANT=a` deploy is the approach-A site that every #296 run measured. Before #666, deploy.sh rendered none of these settings, so the measured site could only be deployed with a hand-made config. `deploy/tests/a-render-test.sh` diffs deploy.sh's render against that bench config (`deploy/tests/a-render/`), so the two cannot drift apart again.

- **Always rendered:**
  - the object cache: `OBJECT_CACHE`, `OBJECT_CACHE_GROUPS` theme_json, `OBJECT_CACHE_TTL` 10;
  - its L2: `OBJECT_CACHE_L2`, with the binding `OC_KV` to the site's own KV namespace, which Terraform makes (`<name>-oc`, output `oc_kv_id`);
  - lazy MEMFS nodes: `LAZY_NODES`, `LAZY_CACHE_MB` 4.

  These come from the same source as the provisioning path, `aVars` in `deploy/provision/wp-site-config.mjs` (through `deploy/provision/a-vars-toml.mjs`). `a-site-config-test.mjs` holds that source to `[env.a-paid-lean]`.

| setting | what it does | needs |
|---|---|---|
| `A_CLIENT` | `lean` (default) deploys `index-a-lean.js`, the hand-rolled MySQL client (#218). `mysql2` deploys `index-a.js`, which deploy.sh deployed before #666 | |
| `PHP_OVERFLOW=1` | a queued PHP request moves to a Durable Object pool (#646, `docs/approach-a-overflow.md`). Renders `PHP_OVERFLOW`, `PHP_OVERFLOW_POOL`, the `PHP_RUNTIME` binding and its migration. Off by default | |
| `PHP_OVERFLOW_POOL` | the pool size, 1 to 256. Unset is 32, the measured default (#646) | `PHP_OVERFLOW=1` |
| `WOO_HPOS_CACHE` | **on by default** (#296 step 3: with `OBJECT_CACHE_VERSIONS`, checkout went from 334 to 258 queries per order, and completion at 250 shoppers rose in 3 of 3 pairs). WooCommerce's HPOS Data Caching (#697; `hpos_datastore_caching`, off by default in WooCommerce 11.2.1): the must-use plugin answers its option "yes". On approach A the cache lives for one request only (group `orders_data`, which the object cache does not persist there). `off` leaves WooCommerce's own setting | |
| `OBJECT_CACHE_VERSIONS` | **1 by default** (#296 step 3). Options in the cross-isolate cache under an exact version (#668, #686). `0` turns it off. Exact only when Hyperdrive does not cache queries (#650): deploy.sh's Terraform and `deploy/onboard` make the config with caching disabled. The one-click path takes its config from `deploy/onboard`; it refuses a config that caches (#650, fail closed) before it makes anything. Both caches have the same off switch there: `OBJECT_CACHE_VERSIONS=0` and `WOO_HPOS_CACHE=off` (`aCacheInputs`, `deploy/provision`) | |

### Variant `a` admin settings (#394)

The admin memory fixes built on the b-dosql path, for approach A. All of them are off unless set, so a deploy without them is the deploy of before. The rules are in `deploy/a-settings.sh` and are checked before any step:

| setting | what it does | needs |
|---|---|---|
| `OPCACHE_A=1` | primes OPcache on the D1 build, as `spikes/b2-wordpress/opcache-a.sh` does (#218): no Docker, no local MySQL. An empty cache fails the deploy. Unset keeps the Docker MariaDB path, and without Docker that path ships no primed OPcache | |
| `OPCACHE_REMOTE=1` | every OPcache file leaves the bundle, as packs under `/_pf/` (#563). The config gets `run_worker_first = ["/_pf/*"]` | `OPCACHE_A=1` (it records the file trace, cut to A's zips by `trace-filter.py`) |
| `SITE_REMOTE=1` | `site.zip` leaves the bundle too (#569) | `OPCACHE_REMOTE=1` |
| `RECYCLE_WASM_MIB` | the runtime recycle line, 64 to 240 MiB (#602). Unset is 100. Use 140 with the lean engine (#598) | |
| `PF_ENGINE_JS`, `PF_ENGINE_WASM` | build with another engine, for example the lean-trim artifact of the `pagefeather-engine` workflow (#592). Every variant | both, or neither |

Before the upload, `deploy/wfp/remote_assets_check.py` refuses a remote build whose config lacks the `ASSETS` binding or `/_pf/` first. It is the same guard that deploy/wfp runs.

### Workers Logs (`OBSERVABILITY`, variants `b-do`, `b-dosql` and `a`)

Off unless set; the values are deploy/wfp's (`deploy/observability.sh`). `0` renders an explicit `enabled = false`; `1` logs events only (our structured lines and uncaught exceptions, no request metadata); `full` adds the invocation logs, each request's outcome, URL, client IP and user agent, so it is for a throwaway only, and enforced: `full` needs `THROWAWAY=1` on the run (an explicit statement that the site is a throwaway; without it the deploy is refused, so an unmarked site fails closed), and it is refused for a site in `deploy/live-sites/` even with `THROWAWAY=1`. With `1` or `full`, right after the upload `deploy/wfp/obs_settings.py redact-or-off` sets `redact_query_string` and reads it back; if it does not read back, the logs are turned off and the deploy fails.

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
| `HTTP_ALLOW_HOSTS` | `.wordpress.org,.woocommerce.com,.gravatar.com` | Hosts `wp_remote_*()` may call. A leading dot is that name and its subdomains. An empty value denies every host. `*` allows every http(s) host. A custom list replaces the default, so keep the WordPress hosts in it. Payment hosts are not included. The site's own host is always refused, so PHP cannot call itself and wait behind itself. |
| `DEPLOY_STATE` | `local` | `r2` keeps Terraform state in an R2 bucket (`STATE_BUCKET`, `STATE_ENDPOINT`, and an R2 key in `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) |

Each `NAME` has its own Terraform workspace, so two sites never share state.

## When a PHP object does not answer in time (#703, #708)

Every request the front Worker hands to a PHP Durable Object (the b-dosql object, and approach A's overflow pool) has two time bounds. They are recorded settings: give one to `deploy.sh`, `deploy/wfp/site` or the one-click provisioning (`deploy/provision`, `objectTimeInputs`) and it is rendered into the Worker's `[vars]` (`deploy/object-time.sh`), and `deploy/wfp` keeps it on later updates (`site_settings.py`). Unset means the code default.

| setting | default | what it bounds |
|---|---|---|
| `OBJECT_CALL_DEADLINE_S` | `90` | How long the Worker waits for the object to START answering (#703). `off`, or 1 to 600 s. `off` turns it off. Install, import and cron are exempt. |
| `START_BY_TICK_URL` | unset (the site's own `/_tick`) | The start-by recheck's tick target (#754): an https URL, normally `deploy/tick-worker`. See "What the start-by can prove" below. |
| `OBJECT_START_BY_S` | the deadline minus 30 s, or minus a third of a deadline under 90 s (`60` for the default `90`) | How long a request may wait in the object's PHP queue before it would start (#708). `off`, or 1 to 600 s. A request not started by then never runs. `off` restores the behavior before #708. An explicit value is at most the deadline minus that run allowance (`60` at `90`); a larger one is refused when the site is deployed, with the cap in the message. With the deadline `off`, any value from 1 to 600 applies. Control paths (`/_*`: `/_evict`, `/_hold`, the exports) and cron never get one. |

What the client sees:

| answer | headers | meaning |
|---|---|---|
| 503 | `x-object-deadline: queued`, `x-write-loss: none`, `x-overloaded: 1`, `Retry-After: 5` | The request waited past its start-by and **never ran**. Nothing was written. It is safe to retry. |
| 500 | `x-object-deadline: no-answer`, `x-write-loss: unknown` | A request that can write (not GET, HEAD or OPTIONS) STARTED, and the object did not answer within the deadline. It **may have saved** (an order, for example). The client should check before retrying. |
| 503 | `x-object-deadline: no-answer`, `Retry-After` | The same for a GET, HEAD or OPTIONS: nothing to save, safe to retry. |

Every answer of the object path that the edge never keeps carries `x-pf-call`: an answer whose `cloudflare-cdn-cache-control` (the Worker's own edge directive) says `no-store`, such as the cart and checkout, and every failure answer above (no edge directive, `cache-control: no-store`), the request's correlation id (a random id, no request data). A cacheable page does not carry it: the edge would give one request's id to every later visitor. It is the same id that the Worker's `overflow`, `overflow-local` and `object-deadline` lines and the object's `php-lock` and `perf` lines carry, so a client-seen answer can be found in the logs. `deploy/doctor` counts the `object-deadline` lines, split by the answer (500 or 503).

**What the start-by can prove (#752, #754).** In a deployed Worker or Durable Object, `Date.now()` moves only at I/O, and a timer turn does NOT move it (measured on #714 and #752). When a request that queued behind another gets its turn with under 30 s left on its (possibly stale) clock, the PHP lock first makes ONE real subrequest, the tick.

- **The tick's target:** `START_BY_TICK_URL` when set: an https URL, normally the tiny dedicated Worker in `deploy/tick-worker/`, deployed once per account. **One-time step per account:** `deploy/wr deploy --config deploy/tick-worker/wrangler.toml` makes `pf-tick`. Check it with `curl -s -o /dev/null -w '%{http_code}' https://pf-tick.<subdomain>.workers.dev/`, which must print 204. Then give each site `START_BY_TICK_URL=https://pf-tick.<subdomain>.workers.dev/`. Unset, it is the site's own `/_tick`, which the front Worker answers with an empty 204 before any object call. Measured on #754: the object's fetch to its OWN site's hostname is refused by the platform, so set `START_BY_TICK_URL`.
- **After the tick SETTLES, ok or error,** the lock re-reads the clock and decides by the start-by. A failed subrequest still moves the clock (measured on #754).
  - Late: shed, `why: start-by`.
  - Time left: granted.
  - The client disconnected: shed, `why: disconnect`.
  - Only a clock that did NOT advance across the tick is unknown: shed, `why: tick-failed` (fail safe).
- **Every recheck logs a `php-lock` line with event `recheck`:** late, clockMs, the tick's outcome, and its error text.
- **Every shed answers the retry-safe 503** (`x-object-deadline: queued`, `x-write-loss: none`): nothing ran.
- **Cost:** one subrequest per contended request with under 30 s left, inside that request's own invocation. Workers Free allows 50 subrequests per invocation. An uncontended request, or one with 30 s or more left, never ticks.

**The escape hatch for a live site:** `OBJECT_START_BY_S=off` on that site's next `deploy/wfp/site` update or `deploy.sh` run restores the behavior before #708: no start-by, with #703's deadline unchanged. `deploy/wfp` records it, so a later update keeps it; `DROP_SETTINGS=OBJECT_START_BY_S` returns to the default. Do not set it in the dashboard: the next deploy writes `[vars]` again and erases it.

**When the client disconnects (#721).** Every site Worker sets the compatibility flag `enable_request_signal` (the specific flag; the compatibility date is unchanged). With it, a client that drops the connection aborts the PHP object's `request.signal` (measured on the edge: 206 to 298 ms; without the flag it never fires).

- **What it adds:** a request still QUEUED in the object's PHP lock sheds at once and never runs. That holds on arrival, while it waits, or at its turn. It logs `php-lock` event `shed` with `why: disconnect`, and never a `granted` line. The request behind it keeps its place and still waits for the run ahead.
- **What still relies on the start-by:** a caller that waits without disconnecting, such as a client whose timeout is longer than the start-by. The start-by is unchanged, and `OBJECT_START_BY_S=off` turns off only the start-by.
- **Its own off switch:** `OBJECT_DISCONNECT_SHED=off` (`on` or `off`; unset is on), a recorded setting like the two above (`deploy.sh`, `deploy/wfp/site`, the one-click `objectTimeInputs`). With it off, a queued waiter ignores its caller's disconnect and only the start-by applies. The compatibility flag stays on either way, because the 499 answer and the detached container forward below are right with or without the shed.
- **A started run always finishes.** The signal never stops PHP once it runs (the object's handler is not cancelled; measured on the edge). An order that started is saved or not as before. No write path uses the caller's signal: PHP's outbound HTTP has its own timeout, and the checkout container forward detaches it (`signal: null`).
- **A disconnect while the call is in flight:** the Worker answers `499` with `x-write-loss: unknown` for a method that may write (`none` for GET, HEAD and OPTIONS), and logs `m: disconnect`. No client reads that answer. It exists so a disconnect is a counted line, not an exception. A POST that started may have saved, because the object run goes on.

## Remove a site safely

`NAME=my-site ./deploy/destroy.sh` (with `CLOUDFLARE_API_TOKEN` and `ACCOUNT_ID`) finds the state as `deploy.sh` keeps it (`deploy/tf-backend.sh`): local in the clone that deployed the site, or `DEPLOY_STATE=r2` from any clone. It checks all of this before it deletes anything:

- The workspace `NAME` must exist. It is never made here.
- The state's `name` output must be `NAME`. A backend or workspace that points at another site is refused.
- A `backend_override.tf` that an earlier `DEPLOY_STATE=r2` run left in this clone is refused when `DEPLOY_STATE` is not `r2`. It holds that run's state key, maybe of another site. `deploy.sh` and `import.sh` refuse it too.
- Without `sites/<name>.tfvars` in this clone, the variables come from the state's outputs.
- The Worker is deleted by its name (`NAME`), so the clone's Wrangler config is not needed.
- For variant `a` with `MYSQL=vultr`, the box's root (`deploy/mysql`) needs its `sites/<name>.tfvars`, or `MYSQL_ZONE_ID` and `MYSQL_HOST` as for `deploy.sh`: its zone is no output. If no box state is found, the script says that a box, if there is one, is NOT removed.
- For `c1`, the teardown apply targets the Litestream key only.

Tests: `deploy/tests/destroy-test.sh` (offline, local state, an `npx` stub).

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

## Onboarding Phase 1: provider choice to a Hyperdrive config

For variant `a`, `deploy/onboard/onboard.mjs` turns a database PROVIDER choice (`azure`, `planetscale`, `vultr`, `external`) into a ready Hyperdrive config (caching disabled) pointing at it, and prints its id, so a site can then be spun up against it. The output is `HYPERDRIVE_ID` and `SQL_MODE` (set only for PlanetScale, which is strict). It does not deploy a Worker. See [onboard/README.md](onboard/README.md).

## Not yet in this directory

- Variant: approach B in a plain Worker on Workers Paid.
- Measurements from a fixed vantage (a Vultr runner), with p95 and p99, concurrency and the cold path.
- Plugins and WooCommerce runs (`tests/plugins/plugins.py`, `tests/woo.py`) as part of `deploy.sh`.
- A custom domain. The site is on `<name>.<subdomain>.workers.dev`.
- The SSH import (`SSH=`, `deploy/import/README.md`) run against a real server, and `a` on MariaDB with a separate target (issue #31). `b-dosql`, `c1`, `a` and `a2` have the import from a dump and a `wp-content` archive, or from a server over SSH.

## Redeploying a live site's code (CODE_ONLY=1)

`CODE_ONLY=1` (fleet-chezmoi#2620) redeploys the code of a b-dosql site that already exists, from any
clone, with no Terraform state: `MEDIA_BUCKET` and `SITE_ORIGIN` replace the one Terraform output and
the origin; the secrets persist; the install and the measurements are skipped. `DRY_RUN=1` with it
builds and renders and deploys nothing. The live sites it serves are pinned in `deploy/live-sites/`, and
`.github/workflows/deploy-workers.yml` runs it (manual dispatch from main), after checking the live Worker
matches the site file. `deploy/tests/code-only-test.sh` and `deploy/live-sites/tests/check-live-test.py`
hold the refusals.

## Check a site's health: `deploy/doctor` (#652)

`deploy/doctor <site>` reads the site's Workers Logs and tells you what it sees. It only reads. It changes nothing.

```
CLOUDFLARE_API_TOKEN=... ACCOUNT_ID=... deploy/doctor <site> [--hours 24] [--service NAME] [--json]
```

- It finds the site's name in the logs. It tries `<site>`, `site-<site>` (deploy/wfp) and `wp-<site>` (deploy.sh). It picks the name with the most rows. `--service` sets the name.
- Zero rows is never healthy. Doctor says it cannot see the site, and gives the reasons.
- With `OBSERVABILITY=1` the logs hold console lines only. Doctor says that failures cannot be counted. It does not say "0 failures".
- With request logs on, it counts each result (ok, out of memory, out of CPU time, exception, canceled), for the Worker and the Durable Object. It gives CPU and total time p50 and p95, and the slowest paths.
- Cloudflare computes every count and percentile over the whole window, in a few calls. Doctor reads single requests only for a few examples of failures, and it calls them examples.
- It reads Pagefeather's own lines by their field `m`, never by message text.
- It counts Pagefeather's own log lines and names the header each one matches (`x-isolate-reset`, `x-write-loss`, `x-overloaded`, `x-php-lock`, `x-boot`). A start-by shed (#708) is a `php-lock` line with event `shed`, the same as a `PHP_QUEUE_SHED_MS` shed. Its answer also says `x-object-deadline: queued`.
- It says "memory resets happened" or not. It never counts the runtime's reset line, because that line is not one per failed request.
- It never prints a query string, SQL text, a client IP or a token. It warns when the site's logs do not hide query strings.
- Exit status: 0 no failures found, 1 problems found, 3 cannot see the site, cannot count failures, or a read failed, 2 a usage error.

The facts are in `deploy/doctor-lib/facts.py`. The wording is a first draft in `deploy/doctor-lib/words.py`; new wording goes there only. Test: `python3 -I deploy/doctor-lib/tests/doctor-test.py`.
