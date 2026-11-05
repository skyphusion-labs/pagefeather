# Deploy a WordPress site on Cloudflare, then measure it

One command makes the site, installs WordPress and measures it. Everything the site needs is code: Terraform makes the data plane, Wrangler deploys the code from a config that the script writes from the Terraform outputs. You do not copy an id by hand, and you do not click in a dashboard.

```sh
export CLOUDFLARE_API_TOKEN=...   # Workers Scripts, D1 (and R2 if MEDIA=1)
export ACCOUNT_ID=...
NAME=my-site ./deploy/deploy.sh
```

At the end the script prints the site address, the D1 time per statement, the `e2e.sh` result and the page times, and writes them to `deploy/results/<name>-<time>.json`. Remove the site with `NAME=my-site ./deploy/destroy.sh`.

## What it makes (variant `b-do`)

| Part | Made by | Where |
| --- | --- | --- |
| D1 database (WordPress tables) | Terraform | `deploy/terraform/main.tf`. Primary in region `LOCATION`. |
| Secrets (salt, spike token, admin password) | Terraform (`random_password`) | Terraform state. Sent to the Worker with `wrangler secret bulk`. |
| R2 bucket for the media library (`MEDIA=1`) | Terraform | `deploy/terraform/main.tf` |
| Worker and the PHP Durable Object | Wrangler | `spikes/b2-wordpress`, config `wrangler.deploy.<name>.toml` (written by `deploy.sh`) |
| WordPress install | `deploy.sh` (`/_install`) | Runs inside the PHP object |

The Worker serves static files and the page cache. Every request that needs PHP goes to one Durable Object, which runs WordPress in PHP (WebAssembly) and talks to D1. This runs on Workers Free: the Worker uses 1 to 4 ms of CPU per request (the Free limit is 10 ms), and the object has the CPU for PHP. Measured on 2026-11-05 on a Free account; see [docs/approach-b.md](../docs/approach-b.md) section 8i.

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

- Variants: SQLite inside the PHP object (issue #28 follow-up), approach A (MySQL through Hyperdrive), approach B in a plain Worker on Workers Paid, approach C1 (Container). Each is planned as a value of `variant`, not a copy of the scripts.
- Plugins and WooCommerce runs (`tests/plugins/plugins.py`, `tests/woo.py`) as part of `deploy.sh`.
- A custom domain. The site is on `<name>.<subdomain>.workers.dev`.
