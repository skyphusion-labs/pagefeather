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
wrangler d1 create wp-on-d1-spike          # put its id in wrangler.toml [env.live]
wrangler deploy --env live
wrangler secret put WP_SALT --env live     # random, 32+ bytes
wrangler secret put SPIKE_TOKEN --env live # gates /_install, /_last, /_mem, /_peak
```

On Workers Free the install exceeds the CPU limit. Load the database from a local install instead: `wrangler d1 export b2-local --local --output dump.sql`, then `wrangler d1 execute <db> --remote --env live --file dump.sql`, then set the admin password.

`SPIKE_TOKEN=... ADMIN_PASSWORD=... ./e2e.sh https://<worker>.workers.dev` runs the same checks against a deploy.

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
