# Spike B2: WordPress on D1

WordPress 7.1.4 runs in a Worker as PHP 8.3 in WebAssembly. The database is D1. Run in local workerd.

## Run

```sh
npm ci
./prepare.sh          # loader for workerd
./build.sh            # WordPress tree: build/site.zip and build/public/
./run.sh _install     # installs WordPress into local D1
./run.sh              # then open http://localhost:8797/
./e2e.sh              # pages, login, admin, editor, REST write
php tests/dialect-test.php
```

Admin login for the local spike: `admin` / `local-spike-password`. These and the keys in `php/wp-config.php` are for local use only.

Each response has `x-d1-calls`, `x-d1-ms`, `x-d1-failures` and `x-php-ms`. `GET /_last` returns the statements of the last request.

## Deploy

```sh
export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
ENV=paid                                    # or free; see wrangler.toml
wrangler d1 create wp-on-d1-$ENV            # put its id in wrangler.toml [env.$ENV]
wrangler r2 bucket create wp-on-d1-$ENV-media  # the media library
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

Two uploads with the same name on two isolates would overwrite each other. The plugin reserves each file name with one atomic D1 insert, in the table `_r2_reserved`.

## Page cache

`[cache] enabled = true` turns on Workers Cache in front of the Worker. `index.js` marks logged-out public pages cacheable for 10 minutes (`PAGE_CACHE_TTL`) with `Cache-Tag: wp-pages` and `Vary: Cookie`. The mu-plugin `php/edge-cache.php` purges the tag when content changes. Add `?nocache` to a URL to skip the cache.

## How it fits together

| File | Job |
| --- | --- |
| `index.js` | Boots PHP, unzips WordPress into PHP's memory, runs D1 statements for PHP, routes requests. |
| `php/d1-pdo.php` | `D1_PDO`: the PDO the SQLite driver uses. Sends each statement to D1. |
| `php/db.php` | `wp-content/db.php`: loads the SQLite driver and gives it `D1_PDO`. |
| `php/wp-config.php` | Local config. |
| `build.sh` | Downloads pinned WordPress and `sqlite-database-integration`, assembles the tree, patches the plugin installer to use the D1 connection. |

## What D1 does differently, and what D1_PDO does about it

| D1 behaviour | D1_PDO |
| --- | --- |
| Refuses `sqlite_version()` | Answers `3.45.0` locally. |
| Refuses access to its own `_cf_*` tables | Hides them from schema reads, answers their pragmas with nothing. |
| Refuses unknown pragmas | Answers the driver's empty-result pragma locally. |
| Has no SQL transactions | Accepts BEGIN, COMMIT, SAVEPOINT, RELEASE without sending them. A ROLLBACK undoes nothing. |
| Cannot run PHP functions | `php/d1-dialect.php` rewrites them to plain SQLite, or computes them in PHP when the arguments are constant. |
