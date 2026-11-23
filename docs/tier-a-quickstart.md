# Tier A quickstart: WordPress and WooCommerce on Cloudflare, with your own MySQL (pre-alpha)

**Status: pre-alpha (#1077).** This is for testers. Do not put a real store on it yet.

Tier A runs WordPress in a Cloudflare Worker. Your data stays in a MySQL database that you already have, anywhere. Cloudflare Hyperdrive connects the Worker to the database. One command makes everything in your Cloudflare account, from code: there is no dashboard step. It also installs WordPress, and WooCommerce if you ask for it.

## 1. What you need

**A Cloudflare account on Workers Paid** ($5 a month). On Workers Free this tier stops at the CPU limit.
- Choose your workers.dev subdomain once: Workers & Pages, then **Your subdomain**. Your site is `https://<NAME>.<subdomain>.workers.dev`.
- For media uploads (`MEDIA=1`, below), turn on R2 once, under R2 in the dashboard.

**An API token** for the account: My Profile, API Tokens, Create Token, Custom token, with these **Account** permissions:
- Workers Scripts: Edit
- Workers KV Storage: Edit
- Workers R2 Storage: Edit
- Hyperdrive: Edit
- Account Settings: Read

This is the set the deploy was run with on 2026-11-20, plus Workers Tail Read and Workers Observability Read for the logs. It is not shown to be the smallest set.

**A MySQL database:**
- MySQL 8 or MariaDB 10.6 or later, on any provider (Azure Database for MySQL, PlanetScale, a VPS, or your own server).
- A **host name**, not an IP address. By IP address, every query measured about 6 times slower ([approach-a.md](approach-a.md)).
- **SSL on**, and port 3306 open to Cloudflare's IP ranges (https://www.cloudflare.com/ips/). Or use a Cloudflare Tunnel behind Access instead (see "Options").
- A user and a password, and **an empty database** for this site. One database per site is best.
- A strict server (Azure, PlanetScale, or MySQL 8 by default): set the server's `sql_mode` to `ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION`, or pass the same value as `HYPERDRIVE_SQL_MODE` (below).

**The database's region**, as `<cloud>:<region>`: for example `azure:westus2`, `aws:us-east-1` or `gcp:europe-west1`. The Worker then runs next to the database. Measured on 2026-11-20 (#1054): with the Worker across the country from its database, pages were 2 to 5 times slower. The cloud is `aws`, `gcp` or `azure`. For another host, use the nearest of those regions.

**On your computer** (macOS or Linux):
- `git`, `bash`, `curl`, Python 3, Node.js 22 or later, and Terraform 1.5 or later.
- Docker is not needed.
- Wrangler is pinned in the repository (`deploy/wr`) and installs itself on first use.

## 2. Deploy

```sh
git clone https://github.com/skyphusion-labs/pagefeather.git
cd pagefeather

export CLOUDFLARE_API_TOKEN=<your token>
export ACCOUNT_ID=<your account id>        # Workers & Pages, the right-hand column

VARIANT=a MYSQL=external \
  MYSQL_HOST=<db host name> MYSQL_USER=<user> MYSQL_PASSWORD=<password> MYSQL_DATABASE=<empty database> \
  PLACEMENT=<cloud>:<region> \
  WOO_ACTIVE=1 MEDIA=1 BENCH=0 \
  NAME=<site name> ./deploy/deploy.sh
```

- `NAME`: lower case letters, digits and hyphens. It names the Worker and every resource of the site.
- `WOO_ACTIVE=1` installs WooCommerce and turns it on. Leave it out for plain WordPress.
- `MEDIA=1` keeps uploads in an R2 bucket. Without it, uploads do not persist.
- `BENCH=0` skips the measurements at the end, which take a few minutes.

**What it makes:**
- a Hyperdrive configuration for your database, with query caching off;
- a KV namespace for the object cache;
- the R2 bucket (with `MEDIA=1`);
- the Worker itself.

It then installs WordPress into your database (about 40 s). A new Hyperdrive configuration is checked against the database as it is made: if the database does not answer yet, the deploy retries every 30 s for up to 10 minutes, then stops.

At the end it prints the site address. **The admin user is `admin`.** Read its password from the Terraform state:

```sh
cd deploy/terraform && terraform workspace select <site name> && terraform output -raw admin_password; cd ../..
```

## 3. Check it

- `https://<site name>.<subdomain>.workers.dev/` answers with the site.
- `/wp-admin/` takes the `admin` login.
- With `WOO_ACTIVE=1`, `/shop/` answers.
- A placed response has a `cf-placement` header. `remote-<code>` means the Worker ran next to your database (`remote-SEA` for `azure:westus2`). `local-<code>` means it ran next to you, and the placement did not apply.
- One exception today: a guest page that is not in the page cache yet (a MISS) renders in the cached `Pages` path, and that path is not placed. It renders at the visitor's edge, far from the database: about 57 ms per query under load on `cf759hl`, against about 17 ms placed ([the MISS limit](guide/limits.md#on-the-mysql-option-a-guest-product-page-that-was-not-cached-yet-was-slow-1277-open-until-measured-end-to-end), #1277).

## 4. The Terraform state (it holds secrets)

The state holds the admin password, the WordPress salt, a spike token that gates the site's admin endpoints, and your database password, which Hyperdrive also needs.
- **By default it is on your computer**, in `deploy/terraform/terraform.tfstate.d/<site name>/` (git ignores it). Only that checkout can update or remove the site. Keep it private, and do not delete it while the site exists.
- **To keep it in R2 instead**, so any checkout can reach it, set on every command (deploy, update and destroy):
  `DEPLOY_STATE=r2 STATE_BUCKET=<an R2 bucket> STATE_ENDPOINT=https://<account id>.r2.cloudflarestorage.com AWS_ACCESS_KEY_ID=<R2 key id> AWS_SECRET_ACCESS_KEY=<R2 key secret>`
  (an R2 API token with Object Read and Write on that bucket).

## 5. Update

Pull the new code, then run the **same command again**, with the same `NAME` and the same settings:

```sh
git pull
VARIANT=a MYSQL=external MYSQL_HOST=... MYSQL_USER=... MYSQL_PASSWORD=... MYSQL_DATABASE=... \
  PLACEMENT=<cloud>:<region> WOO_ACTIVE=1 MEDIA=1 BENCH=0 NAME=<site name> ./deploy/deploy.sh
```

Terraform keeps every resource it made, Wrangler uploads the new code, and the install answers "already". Your content, users and orders stay in your database. Pass `PLACEMENT` every time: an update without it is refused, never silently moved (#1054).

## 6. Remove the site

```sh
NAME=<site name> ./deploy/destroy.sh
```

Use the same `CLOUDFLARE_API_TOKEN` and `ACCOUNT_ID` as the deploy, and the same `DEPLOY_STATE` settings if you used R2. It deletes the Worker first, and stops if the Worker is still there. Then it empties and deletes the media bucket, with a short-lived R2 credential for that bucket only (#1031). Then it deletes the Hyperdrive configuration, the KV namespace and the state workspace.

**It does not touch your MySQL database.** WordPress's tables stay there. Drop the database yourself when you are done.

## 7. When it refuses

Every check runs before anything is made, and each one names the setting:

| message | fix |
|---|---|
| `set CLOUDFLARE_API_TOKEN` / `set ACCOUNT_ID` / `set NAME` | export or pass it |
| `set MYSQL_HOST` / `set MYSQL_PASSWORD` | pass your database's host name and password (`MYSQL_USER` defaults to `wp`, `MYSQL_DATABASE` to `wordpress`) |
| `approach A needs PLACEMENT, the database's region ... set PLACEMENT=azure:<the server's region>` | an Azure host: pass its region, for example `PLACEMENT=azure:westus2` |
| `approach A needs PLACEMENT for an external MySQL ...` | pass `PLACEMENT=<aws\|gcp\|azure>:<region>`. `PLACEMENT=host` asks Cloudflare to probe the host instead. It placed in the wrong region for an Azure server (#1054), so prefer the region |
| `PLACEMENT must be host, smart, <aws\|gcp\|azure>:<region> or unset` / `PLACEMENT region must be <aws\|gcp\|azure>:<region>` | fix the value's format |
| `PLACEMENT is for variant a only` | set `VARIANT=a`, or drop `PLACEMENT` |
| `HYPERDRIVE_SQL_MODE: mode names and commas only` / `HYPERDRIVE_SQL_MODE is for variant a only` | for example `HYPERDRIVE_SQL_MODE=ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION` |
| `WOO_ACTIVE must be 0 or 1` | `WOO_ACTIVE=1`, or leave it out |
| `OBSERVABILITY=full needs THROWAWAY=1 ...` | `OBSERVABILITY=1` logs our own events only; `full` (every request's URL and client IP) is for a throwaway site only |
| `set MYSQL_ACCESS_CLIENT_ID` / `set MYSQL_ACCESS_CLIENT_SECRET` | a Tunnel origin needs both |
| `... backend_override.tf exists ...` | a `DEPLOY_STATE=r2` run left a backend file in this checkout: pass the same `DEPLOY_STATE` settings, or remove `deploy/terraform/backend_override.tf` to use local state |
| the deploy stops after "database not ready yet (try 20)" | Hyperdrive could not reach the database for 10 minutes: check the host name, SSL, the firewall (Cloudflare's IP ranges), the user and the password |
| destroy: `no Terraform state for <name> in this clone` | run it from the checkout that holds the state, or with the same `DEPLOY_STATE=r2` settings |
| destroy: `no temporary R2 credential for the media bucket ... Nothing was deleted.` | the token needs Workers R2 Storage Edit |

## Options

- `HYPERDRIVE_SQL_MODE=<modes>`: the `sql_mode` each statement carries, for a strict server whose `sql_mode` you cannot change (PlanetScale, for example).
- `MYSQL_ACCESS_CLIENT_ID` and `MYSQL_ACCESS_CLIENT_SECRET`: reach a server behind a Cloudflare Tunnel and Access, with no public port and no SSL needed (CR #141).
- `SITE_ORIGIN=https://<your domain>`: the site's own address, for a custom domain.
- `OBSERVABILITY=1`: Workers Logs with our own events (no request metadata).
- `PHP_OVERFLOW=1`: turns on the overflow pool, which is **off by default** (since #1298, Conrad's ruling on #1277). With it, a request that would wait behind a long PHP run in its isolate runs on a Durable Object pool instead. It is off because the pool's objects run far from the database: on `cf759hl` a moved request paid about 3 times the cost per query, a net loss of about 2 s per moved request at the median ([approach-a-overflow.md](approach-a-overflow.md)).
- Everything else is in [deploy/README.md](../deploy/README.md). The defaults there are the measured ones.

## Known limits (pre-alpha)

- **Mail:** a workers.dev site has no sender, so WordPress sends no mail. Order confirmations and password resets need `MAIL_FROM` on a domain onboarded for Cloudflare Email Sending (`deploy/email-sending.sh`). A failed send is logged and queued for a retry (#1062).
- **Background jobs:** WP-Cron and WooCommerce's Action Scheduler run on a cron object, **on by default** (#1166, #855). `A_CRON=0` turns it off; then nothing runs the scheduled jobs.
- **Checkout is slow:** on `cf759hl` the blocks checkout's order POST took 4.8 to 6.8 s after #1219, measured on its branch; it was 9.3 to 11.8 s before. What is left is database time, about 13 ms a query ([checkout](guide/limits.md#woocommerce-checkout-is-slow-on-the-mysql-option-1218-1210), #1218).
- **A guest page cache MISS is slow:** 3 guest product pages on a MISS took 9 to 12 s at the browser on `cf759hl`, under the suite's load ([the MISS limit](guide/limits.md#on-the-mysql-option-a-guest-product-page-that-was-not-cached-yet-was-slow-1277-open-until-measured-end-to-end), #1277). A page in the cache (a HIT) runs no PHP.
- **WooCommerce admin and product batches are slow:** a product save about 2 to 3 s, a batch of 5 new products 6.5 s, larger batches up to 14 s (p95) under load; each query costs about 16.6 ms ([admin and batches](guide/limits.md#woocommerce-admin-screens-and-bulk-product-edits-are-slow-on-the-mysql-option-1078), #1078).
- The open checks for this release are listed on #1077. Report what you find as a GitHub issue on `skyphusion-labs/pagefeather`. Include:
  - the commit you deployed (`git rev-parse --short HEAD`);
  - the deploy's output (it names the build, under `_pf/<build id>`);
  - the request and the time in UTC;
  - the `cf-ray` header of a failing response.
