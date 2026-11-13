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

1. reads the live build id and the config hash from the site map entry (the build id is the rollback target);
2. reads the site's recorded build inputs (#379, below) and refuses a build the live site cannot run (#377, below);
3. unless `NO_SNAPSHOT=1`, snapshots the object's SQLite to R2 under `_snapshots/` and reads it back to confirm it stored (a prefix the Worker never serves); it aborts if the snapshot cannot be verified, so a rollback always has a way back;
4. rebuilds from the current tree. It uploads the script when the build id differs, when the config hash differs, when the entry has no config hash, or when `FORCE_UPLOAD=1`. It then records the new build id and the config hash in the entry. When the build id and the config hash are both the same, it says `nothing to do` and it does not upload;
5. waits until `/_build` shows the new build (measured 2026-11-06: a re-upload flips it in about 1 s, with the object idle), then checks the site answers 200.

If the verify fails, it rolls back: it restores the data from the snapshot and re-deploys the exact code that was live, by re-uploading the build artifact it saved before the rebuild (for any build id, not only a committed sha). **A rollback drops any write made between the snapshot and the rollback**, and the command and this doc both say so. If no saved artifact is on disk (an unusual case: `build/` was absent when the update started), the data is still restored and the command says to deploy the old build by hand.

The only interruption is the cold boot of the next request after the new code loads (about 1 s); the hostname always resolves. `/_evict` (an object reset via `ctx.abort()`) is a best-effort fast-path for a busy object that has not flipped; whether `abort()` resets the object on our compatibility date is unproven (the happy path flipped before it was needed).

### When an update uploads (#421)

`site update` records a config hash in the site map entry, next to the build id. The hash is the sha256 of the rendered user config (`render_user` in `lib.sh`) and of the sorted key names in the secrets JSON. A secret value is not part of the hash. The command does not print a secret value.

The command uploads for any of these reasons, and it prints the reason:

- the build id differs (`build changed`);
- the config hash differs (`config changed`);
- the entry has no config hash (`no recorded config hash`). A site recorded before this change has no hash. The next update uploads once and records the hash;
- `FORCE_UPLOAD=1` (`forced`). This is the explicit override.

When the build id and the config hash are the same, and `FORCE_UPLOAD` is not `1`, the command prints `nothing to do` and it does not upload.

A change only to the rendered config uploads on its own. Do not pass `FORCE_UPLOAD=1` for that change. This includes `PHP_INI`, `PHP_RECYCLE`, `OPCACHE_SPLIT`, `CODE_PERSIST`, `CODE_BUDGET_MB`, `TURNSTILE_*`, `OBSERVABILITY` and the mail variables. These values are still read from the environment of the run only. They are not recorded build inputs. An update that does not pass one of them renders the site without it, so the hash changes and the update uploads. Pass the value on every update of that site.

A change to a secret value, with the same key names, does not change the hash, so it does not upload. A new secret key does. To push a rotated secret value, run the update with `FORCE_UPLOAD=1`. `site.sh up` records the hash after it uploads the user Worker, so a site added after this change has a hash. Test: `tests/config-hash-test.sh`.

### The build inputs of a site (#377, #379)

A site's code is built from inputs: `PLUGINS`, `IMPORT_CONTENT` with `IMPORT_THEMES`, `IMPORT_PLUGINS` and `IMPORT_MU_PLUGINS`, and `WOO_ACTIVE`. On 2026-11-12, an update that did not pass them shipped the live store ggc.sh without its plugins and mu-plugins for about 11 minutes. So:

- **Recorded.** After a good `site update` (and a `site add` with `BUILD=1`), the run's inputs are written to the site's own media bucket, `_build/inputs.json`. The content subset the build copies (the named themes, plugins and mu-plugins) is written as `_build/<content id>.tar.gz`. Both live outside `uploads/`, the only prefix the Worker serves, so they are private like `_snapshots/`. `site remove` empties the bucket, so they go with the site. The record holds values only, never a path on the operator's machine and never a secret.
- **Reused.** A `site update` that passes no input builds with the recorded ones and the stored tree. A run that passes different inputs is refused, and the differences are printed; `REPLACE_INPUTS=1` replaces them on purpose.
- **Refused.** Before any change, `site update` also refuses: a live site whose Store API answers 200 with a build that would not prime WooCommerce; a live content build (`-c<8 hex>` in its id) with a run that has no content input (`ALLOW_PLAIN_BUILD=1` overrides); and a dirty tree (`ALLOW_DIRTY=1` overrides), because a `-dirty` build cannot be rebuilt or read back.
- **Why it matters beyond code:** when WordPress loads an admin page while active plugins are missing from disk, it deactivates them in the database. A build without the site's plugins becomes a data change on the first admin page view, and restoring the code does not undo it.

The build id carries what was built: the sha, `-dirty`, `-c<8 hex>` (the content inputs) and `-wooprimed` (`WOO_ACTIVE=1`), so a different build of one sha is never skipped as "already at build" (`spikes/b2-wordpress/build-id.sh`). Tests: `tests/build-inputs-test.sh`, `tests/update-inputs-test.sh`, `spikes/b2-wordpress/tests/build-id-test.sh`.

`update --all` runs the sites in `site list` order, one at a time, and stops at the first failure: the failed site is rolled back and the sites after it are left on their old version, so a bad version never rolls across the estate.

