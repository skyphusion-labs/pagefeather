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

`up.sh` (day one; afterwards `site add` and `site remove` change one site at a time):
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

Before the install, `site.sh up` waits for the site to answer from its own user Worker. A platform 404, or the dispatcher's `no-site` or `not-deployed`, means "not yet": on 2026-11-06 a new namespace script was "not deployed" for a moment after its upload. Before the workspace, `site.sh up` waits until the site map accepts a test write. A new KV namespace can refuse writes for a while: on 2026-11-06 it answered 404 code 10013 right after it was made.

`site.sh down` goes the other way: the hostname, the user Worker, then the bucket and the workspace.
- The user Worker counts as gone when the namespace list no longer has it. A deleted script's single GET can still answer 200, with an empty record.
- The bucket is emptied with a short-lived key that can reach only that bucket. The key is made with `-target` and depends on nothing, so a down never creates anything.

Options:
- `SITES`;
- `BUILD=0` (use the build that is there);
- `WFP_STATE=r2` (Terraform state in the R2 state bucket `wp-on-cf-tfstate`, with `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`);
- `CHECK=0`;
- `SITE_WAIT` (seconds to wait for a new site, default 300).

## Adding and removing a site

```sh
./deploy/wfp/site add three       # one command; refuses if any part of "three" exists already
./deploy/wfp/site remove two      # one command; refuses an unknown site; checks every part gone
./deploy/wfp/site list            # the sites (the Terraform workspaces)
```

`site add` touches only its own site's names, and it refuses before any change when the site exists in part or in full: its workspace, dispatcher, user Worker, map entry or bucket. Then it runs `site.sh up` and checks every part present.

`site remove` runs `site.sh down`, then checks that every part is gone and that the workspace is deleted.

`down.sh` removes every site that `site list` shows.

**Isolation proof (live):** `isolation.sh`, after `up.sh` with the sites `one` and `two`:
1. it seeds a known object in both buckets, then snapshots both sites (`snapshot.py`);
2. it runs `site add three` and snapshots `one` and `two` again;
3. it runs `site remove two` and snapshots `one` and `three` before and after.

Each untouched site must be unchanged: its dispatcher's etag and `modified_on`, its user Worker's hash and `modified_on`, its map entry, its bucket's keys and ETags, and its page title. A part that cannot be read fails the proof; it never counts as unchanged. The script etags are the same across sites (one dispatcher script; one `b-dosql` bundle), so `modified_on` is what tells one site's upload from another's. A re-upload of identical code keeps the etag and changes only `modified_on`, and both are compared. The snapshots read the buckets with S3 credentials derived from the API token, so they create nothing.

## Bindings read back

After every upload, `bindings.py` reads each script's bindings back from the API (`up.sh` for every site, `site add` for its own site). It fails unless each one binds only its own resources:
- **A user Worker `site-<name>`** may bind its own bucket, its own Durable Object class, Images, its assets, plain vars, and the secrets `WP_SALT` and `SPIKE_TOKEN`.
- **A dispatcher `wp-<name>`** may bind the site map and the namespace, with its outbound going to `wp-wfp-outbound` only.

Any other binding fails, and so does a script whose bindings cannot be read. The output names the bindings and their types, never a value.

## Isolation, proven from site A's side (live)

`cross.sh`, after `up.sh` with sites `one` and `two`, proves that our own site A cannot reach site B's resources, using only what a customer's user Worker holds (its bindings, its secrets, `fetch()`). It uploads two attacker probes (`cross-probe/worker.js`): `site-crossa` with site one's bindings and secrets, `site-crossb` with site two's, each behind a dispatcher with a small `cpuMs` and `subRequests`. Then A (`crossa`) attempts to reach B (`two`/`crossb`), and `cross.py` decides the verdict:
- **R2:** A's `MEDIA` list has only A's keys; a `fetch()` to B's bucket returns no bytes.
- **Durable Object:** A's object is its own, not B's.
- **Secrets:** A's `WP_SALT` is its own, not B's; A sees no foreign secret name.
- **Limits:** `subRequests` is enforced exactly; `cpuMs` is enforced, inexact below about 2 s (`docs/wfp.md` item 4).

`CROSS_OUTBOUND=0` runs the probes with the outbound flag off (default on). A PASS is a public result. A result where A reaches B against the docs, or any platform isolation gap, goes to the lead only, is written to no artifact, and stops that line (`cross.py` marks it `platform`; `cross.sh` exits 3). A reach through a binding we gave A by mistake is our defect, fixed in the open. The binding readback (above) proves the static half: A's bindings name only A's resources. The method is on issue #35.

## Tests (offline)

```sh
node deploy/wfp/tests/dispatcher-test.mjs   # the dispatcher with a stand-in site map and namespace
deploy/wfp/tests/render-test.sh             # the rendered configs and the site names
deploy/wfp/tests/ns-state-test.sh           # "is this namespace script gone" (the empty-record case)
deploy/wfp/tests/kv-ready-test.sh           # the wait for a new site map to accept writes
deploy/wfp/tests/wait-site-test.sh          # the wait for a new site to answer from its own user Worker
deploy/wfp/tests/snapshot-test.sh           # the isolation snapshots and diff, and site_footprint
deploy/wfp/tests/site-cmd-test.sh           # site add and remove refuse, with no write, when they must
python3 deploy/wfp/tests/bindings-test.py   # the bindings read back: each script binds only its own resources
python3 deploy/wfp/tests/cross-test.py      # the isolation verdict: a breach is never read as a pass
deploy/wfp/tests/probe-entry-test.sh        # the probe map entry and the CROSS_OUTBOUND option
deploy/wfp/tests/tf-test.sh                 # terraform validate, fmt, and the teardown key with no dependency (local: needs terraform)
```
