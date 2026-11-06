# deploy/wfp: WordPress sites on Workers for Platforms

A reference deployment for one operator with a couple of sites on their own Workers for Platforms account (issue #35). Each site is a `b-dosql` WordPress (PHP and its SQLite database in one Durable Object) as a user Worker in a dispatch namespace. Every resource comes from this directory. Terraform makes the data plane. The Workers are uploaded from the Wrangler configs that `lib.sh` renders from the templates here.

The design is on issue #35 (the slice 1 comment): one origin per site, never a path prefix. The capability findings are in `docs/wfp.md`.

## What it makes

| | Per site `<name>` | Shared |
| --- | --- | --- |
| Workers | the user Worker `site-<name>` in the namespace; its dispatcher `wp-<name>` on `workers.dev` (phase A) | the outbound Worker `wp-wfp-outbound` |
| Data | its Durable Object and SQLite (made with the script); the media bucket `wp-wfp-<name>-media` | the site map, KV `wp-wfp-sites` |
| Secrets | `WP_SALT`, `SPIKE_TOKEN` (script secrets), `ADMIN_PASSWORD` (Terraform output) | the operator's API token |
| Limits | `cpuMs` and `subRequests` in its site map entry | |
| Address | `https://wp-<name>.<subdomain>.workers.dev` | the dispatch namespace `wp-wfp` |

Every dispatcher copy is the same script and the same config, and only the name differs (`tests/render-test.sh`; `check.py` compares the deployed script hashes). A copy maps the request's own hostname through the site map:

- a host with no entry gets `404` with `x-wfp-error: no-site`;
- an entry whose script is not deployed gets `404` with `x-wfp-error: not-deployed`.

## Day one

```sh
export CLOUDFLARE_API_TOKEN=...   # Workers Scripts, Workers KV, Workers for Platforms, R2: edit; API Tokens: edit (down.sh)
./deploy/wfp/up.sh                # SITES="one two" by default
./deploy/wfp/down.sh              # removes all of it; every step is checked against the API
```

`up.sh`:
1. builds `b-dosql` once (`spikes/b2-wordpress`);
2. applies `terraform/shared` (the namespace and the site map);
3. deploys the outbound Worker;
4. runs `site.sh up <name>` for each site;
5. makes the stale-entry probe `wp-probe`;
6. runs `check.py`, which writes `results/day1-<time>.json`.

`site.sh up <name>` keeps the order that the site map's caching needs (KV can take 60 s or more, and it caches "absent"):
1. the site's Terraform workspace (its bucket, its secrets, its map entry);
2. the user Worker;
3. the dispatcher, which is its hostname;
4. a wait, then the install.

Before the workspace, `site.sh up` waits until the site map accepts a test write. A new KV namespace can refuse writes for a while: on 2026-11-06 it answered 404 code 10013 right after it was made.

`site.sh down` goes the other way: the hostname, the user Worker, then the bucket and the workspace.
- The user Worker counts as gone when the namespace list no longer has it. A deleted script's single GET can still answer 200, with an empty record.
- The bucket is emptied with a short-lived key that can reach only that bucket. The key is made with `-target` and depends on nothing, so a down never creates anything.

Options:
- `SITES`;
- `BUILD=0` (use the build that is there);
- `WFP_STATE=r2` (Terraform state in the R2 state bucket `wp-on-cf-tfstate`, with `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`);
- `CHECK=0`;
- `SITE_WAIT` (seconds to wait for a new site, default 300).

## Tests (offline)

```sh
node deploy/wfp/tests/dispatcher-test.mjs   # the dispatcher with a stand-in site map and namespace
deploy/wfp/tests/render-test.sh             # the rendered configs and the site names
deploy/wfp/tests/ns-state-test.sh           # "is this namespace script gone" (the empty-record case)
deploy/wfp/tests/kv-ready-test.sh           # the wait for a new site map to accept writes
deploy/wfp/tests/tf-test.sh                 # terraform validate, fmt, and the teardown key with no dependency (local: needs terraform)
```
