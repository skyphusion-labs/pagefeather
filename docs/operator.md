# Run WordPress sites on your own Workers for Platforms account

This is the day-one walkthrough for one operator who runs a couple of WordPress sites on their own Cloudflare Workers for Platforms account, every part as code (issue #35). It is not a hosting product or a sign-up flow: you run the commands, on your account. Each site is a `b-dosql` WordPress (PHP and its SQLite database in one Durable Object). The reference and its design are in `deploy/wfp/` and on issue #35.

## What you need

- A Cloudflare account on the **Workers for Platforms Paid** plan (about $25 a month; the cost of two idle sites is in the README, "Workers for Platforms reference deployment: cost of two idle sites").
- Node and Wrangler (4.107.0 or later), and this repository.
- Terraform (1.5 or later).
- A Cloudflare **API token** with edit on: Workers Scripts, Workers KV, Workers for Platforms, R2, and API Tokens (the last for the short-lived key `down.sh` uses to empty a bucket). It is exported as `CLOUDFLARE_API_TOKEN`.
- Optional, recommended: keep the Terraform state in R2 (so it survives your shell). Set `WFP_STATE=r2` and the R2 state bucket's S3 key in `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. Without it the state is local to the clone.

Nothing is configured in the dashboard; everything below is a command.

## Day one: an empty account to two sites

```sh
export CLOUDFLARE_API_TOKEN=...
# optional: export WFP_STATE=r2 AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
./deploy/wfp/up.sh
```

`up.sh` builds `b-dosql` once, then makes the shared pieces (the dispatch namespace, the KV site map, the outbound Worker) and two sites, `one` and `two`. It prints each site's address, `https://wp-<name>.<your-subdomain>.workers.dev`. Each site installs WordPress on first boot; the admin user is `admin` and its password is a Terraform output:

```sh
( cd deploy/wfp/terraform/site && terraform workspace select one && terraform output -raw admin_password )
```

Open a site's address, log in at `/wp-login.php`, and it is a working WordPress with WooCommerce available.

## Add or remove a site

```sh
./deploy/wfp/site add blog       # one command; refuses if any part of "blog" already exists
./deploy/wfp/site remove two     # one command; verifies every part is gone
./deploy/wfp/site list           # the sites you have
```

Adding or removing a site changes no other site. The removal is verified like a teardown: the script is gone, the bucket emptied and deleted, the map entry removed.

## Update a site, with a way back

```sh
./deploy/wfp/site update blog    # one site
./deploy/wfp/site update --all   # every site, one at a time, stopping at the first failure
```

An update re-uploads the site with the current build; the site's data (its SQLite) is kept. Before it changes anything it snapshots the data to R2, and it verifies the new version is live before declaring success. If the verify fails it rolls back: it restores the data from the snapshot (a rollback drops any write made since the snapshot) and, when the previous version was a committed git revision, re-deploys that code. The only interruption is a one-second cold boot of the next request; the address never stops resolving.

## What is isolated

Each site has its own user Worker, its own Durable Object and data, its own R2 media bucket, its own secrets, and its own per-call CPU and subrequest limits. One site cannot read another's bucket, object or secrets. `deploy/wfp/bindings.py` checks after every upload that each script binds only its own resources.

## Custom hostnames

The addresses above are on `workers.dev`. A custom hostname per site (`<site>.your-domain`) is phase B, which routes a zone and so needs a change-request first (issue #138); it is designed but not yet built. Until then the sites are on `workers.dev`, which needs no domain and no change-request.

## Tear it all down

```sh
./deploy/wfp/down.sh             # removes every site and the shared pieces, checking each is gone
```

## If a command stops

- A new `workers.dev` name or a new KV namespace can refuse the first request or write for a few seconds (a transient Cloudflare API error); the scripts retry the small deploys and wait for the site to answer, so a single transient does not fail a run. If `site` or `cross` refuses with "setup not green", the shared setup did not finish: run `up.sh` again and check it exits 0.
- Every command checks the live state through the API, not just its own exit code, so a half-finished step is caught rather than assumed done.

## Where the detail is

- The design and the measured results: issue #35 and `docs/wfp.md`.
- The per-site and shared resources, and the day-one internals: `deploy/wfp/README.md`.
- The cost line: the top-level `README.md`.