### PHP settings for one site: PHP_INI (#394)

`PHP_INI` sets php.ini values for one site. It is a JSON object of name to value:

```sh
PHP_INI='{"opcache.memory_consumption":"48"}' deploy/wfp/site update <name>
```

- `render_user` (`lib.sh`) writes it to the site's `[vars]` as compact JSON with sorted keys. At each boot, `index.js` passes it to PHP after its own defaults, so it wins.
- It is read from the environment of the run ONLY, like `TURNSTILE_*`. It is NOT a recorded build input. An update that does not pass it renders the site without it, and the config hash changes, so the update uploads. Pass it on every update of that site. Do not pass `FORCE_UPLOAD=1` for a `PHP_INI` change on its own.
- The render fails on a value it cannot write safely. That is: not a JSON object, empty, more than 32 entries, a name outside `[A-Za-z0-9_.]` (1 to 64 characters), a value that is not a string or an integer, or a string with a quote, a backslash or a control character, or over 256 characters.
- The other config emitters (`deploy/provision`, the Worker path) do not read it. The golden case `php-ini` shows that.
- Tests: `deploy/wfp/tests/render-test.sh` (with it, without it, the refused shapes) and `deploy/tests/render-golden` (case `php-ini`).

### Plugins installed from wp-admin: CODE_PERSIST (#407)

With `CODE_PERSIST=on`, a plugin or theme installed, updated or deleted from wp-admin stays that way:

```sh
CODE_PERSIST=on CODE_BUDGET_MB=<MB> deploy/wfp/site update <name>
```

- **Where it lives:** each install is one zip in the site's own bucket (`_code/<type>/<slug>/<sha256>.zip`), indexed in the site's own database. Every runtime boot mounts it again, and every request picks up a change.
- **The budget:** `CODE_BUDGET_MB` caps the installed code a site keeps in memory, and it is REQUIRED with `CODE_PERSIST=on`. It has no default on purpose: set it from the site's measured headroom (#394; `spikes/b2-wordpress/tests/measure394.py`). An install over the budget is refused in plain words in wp-admin, and nothing is left behind.
- **Deploy-only slugs:** plugins and themes the build ships (core themes, WooCommerce, `IMPORT_PLUGINS`) are not installed over or updated from wp-admin. Update them with a deploy.
- **Not recorded inputs:** like `PHP_INI` and `TURNSTILE_*`, both values are read from the run's environment only. An update that does not pass them turns the feature off. The stored code stays in the bucket and comes back when it is turned on again.
- **One-click sites stay locked** (`CODE_LOCK=on`) until Gate 2 of #422 shows this works.
- **Security:** see `deploy/provision/HARDENING.md`.
- **Tests:** `spikes/b2-wordpress/tests/code-store.test.mjs` (the crash windows, the sha check, the budget boundary, a second isolate), `tests/code-persist-e2e.sh` (local, the real installer), and `deploy/wfp/tests/render-test.sh`.

### Keeping the PHP runtime past 100 MiB: PHP_RECYCLE (#394)

`PHP_RECYCLE=off deploy/wfp/site update <name>` keeps the PHP runtime after a request whose WebAssembly memory passed 100 MiB. Without it, the next request boots a new runtime (`index.js`, `RECYCLE_WASM_BYTES`). A crashed runtime is still dropped.
- **What bounds memory then:** nothing in our code. The module's maximum is 2048 MiB, and with `USE_ZEND_ALLOC=0` PHP's `memory_limit` is not enforced by Zend's allocator. The hard stop is the isolate reset, about 188 MiB for WebAssembly alone and 144 MiB with the bundle (#411).
- **Use:** it is for measuring (experiment E1 on #394), and for a site whose admin pages keep recycling.
- **Not a recorded input:** read from the run's environment only, like `PHP_INI`. A same-build update uploads when the rendered value changes. `FORCE_UPLOAD=1` is the explicit override, not a requirement for this change. See "When an update uploads".
- **Tests:** `deploy/wfp/tests/render-test.sh`, golden case `php-recycle-off`.

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

**The OPcache follows the build inputs, never the builder's machine (#313).** `opcache.sh` primes from a fresh, empty local state on every run (`run.sh PERSIST_TO`), so a leftover `.wrangler/state` no longer decides what ships. WooCommerce pages are primed when `WOO_ACTIVE=1`, which `build_dosql` derives: an explicit `WOO_ACTIVE` (0 or 1) wins, else 1 when `woocommerce` is in `IMPORT_PLUGINS` or `PLUGINS`. A store whose site has WooCommerce active needs it: without the Woo scripts in the cache, the store compiles them inside the 128 MiB isolate and exceeds memory on every request (measured on ggc-test, 2026-11-12). `opcache-check.py` refuses a dump under 400 files, or under 500 WooCommerce files when `WOO_ACTIVE=1` (a primed store holds about 1500); `OPCACHE_MIN_FILES` and `OPCACHE_WOO_MIN` set the floors. A failed `opcache.sh` stops `build_dosql`, also under `site update --all`. Local priming needs `CLOUDFLARE_API_TOKEN` in the environment (the `browser` binding starts a remote proxy). Tests: `tests/woo-active-test.sh`, `spikes/b2-wordpress/tests/opcache-check-test.sh`.

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
