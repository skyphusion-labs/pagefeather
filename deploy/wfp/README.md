# deploy/wfp: WordPress sites on Workers for Platforms

A reference deployment for one operator with a couple of sites on their own Workers for Platforms account (issue #35). Each site is a `b-dosql` WordPress (PHP and its SQLite database in one Durable Object) as a user Worker in a dispatch namespace. Every resource comes from this directory. Terraform makes the data plane. The Workers are uploaded from the Wrangler configs that `lib.sh` renders from the templates here.

The design is on issue #35 (the slice 1 comment): one origin per site, never a path prefix. The capability findings are in `docs/wfp.md`.

New to this? The day-one walkthrough for an operator is [docs/operator.md](../../docs/operator.md).

## What it makes

| | Per site `<name>` | Shared |
| --- | --- | --- |
| Workers | the user Worker `site-<name>` in the namespace; its dispatcher `wp-<name>` on `workers.dev` (phase A), or the one dispatcher `wp-dispatch` with a Custom Domain per site (phase B, #138) | the outbound Worker `wp-wfp-outbound` |
| Data | its Durable Object and SQLite (made with the script); the media bucket `wp-wfp-<name>-media` | the site map, KV `wp-wfp-sites` |
| Secrets | `WP_SALT`, `SPIKE_TOKEN` (script secrets), `ADMIN_PASSWORD` (Terraform output) | the operator's API token |
| Limits | `cpuMs` and `subRequests` in its site map entry | |
| Address | `https://wp-<name>.<subdomain>.workers.dev` (phase A), or `https://<name>.wfp-test.skyphusion.org` (phase B) | the dispatch namespace `wp-wfp` |

Every dispatcher copy is the same script and the same config, and only the name differs (`tests/render-test.sh`; `check.py` compares the deployed script hashes). A copy maps the request's own hostname through the site map:

- a host with no entry gets `404` with `x-wfp-error: no-site`;
- an entry whose script is not deployed gets `404` with `x-wfp-error: not-deployed`.

## Day one

```sh
export CLOUDFLARE_API_TOKEN=...   # Workers Scripts, Workers KV, Workers for Platforms, R2: edit; API Tokens: edit (down.sh)
export ACCOUNT_ID=...             # your Cloudflare account id. No default: every tool stops with exit 2 without it
# The Skyphusion reference deploy sets ACCOUNT_ID (and WFP_ZONE_ID, WFP_SUBDOMAIN) with:  . deploy/wfp/reference.env
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

## Importing an existing site

```sh
SQLITE=store.sqlite CONTENT=wp-content.tar.gz ./deploy/wfp/site import <name>   # a source that is already driver-made SQLite
DUMP=site.sql CONTENT=wp-content.tar.gz ./deploy/wfp/site import <name>         # a MySQL dump (--hex-blob)
```

`site import` runs `deploy/import.sh` against one site that `site add` made. **It replaces the site's whole database.** Everything the import needs comes from the site's own workspace: its origin (`site_host`), its `SPIKE_TOKEN` and its media bucket. Nothing is read from `deploy/terraform`. With `CONTENT`, the uploads go into `wp-wfp-<name>-media` with the `media_import` key, which can read and write objects in that bucket only. The key is made with `-target`; it depends on nothing, so `tests/tf-test.sh` checks that the apply touches nothing else. It is deleted after the import, also when the import fails, and the command checks that it is gone from the state. `DRY_RUN=1` and `SKIP_MEDIA=1` make no key.

The theme and the active plugins must be in the build (the import checks the local `spikes/b2-wordpress/build`), so build with the `IMPORT_*` line the import prints before `site add`, or `site update` afterwards. The import's rules, refusals and steps are in [`deploy/import/README.md`](../import/README.md).

Tests (offline): `site-cmd-test.sh` refuses `site import` with no source, for a site that does not exist and for a bad name, with no write to the account. `tf-test.sh` checks the key's graph. The caller-key path of `import.sh` (MEDIA_BUCKET, R2_ENDPOINT, R2_KEY_ID and R2_SECRET) has no offline test; it runs end to end only against a live site.

## Updating a site

```sh
./deploy/wfp/site update <name>     # one site, with a way back
./deploy/wfp/site update --all      # every site, one at a time, stopping at the first failure
```

Workers for Platforms has no gradual deployments for user Workers, and `b-dosql` keeps its data in the Durable Object and its code in the Worker bundle. So an update re-uploads the SAME script (`site-<name>`): the object and its data persist, the code swaps. `site update`:

1. reads the live build id from the site map entry (the rollback target);
2. unless `NO_SNAPSHOT=1`, snapshots the object's SQLite to R2 under `_snapshots/` and reads it back to confirm it stored (a prefix the Worker never serves); it aborts if the snapshot cannot be verified, so a rollback always has a way back;
3. rebuilds from the current tree and re-uploads the script, then records the new build id in the entry;
4. waits until `/_build` shows the new build (measured 2026-11-06: a re-upload flips it in about 1 s, with the object idle), then checks the site answers 200.

If the verify fails, it rolls back: it restores the data from the snapshot and re-deploys the exact code that was live, by re-uploading the build artifact it saved before the rebuild (for any build id, not only a committed sha). **A rollback drops any write made between the snapshot and the rollback**, and the command and this doc both say so. If no saved artifact is on disk (an unusual case: `build/` was absent when the update started), the data is still restored and the command says to deploy the old build by hand.

The only interruption is the cold boot of the next request after the new code loads (about 1 s); the hostname always resolves. `/_evict` (an object reset via `ctx.abort()`) is a best-effort fast-path for a busy object that has not flipped; whether `abort()` resets the object on our compatibility date is unproven (the happy path flipped before it was needed).

`update --all` runs the sites in `site list` order, one at a time, and stops at the first failure: the failed site is rolled back and the sites after it are left on their old version, so a bad version never rolls across the estate.

## Phase B: a custom domain per site (#138)

Phase A gives each site its own origin by deploying the one dispatcher script once per site as `wp-<name>` on `workers.dev`. Phase B instead deploys the dispatcher once as `wp-dispatch` and gives each site a Workers Custom Domain `<name>.wfp-test.skyphusion.org`. The dispatcher code does not change: it already routes by the request's own hostname through the site map, so the site map key becomes the custom hostname.

It is off by default. `WFP_CUSTOM_DOMAIN=1` selects it; without the flag, `workers.dev` stays the only live target. `WFP_SUBDOMAIN` sets the test subdomain (default `wfp-test.skyphusion.org`), and `WFP_ZONE_ID` names the zone that holds it. There is no zone default: a Custom Domain with no zone fails at plan. The Skyphusion reference deploy sources `deploy/wfp/reference.env`, which sets `ACCOUNT_ID`, `WFP_ZONE_ID` and `WFP_SUBDOMAIN`; a self-hosted deploy sets its own.

- `up.sh` deploys `wp-dispatch` once, before any site, because a Custom Domain attaches to a service that must already exist.
- A new Custom Domain has no certificate until Cloudflare's Advanced Certificate pack is active, which can exceed 15 min, so the first phase B deploy waits longer: `site_wait_cap` is 1800 s in phase B (300 s in phase A), and `SITE_WAIT` overrides it. If the first deploy still times out while the certificate issues, re-run `up.sh` once it is active: the data plane persists and the install completes on the re-run.
- `site add` (through `site.sh up`) attaches the Custom Domain with Terraform (`cloudflare_workers_custom_domain`, in `terraform/site`), which creates the DNS record and the certificate. `var.hostname` is both this domain and the site map key, so the routed hostname and the key cannot drift.
- `site remove` detaches the Custom Domain before it deletes the map entry (the CR #138 remove order), then removes the rest.

**The live attach routes a zone, so it is governed by CR #138** (the CR #113 pattern: a zone-record snapshot before the first attach, one exact hostname per site, the reversal compared against the snapshot, never a wildcard). The attach is run by the lead as the CR #138 apply step, serialized against the other live work on `skyphusion.org`. This directory ships the code and the offline tests; nothing here routes a zone, and the matrix does not claim custom domains as measured until phase B is proven live.
## Bundle size gate

The Worker size limit is 64 MiB uncompressed. Nearly all of a b-dosql upload is four files: `build/site.zip`, `build/opcache.zip` and the PHP wasm with its loader. `lib.sh bundle_size_check` stops above `BUNDLE_MAX_MIB` (default 62 MiB) and names each file's size. `build_dosql` runs it after the OPcache build, and `site.sh up` and `site update` run it right before the upload, so an upload never starts without headroom. A missing file is an error. Measured sizes for a heavy store are in `docs/known-limitations.md`. Test: `tests/bundle-size-test.sh`.

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
- **Limits:** `subRequests` was exact where measured, without an outbound Worker (not measured with one); `cpuMs` is enforced, inexact below about 2 s (`docs/wfp.md` item 4).

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
deploy/wfp/tests/custom-domain-test.sh      # phase B (#138): custom_host, site_host, the shared dispatcher, the Terraform wiring
```
