# Run WordPress sites on your own Workers for Platforms account

This is the day-one walkthrough for one operator who runs a couple of WordPress sites on their own Cloudflare Workers for Platforms account, every part as code (issue #35). It is not a hosting product or a sign-up flow: you run the commands, on your account. Each site is a `b-dosql` WordPress (PHP and its SQLite database in one Durable Object). The reference and its design are in `deploy/wfp/` and on issue #35.

## What you need

- A Cloudflare account on the **Workers for Platforms Paid** plan (about $25 a month; the cost of two idle sites is in the README, "Workers for Platforms reference deployment: cost of two idle sites").
- Your Cloudflare **account id**, exported as `ACCOUNT_ID`. Every command below uses it.
- Node and Wrangler (4.107.0 or later), and this repository.
- Terraform (1.5 or later).
- A Cloudflare **API token** with edit on: Workers Scripts, Workers KV, Workers for Platforms, R2, and API Tokens (the last for the short-lived key `down.sh` uses to empty a bucket). It is exported as `CLOUDFLARE_API_TOKEN`.
- Optional, recommended: keep the Terraform state in R2 (so it survives your shell). Set `WFP_STATE=r2` and the R2 state bucket's S3 key in `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. Without it the state is local to the clone.

Nothing is configured in the dashboard; everything below is a command.

## Day one: an empty account to a couple of sites

You supply your account and a site list. The sites stay up; nothing here tears them down.

```sh
export CLOUDFLARE_API_TOKEN=...
export ACCOUNT_ID=<your Cloudflare account id>
export SITES="shop blog"            # your site names; the default is "one two"
# optional: export WFP_STATE=r2 AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
# optional: export CACHE_PROBE=0    # skip the Workers Cache measurement probe
./deploy/wfp/up.sh
```

`up.sh` builds `b-dosql` once, then makes the shared pieces (the dispatch namespace, the KV site map, the outbound Worker) and each site in `SITES`. It prints each site's address, `https://wp-<name>.<your-subdomain>.workers.dev`, and leaves them running. Each site installs WordPress on first boot; the admin user is `admin` and its password is a Terraform output:

```sh
( cd deploy/wfp/terraform/site && terraform workspace select shop && terraform output -raw admin_password )
```

Open a site's address, log in at `/wp-login.php`, and it is a working WordPress with WooCommerce available.

## Add or remove a site

```sh
./deploy/wfp/site add news       # one command; refuses if any part of "news" already exists
./deploy/wfp/site remove blog    # one command; verifies every part is gone
./deploy/wfp/site list           # the sites you have
```

Adding or removing a site changes no other site. The removal is verified like a teardown: the script is gone, the bucket emptied and deleted, the map entry removed.

## Update a site, with a way back

```sh
./deploy/wfp/site update shop    # one site
./deploy/wfp/site update --all   # every site, one at a time, stopping at the first failure
```

An update re-uploads the site with the current build; the site's data (its SQLite) is kept. Before it changes anything it snapshots the data to R2, and it verifies the new version is live before declaring success. If the verify fails it rolls back: it restores the data from the snapshot (a rollback drops any write made since the snapshot) and re-deploys the code that was live, from the rollback artifact it keeps in the site's own R2 bucket (`_build/artifact/<build id>.tar.gz`, #466). With no artifact of the live build, it restores the data only and says to deploy the old build by hand. If the data restore itself fails after its retries, the command exits 3, marks the site, and prints the command that restores it (`deploy/wfp/site restore <name>`); until that runs, `site update` refuses the site (#515). The only interruption is a one-second cold boot of the next request; the address never stops resolving.

## What is isolated

Each site has its own user Worker, its own Durable Object and data, its own R2 media bucket, its own secrets, and its own per-call CPU and subrequest limits. One site cannot read another's bucket, object or secrets. `deploy/wfp/bindings.py` checks after every upload that each script binds only its own resources.

## Pageview analytics (opt-in)

Each site can record its own pageviews to a Cloudflare Analytics Engine dataset. This is privacy friendly: there is no cookie, no IP address, no user agent and no query string, so there is no need for a cookie banner and no GA plugin. It is server side and operator facing. It is not a public feed and not a billing plane.

It is OFF by default, because the writes are metered and analytics has a privacy cost. Turn it on when you add or update a site by setting `WP_ANALYTICS`:

```sh
export WP_ANALYTICS=on
./deploy/wfp/site add news        # or: ./deploy/wfp/site update news
```

The site then binds an Analytics Engine dataset named `wp-wfp-<name>-analytics` (its own, per site), and records one data point per front-end page view. Each point holds the host, the request path (with the query string removed), the HTTP status (200 or 404), and the coarse Cloudflare country code when the edge provides it. The one field that could identify a reader, the index, is set to the site host, never to a visitor.

### Read your pageviews

Analytics Engine has no dashboard. You read it with the SQL API, from your own machine, with the same account id and a token that can read Analytics Engine. The dataset name has hyphens, so it is double quoted in the `FROM` clause. Replace `news` with your site name.

Top pages in the last 24 hours:

```sh
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --data "SELECT blob2 AS path, SUM(double1) AS views
          FROM \"wp-wfp-news-analytics\"
          WHERE timestamp >= NOW() - INTERVAL '1' DAY
          GROUP BY path ORDER BY views DESC LIMIT 20"
```

Views per day for the last week, and views by country:

```sh
# per day
--data "SELECT toStartOfDay(timestamp) AS day, SUM(double1) AS views
        FROM \"wp-wfp-news-analytics\"
        WHERE timestamp >= NOW() - INTERVAL '7' DAY
        GROUP BY day ORDER BY day"

# by country
--data "SELECT blob4 AS country, SUM(double1) AS views
        FROM \"wp-wfp-news-analytics\"
        WHERE timestamp >= NOW() - INTERVAL '7' DAY
        GROUP BY country ORDER BY views DESC"
```

The columns are `blob1` host, `blob2` path, `blob3` status, `blob4` country, and `double1` the view count (always 1, so `SUM(double1)` is the number of views and `COUNT(*)` is the number of sampled rows). A write takes a few seconds to be queryable. If the double quoted name is rejected, run `SHOW TABLES` against the same endpoint to confirm the exact dataset name first.

Analytics Engine keeps data for 90 days. The free allowance is 10 million writes and 1 million reads a month, which is far more than a normal site needs. Turn the feature off by setting `WP_ANALYTICS=off` on the next update; the dataset and its stored points are untouched.

## Custom hostnames

The addresses above are on `workers.dev`, which needs no domain. To give the sites custom hostnames (`<site>.<your-zone>`) instead, run the deployment in phase B: set `WFP_CUSTOM_DOMAIN=1` and `WFP_SUBDOMAIN` to a zone you have routed on this account, before `up.sh`.

```sh
export WFP_CUSTOM_DOMAIN=1
export WFP_SUBDOMAIN=sites.your-domain.com
SITES="shop blog" ./deploy/wfp/up.sh
```

Every site then gets `<name>.sites.your-domain.com`, routed by one shared dispatcher, each with its own certificate (the first deploy waits while Cloudflare issues it). Phase B is proven end to end (issue #138, closed).

To add another custom-hostname site to a phase B deployment later, carry the same two variables on `site add`:

```sh
WFP_CUSTOM_DOMAIN=1 WFP_SUBDOMAIN=sites.your-domain.com ./deploy/wfp/site add news
```

## Known limit: one phase for the whole deployment

The phase (A `workers.dev`, or B custom hostnames) is chosen once, at `up.sh`, for every site in the deployment. `up.sh` stands up the one shared dispatcher only in phase B, and a per-site `site add` does not stand it up, so phase A and phase B sites cannot be mixed cleanly in the same deployment: pick one phase for all of a deployment's sites. Two sites on `workers.dev` (phase A) or two on custom hostnames (phase B) both work today; a mixed deployment does not.

## Tear it all down

Your sites stay up until you remove them. To take the whole deployment down:

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
