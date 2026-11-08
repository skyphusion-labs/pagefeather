# Spike B2: WordPress on D1

WordPress 7.1.4 runs in a Worker as PHP 8.3 in WebAssembly. The database is D1. Run in local workerd.

## Run

```sh
npm ci
./prepare.sh          # loader for workerd; patches the binary (memory, OPcache SAPI list)
./build.sh            # WordPress tree: build/site.zip and build/public/
./opcache.sh          # precompiled PHP: build/opcache.zip (runs e2e.sh on wrangler dev)
./run.sh _install     # installs WordPress into local D1
./run.sh              # then open http://localhost:8797/
./e2e.sh              # pages, login, admin, editor, REST write
php tests/dialect-test.php
php tests/zone-cache-purge-test.php   # zone cache purge-on-publish (#205)
node --test tests/purge-zone.test.mjs # zone purge op + gate helpers (#205)
```

Admin login for the local spike: `admin` / `local-spike-password`. These and the keys in `php/wp-config.php` are for local use only.

Each response has `x-d1-calls`, `x-d1-ms`, `x-d1-failures` and `x-php-ms`. `GET /_last` returns the statements of the last request.

## Deploy

```sh
export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
ENV=paid                                    # or free; see wrangler.toml
wrangler d1 create wp-on-d1-$ENV            # put its id in wrangler.toml [env.$ENV]
wrangler r2 bucket create wp-on-d1-$ENV-media  # the media library
wrangler r2 bucket lifecycle add wp-on-d1-$ENV-media staging-expiry staging/ --expire-days 1  # refused large uploads
wrangler deploy --env $ENV
wrangler secret put WP_SALT --env $ENV      # random, 32+ bytes
wrangler secret put SPIKE_TOKEN --env $ENV  # gates /_install, /_last, /_mem, /_peak
curl -X POST -H "x-spike-token: ..." -H "x-admin-password: ..." https://<worker>.workers.dev/_install
```

On Workers Paid the install runs in one request (about 32 s). On Workers Free it exceeds the CPU limit. Load the database from a local install instead: `wrangler d1 export b2-local --local --output dump.sql`, then `wrangler d1 execute <db> --remote --env free --file dump.sql`, then set the admin password.

`SPIKE_TOKEN=... ADMIN_PASSWORD=... ./e2e.sh https://<worker>.workers.dev` runs the same checks against a deploy.

## Media library on R2

`php/r2-uploads.php` is an mu-plugin. It stores uploads in the R2 bucket bound as `MEDIA`, and the Worker serves `/wp-content/uploads/*` from that bucket before PHP runs. URLs do not change.

The design is from Human Made's [S3 Uploads](https://github.com/humanmade/S3-Uploads) (GPL-2.0): a stream wrapper plus the `upload_dir` filter. S3 Uploads uses the AWS SDK over HTTPS. A Worker gives PHP no network, so our `r2://` wrapper sends each operation (get, head, put, delete, list) through `post_message_to_js()` to the Worker, and the Worker calls the R2 binding. See `docs/prior-art.md`.

Without the `MEDIA` binding the plugin is off, and uploads stay in one isolate's memory.

Image sizes come from the Cloudflare Images binding (`IMAGES`), not GD. `php/cf-images-editor.php` is a WordPress image editor whose resize, crop, rotate and flip calls become Images transforms. The Worker reads the source from R2, runs the transforms, and writes the result to R2, so image bytes never enter PHP. GD in a 128 MB isolate cannot decode a normal phone photo.

A media upload over 1 MB (up to 20 MB) goes from the Worker straight to R2 under `staging/`. PHP gets a small marker, and the file is copied to its final name inside R2. So a phone photo never comes into PHP's memory.

Two uploads with the same name on two isolates would overwrite each other. The plugin reserves each file name with one atomic D1 insert, in the table `_r2_reserved`.

## Page cache

`[cache] enabled = true` with `exports.Pages.cache` turns on Workers Cache for the `Pages` entrypoint only. The default entrypoint is the gateway (not cached): it sends a page request with no WordPress cookie to `Pages` without its Cookie header, so other cookies do not split the cache key (issue #63). `index.js` marks logged-out public pages cacheable at the edge for `PAGE_CACHE_TTL` seconds (default 120) with `Cache-Tag: wp-pages`; the browser gets `no-cache`. The mu-plugin `php/edge-cache.php` purges the tag when content changes, through `Pages.purge()`. Add `?nocache` to a URL to skip the cache. See `docs/approach-b.md` 8c.

## PHP in a Durable Object (Workers Free)

`PHP_IN_DO=on` runs PHP in the `PhpRuntime` Durable Object (binding `PHP_RUNTIME`), not in the Worker. A Worker request on Free stops at about 2 s of CPU; an object request may use 30 s. The Worker keeps static assets, R2 uploads and the page cache. The design is from HostlessWP. Local check: `DEV_ENV=do-local ./opcache.sh`, then `DEV_ENV=do-local ./run.sh` and `./e2e.sh`. Deploy env: `do-free`. See `docs/approach-b.md` 8i.

## The database in the PHP object

With `PHP_IN_DO=on`, `DB_IN_DO=on` makes the object's own SQLite (`ctx.storage.sql`) the WordPress database, in place of D1. No network per query. `/_install` installs into it. `dbmove.py` exports and imports a site (also from D1). Local check: `DEV_ENV=dosql-local ./opcache.sh`, then `DEV_ENV=dosql-local ./run.sh` and `./e2e.sh`. Deploy env: `dosql-free`. See `docs/approach-b.md` 8j.

## WooCommerce

WooCommerce is in the build (`WOO_VERSION` in `build.sh`). `tests/woo.py` runs a store and a guest checkout. Activate it with `POST /_activate?plugin=woocommerce/woocommerce.php` (spike token). On Paid, checkout exceeds the isolate memory limit; see `docs/approach-b.md` 8f.

## How it fits together

| File | Job |
| --- | --- |
| `index.js` | Boots PHP, unzips WordPress into PHP's memory, runs D1 statements for PHP, routes requests. |
| `php/d1-pdo.php` | `D1_PDO`: the PDO the SQLite driver uses. Sends each statement to D1. |
| `php/db.php` | `wp-content/db.php`: loads the SQLite driver and gives it `D1_PDO`. |
| `php/wp-config.php` | Local config. |
| `opcache.sh` | Boots the Worker locally with an empty OPcache, runs `e2e.sh`, saves the compiled files to `build/opcache.zip`. Run before a deploy. |
| `build.sh` | Downloads pinned WordPress and `sqlite-database-integration`, assembles the tree, patches the plugin installer to use the D1 connection. |

## What D1 does differently, and what D1_PDO does about it

| D1 behaviour | D1_PDO |
| --- | --- |
| Refuses `sqlite_version()` | Answers `3.45.0` locally. |
| Refuses access to its own `_cf_*` tables | Hides them from schema reads, answers their pragmas with nothing. |
| Refuses unknown pragmas | Answers the driver's empty-result pragma locally. |
| Has no SQL transactions | Accepts BEGIN, COMMIT, SAVEPOINT, RELEASE without sending them. A ROLLBACK undoes nothing. |
| Cannot run PHP functions | `php/d1-dialect.php` rewrites them to plain SQLite, or computes them in PHP when the arguments are constant. |
