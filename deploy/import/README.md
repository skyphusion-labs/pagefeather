# Import an existing WordPress site (issue #31)

`deploy/import.sh` moves an existing WordPress site into a site that `deploy/deploy.sh` made: the database, the uploads, and the theme and plugins. The source site is only read. Nothing in the script connects to it: you give it a dump file.

This version supports the variants `b-dosql` (the database is the SQLite of the PHP Durable Object), `c1` (the database, uploads, theme and plugins; see "Variant c1") and `a`, with `a2` (the database, uploads, theme and plugins; see "Variant a and a2"). The design for the other variants is in [issue #31](https://github.com/skyphusion-labs/wordpress-on-cloudflare/issues/31). Prior art: [docs/prior-art.md](../../docs/prior-art.md), "Moving existing sites".

## Use

1. On the source server, make a dump with `--hex-blob`:

   ```sh
   wp db export site.sql --hex-blob
   # or
   mysqldump --single-transaction --hex-blob -u USER -p DATABASE > site.sql
   ```

   Also make an archive of `wp-content` (the uploads, themes and plugins):

   ```sh
   tar czf wp-content.tar.gz -C /path/to/wordpress wp-content
   ```

2. Run a dry run. It reads the dump and the archive, and prints the `deploy.sh` line that builds the site's theme and active plugins in:

   ```sh
   URL=https://my-site.acct.workers.dev DUMP=site.sql CONTENT=wp-content.tar.gz SPIKE_TOKEN=x DRY_RUN=1 ./deploy/import.sh
   ```

3. Make the target site with that line: `IMPORT_CONTENT=... IMPORT_THEMES=... IMPORT_PLUGINS=... VARIANT=b-dosql MEDIA=1 NAME=my-site ./deploy/deploy.sh`. `MEDIA=1` makes the R2 media bucket for the uploads.

4. Import:

   ```sh
   URL=https://my-site.acct.workers.dev NAME=my-site DUMP=site.sql CONTENT=wp-content.tar.gz ./deploy/import.sh
   ```

   With `CONTENT`, the uploads go to the media bucket. That needs `CLOUDFLARE_API_TOKEN` and `ACCOUNT_ID`, as for `deploy.sh`.

   `NAME` reads `SPIKE_TOKEN` from the Terraform workspace of `deploy.sh`. You can set `SPIKE_TOKEN` instead.

   On PlanetScale (Vitess), use MySQL's `mysqldump` without `--single-transaction`: Vitess refuses `ROLLBACK TO SAVEPOINT`, so that flag fails. `mariadb-dump` also fails, because it sends `MAX_STATEMENT_TIME`, which only MariaDB has (measured by the lead on 2026-11-06 with mysqldump 8.4 against the a2 test database).

The import replaces the whole database of the target site. Log in with the users and passwords of the source site.

Options: `DRY_RUN=1` stops before the import and shows what changes. `SKIP_MEDIA=1` does not send the uploads (the script says that the images are missing). `OLD_ORIGIN` sets the old site address (default: the `home` option of the dump). `ALLOW_MISSING=1` imports when the theme or an active plugin is not in the build. `WORK` sets the directory for the work files.

## A source that is already SQLite

A site that already keeps its database in SQLite made by the `sqlite-database-integration` driver needs no MySQL dump. A c1 container store is one example, and so is its Litestream replica restored to a file. Give the file as `SQLITE` in place of `DUMP` (variant `b-dosql` only):

```sh
URL=https://my-site.acct.workers.dev NAME=my-site SQLITE=store.sqlite CONTENT=wp-content.tar.gz ./deploy/import.sh
```

`deploy/import/sqlite-source.php` takes the place of step 2. It reads the file over a read-only connection and writes a consistent copy (`VACUUM INTO`), so the source is never changed. It then prints the same report as a dump: the rows of each table read back through the driver, and the site facts. Search-replace, the dbmove import and the per-table count check (steps 3 to 7) run unchanged. The report also carries `"source": "sqlite"` and `driver_version`, the driver version recorded in the file (`_wp_sqlite_global_variables`).

It refuses, with exit 1 and before it writes any file, each of these:
- a file that `PRAGMA integrity_check` does not call `ok`;
- a WAL beside the file that is not empty, because the copy would miss what is only in the WAL (checkpoint it, or restore to a file first);
- a file the driver did not make;
- a file made by a driver newer than the pinned one (`SQLITE_DI_REF`). An older one is fine, because the driver configures an older file for its own version at first use;
- a table prefix other than `wp_`, because the driver cannot rename a table (import that site through a MySQL dump, which renames as it reads);
- a multisite network.

Tests: `tests/run.sh` section 11. The rows and site facts match the dump path for the same fixture, and the source file's SHA-256 is unchanged. Each refusal leaves no output file. Two mutations turn a test red: the WAL check off, and the prefix check off.

## The site's own mu-plugins

A mu-plugin always runs, so the import copies none unless you name it. The build's run of `content.sh` lists the source's mu-plugins: `content: mu-plugins in the source, NOT copied unless named in IMPORT_MU_PLUGINS`. To build some in, add `IMPORT_MU_PLUGINS` (file or directory names under `mu-plugins/`) to the `deploy.sh` line the import printed:

```sh
IMPORT_CONTENT=... IMPORT_THEMES=... IMPORT_PLUGINS=... IMPORT_MU_PLUGINS="shop-cart.php shop-cart.js" VARIANT=b-dosql MEDIA=1 NAME=my-site ./deploy/deploy.sh
```

`spikes/b2-wordpress/build.sh` and `spikes/c1-woo-container/build.sh` copy them with `content.sh --mu` AFTER the build's own mu-plugins. A name the build already has (for example `edge-cache.php` or `r2-uploads.php`) is refused, so a site's mu-plugin never replaces one of the framework's. The same rules as for plugins apply: a name with `/` or `..`, a missing name and a symbolic link are refused. A mu-plugin written for the old host (for example one that reads a file only that host had) still needs reading before you name it.

Tests: `tests/run.sh` section 6b. A mutation with the name check off lets a site's `edge-cache.php` replace the framework's, and the test turns red.

## Into a Workers for Platforms site

For a site of `deploy/wfp`, use `deploy/wfp/site import <name>` (see `deploy/wfp/README.md`, "Importing an existing site"). It reads the site's origin, `SPIKE_TOKEN` and media bucket from that site's workspace. It makes a key for the bucket and deletes it, and passes the bucket and key to `import.sh` as `MEDIA_BUCKET`, `R2_ENDPOINT`, `R2_KEY_ID` and `R2_SECRET`. With those four set, `import.sh` reads no Terraform state for the uploads.

## Read the source over SSH

In place of `DUMP` and `CONTENT`, give the server and the WordPress directory there:

```sh
SSH=user@old-host SSH_WP=/var/www/html URL=https://my-site.acct.workers.dev NAME=my-site ./deploy/import.sh
```

`import.sh` sends `deploy/import/remote-export.sh` over `ssh <host> bash -s` twice: once for the database, once for `wp-content`. The two results go into `WORK`, and the import goes on as with files. Nothing is installed on the server.

- **Read only.** The script writes nothing on the server: no file, no temp file. The dump uses `--single-transaction --skip-lock-tables`, so it takes no lock, and InnoDB tables stay writable while it runs. Its only output is stdout.
- **The database:** with WP-CLI on the server, `wp db export -` (with `--hex-blob`). Without it, `mysqldump` with the `DB_*` constants of `wp-config.php`. The script reads the file as text (`php -r` with a regular expression), so `wp-config.php` does not run. A constant that is not a plain string (for example `getenv(...)`) is an error.
- **No credential leaves the server, and none is stored.** SSH uses your own SSH setup (agent, `~/.ssh/config`). The database password goes to `mysqldump` in a defaults file on a pipe (process substitution): it is not in the arguments, not on the server's disk, and not sent here. Nothing goes into the repository.
- **`wp-content`:** a gzip tar, without cache-like folders. `SSH_EXCLUDE` (a space list of paths under `wp-content`) replaces the default `cache upgrade ai1wm-backups updraft backups-dup-lite wflogs`. `SSH_CONTENT=0` skips `wp-content`.
- **`SSH_CMD`** (default `ssh`) adds options, for example `SSH_CMD="ssh -p 2222 -i ~/.ssh/old-host"`. It is split on spaces.
- **The server needs** bash, and WP-CLI, or `php` and `mysqldump`.

Tests (`tests/run.sh` section 10): the script runs here through a fake `ssh`, on a fake site whose WordPress tree, `HOME` and `TMPDIR` are read-only. The checks:
- the dump comes through `mysqldump` (and through WP-CLI when it is there);
- the password is not in the arguments, and it is decoded as PHP does: `\n` in single quotes stays two characters;
- the port comes from `DB_HOST`;
- `cache` is left out;
- nothing on the server changes;
- `import.sh SSH=...` reaches its dry run, with a space in the server path.

Six mutations each turn a test red: a temp file on the server, the password in the arguments, no `--skip-lock-tables`, C escapes in single quotes, the exclude list ignored, and the remote command without `%q`. Not run against a real server.

## Steps

| Step | Tool | What it does |
| --- | --- | --- |
| 1 | `import.sh` | Gets the SQLite driver at `SQLITE_DI_REF` of `spikes/b2-wordpress/build.sh`. The driver writes its own `_wp_sqlite_*` tables, and the runtime reads them, so the version must be the same. |
| 2 | `dump-to-sqlite.php` | Runs the dump through the driver into a new SQLite file. Changes the table prefix to `wp_`. Prints the rows of each table, the site address, the theme and the active plugins. |
| 3 | `search-replace.py` | Changes the site address to the new origin. Safe for PHP serialized data. |
| 4 | `untar.py`, `import.sh` | With `CONTENT`: extracts the archive safely and prints the `deploy.sh` line for the theme and plugins. Then stops if the theme or an active plugin is not in the local build. |
| 5 | `dbmove-file.py`, `spikes/b2-wordpress/dbmove.py` | Writes the SQLite file as a `dbmove` dump and imports it into the PHP object. |
| 6 | `dbmove.py export`, `dbmove-file.py counts` | Exports the database again and compares the rows of each table. |
| 6b | `media.sh` | With `CONTENT`: puts `wp-content/uploads` into the media bucket (see "Uploads"). |
| 7 | `import.sh` | Gets the home page without the page cache. It must be HTTP 200. |

## Variant c1

`c1` keeps its database in SQLite on the container disk, and Litestream replicates it to R2 at `REPLICA_PATH` (default `store`) in the replica bucket. The import does not change that replica. It runs in two phases:

1. **Seed.** `VARIANT=c1 URL=... NAME=my-store DUMP=site.sql ./deploy/import.sh`, with `CLOUDFLARE_API_TOKEN` and `ACCOUNT_ID`. The script makes the database as for `b-dosql` (steps 1 to 3), with no WAL beside it. It puts the file at `<new path>.seed.sqlite` in the replica bucket, with the site's Litestream key (object read and write on the replica bucket only; `deploy/terraform/c1.tf`). The new path is `import-<time>`. Then it prints two lines: the `deploy.sh` line and the check line.
2. **Deploy** with `REPLICA_PATH=<new path> SEED_SHA256=<sha>`, and with your other `c1` options the same as before. The next container finds no replica at the new path, so it loads the seed (`spikes/c1-woo-container/container/seed.sh`). Then Litestream replicates it, and every later start restores it.
3. **Check.** `VARIANT=c1 VERIFY=1 WORK=<the same WORK> ... ./deploy/import.sh` reads `/_stats.php?what=seed`: the SHA-256 and the rows of each table that the container loaded before PHP ran. It compares them with the seed, then gets `/`.

The container stops (it does not start) if the seed download or its SHA-256 check fails, so it never installs an empty site over an import. To go back, deploy with the old `REPLICA_PATH`: its replica is unchanged.

**With `CONTENT`** (a `wp-content` archive):
- The seed phase also puts the uploads into the site's media bucket (`media.sh`, the same key that `b-dosql` uses). The c1 Worker serves `/wp-content/uploads/<path>` from the key `uploads/<path>` too.
- The printed `deploy.sh` line starts with `IMPORT_CONTENT=... IMPORT_THEMES=... IMPORT_PLUGINS=...`. `spikes/c1-woo-container/build.sh` copies them in with `content.sh`, under the same rules as for `b-dosql`.
- The deploy comes after the seed, so the build check accepts a theme or plugin that is in the c1 build or in the archive. Without the archive, a plugin that only the site had stops the seed phase with `NOT IN THE BUILD`.
- Run a dry run first (`DRY_RUN=1`, with `NAME`, `CLOUDFLARE_API_TOKEN` and `ACCOUNT_ID` set) to see the line.

## Variant a and a2

`a` is PHP in the Worker with MySQL through Hyperdrive: MariaDB on the box of `deploy/mysql` (`MYSQL=vultr`), or PlanetScale (`a2`, `MYSQL=external`). That MySQL accepts only Cloudflare, so the import goes through the site's Worker: `VARIANT=a URL=... NAME=... DUMP=site.sql ./deploy/import.sh`.

1. Steps 1 and 2 as for `b-dosql` (the dump in SQLite gives the prefix and the site facts).
2. `GET /_sqlimport?info=1`: the server version (MariaDB or MySQL) and its `max_allowed_packet`. The value comes from the server (`SELECT @@max_allowed_packet`, then `SHOW VARIABLES`, because through Vitess a system variable SELECT can return no row). With no value, the import stops: it never guesses a size.
3. `mysql-prepare.py` makes the statements:
   - The prefix becomes `wp_` only in table names (`DROP TABLE`, `CREATE TABLE`, `INSERT INTO`), in the option `<prefix>user_roles` and in the user meta keys that start with the prefix. The columns are found by name in the dump's `CREATE TABLE`. Never in other content: a post that names `wpx_options` keeps it.
   - The site address changes in the string values, safe for serialized data, except in `guid`.
   - Hyperdrive does not keep session settings between statements, so mysqldump's `NO_AUTO_VALUE_ON_ZERO` line would not reach its INSERTs. Each INSERT carries its own: `SET_VAR(sql_mode='NO_AUTO_VALUE_ON_ZERO')` on MySQL and PlanetScale, and `SET STATEMENT sql_mode='NO_AUTO_VALUE_ON_ZERO' FOR` on MariaDB.
   - An INSERT is split between rows to fit `max_allowed_packet` (less 1 KiB), and at most 1.4 MB (one part of the request).
   - A `CREATE TABLE` string with a backslash after `DEFAULT` becomes a hex literal. Wordfence has `binary(16) DEFAULT '\0...'`. With a backslash, the server's `sql_mode` (`NO_BACKSLASH_ESCAPES`) would decide what the string means.
   - Tables without the prefix, triggers and routines are not imported, and the script lists them.
4. **Preflight:** every `CREATE TABLE` of the dump runs first under a scratch name (`wp_impchk_<n>`) in the DDL mode (below), and is dropped again. A `CREATE` that the server refuses stops the import here, and the site is not changed.
5. `POST /_sqlimport?replace=1` (part 0), then the other parts. **`replace=1` drops every `wp_` table first. A run that stops after that, for example on an INSERT the server refuses, leaves the site EMPTY or PARTIAL.** The script prints the part, the line and the error where it stopped. Fix the cause and import again.
6. `GET /_sqlimport?counts=1`: `COUNT(*)` of every `wp_` table, compared with the rows of the dump, then `GET /`.

**DDL mode.** A `CREATE TABLE` runs as `BEGIN`, `SET SESSION sql_mode='NO_AUTO_VALUE_ON_ZERO'`, the `CREATE`, then `COMMIT` (whenever `BEGIN` ran). A `SET_VAR` hint cannot go on DDL. Through Hyperdrive and Vitess, a `SET` holds for the next statement only inside a transaction (`docs/approach-a2.md`, probe E2; `php/hyperdrive-db.php` does the same). The first deployed round trip into `wp-a2` (2026-11-06, from `ed0dcc8`) had no DDL mode. It stopped at `CREATE TABLE wp_actionscheduler_actions`: `Invalid default value for 'scheduled_date_gmt'` (errno 1067), PlanetScale's strict mode against `DEFAULT '0000-00-00 00:00:00'`. That happened after `replace=1`, so `wp-a2` was left empty. That is why the preflight exists. `id-zero.sh` did not show it, because its table has no date column. MariaDB's default mode may accept zero dates, and then MariaDB hides this defect. `info=1` now reports the server's `sql_mode` (null through Vitess), so a run shows which mode the server has.

**`/_sqlimport`** (`spikes/b2-wordpress/sql-import.js`):
- It serves variant `a` only, `a2` included; every other variant gets 404. It needs the `SPIKE_TOKEN` secret and its header; with no secret it refuses, unlike other spike endpoints.
- Before it runs any statement of a request, it checks all of them. It allows only `DROP TABLE IF EXISTS`, `CREATE TABLE` (column list and table options) and `INSERT ... VALUES` with literals, on a table named `wp_*`. Refused: `GRANT`, `SET` (`SET GLOBAL` included), `LOAD DATA`, `SELECT`, `INTO OUTFILE`, a function in `VALUES` (for example `LOAD_FILE`), `DATA DIRECTORY`, a comment, a second statement. Tests: `tests/sqlimport-check.mjs` and `tests/sqlimport-endpoint.mjs` (both in `run.sh`).

**With `CONTENT`:** the same path as `b-dosql`. Step 4 extracts the archive, prints the `deploy.sh` line and checks the b2 build (`deploy.sh` builds variant `a` with `ENGINE=a` and the `IMPORT_*` variables). Step 6b puts the uploads into the media bucket after the database (a site with `MEDIA=1`). No code is particular to `a` here. Run locally on 2026-11-06 against a stand-in for an `a` site (`/_sqlimport` and `/`) with the a2 dump and the WordPress 7.1.4 archive: line printed, preflight 98, every table matches (8583 rows), upload step reached (`SKIP_MEDIA=1`), `GET /` 200. Not run on a deployed `a` site.

**Query cache:** confirmed OFF, not changed. Terraform makes the Hyperdrive config of variant `a` with `caching = { disabled = true }` (`deploy/terraform/main.tf`, `cloudflare_hyperdrive_config.wp`), and `a2` is variant `a`, so it uses the same resource. The count reads do nothing to avoid a cache.

**Id 0:** `tests/a/id-zero.sh` imports rows (0, 5) into `wp_idzero_test` on a deployed site, with the hint and, as the red control, without it (`NO_HINT=1`). It must read the lowest id 0 with the hint and 1 without. It touches only that table. Measured 2026-11-06 by the lead, deployed from `03d8676` (rows in `docs/results.md`):

| Site | Server | With the hint | Without it (red control) |
| --- | --- | --- | --- |
| `wp-ref-a` | MariaDB 10.11.14 | 2 rows, lowest id 0 | 2 rows, lowest id 1 |
| `wp-a2` | PlanetScale 8.4.11-Vitess | 2 rows, lowest id 0 | 2 rows, lowest id 1 |

So the hint keeps id 0 on both servers, and without it both renumber.

**Round trip on PlanetScale, measured 2026-11-06** (`docs/results.md`). The a2 dump went back into `wp-a2`, run by the lead from a worktree that never deployed the site, with `DEPLOY_STATE=r2`:

| Run | Code | Result |
| --- | --- | --- |
| 1 (04:31Z) | `ed0dcc8`, no DDL mode | FAIL at `CREATE TABLE wp_actionscheduler_actions`: errno 1067, the zero-date default under PlanetScale's strict mode. It stopped after `replace=1`: `wp-a2` was left empty. |
| 2 | `3e1e033`, DDL mode and preflight | Pass. Preflight 98 `CREATE TABLE`; 228 statements in 1 part (52 tables dropped first); every table matches, 8583 rows in 98 tables; `GET /` 200. The site came back. |

"address changed in 3 values" on a round trip: three `http://wp-a2...` values became `https://`.

**Not measured yet: MariaDB with the DDL mode.** A round trip into `wp-ref-a` is a separate step. The a2 dump is plain mysqldump output, so it can be the source there too. With it, the address changes from `wp-a2` to `wp-ref-a`. The first run on `wp-ref-a` (from `a2a9c11`) read every count as null: `mysql-bridge.js` returns a binary-charset column as `{"$b": base64}`, and MariaDB reports `COUNT(*)` and `MIN()` that way. `sql-import.js` now decodes every cell, and a count that is not an integer is an error.

## Theme and plugins (build input)

`spikes/b2-wordpress/build.sh` copies them when `IMPORT_CONTENT` is set (`deploy/import/content.sh`):

- `IMPORT_THEMES`: theme directories (the active theme and its parent). `IMPORT_PLUGINS`: plugin directories or one-file plugins (the part before the first `/` of each entry in `active_plugins`).
- A theme or plugin of the same name in the build is replaced, so the site runs its own version, which matches its database. The exception is `sqlite-database-integration`: the runtime needs the build's pinned copy.
- Not copied: drop-ins (`wp-content/*.php`, for example `db.php`, `object-cache.php`, `advanced-cache.php`: the build has its own), and `mu-plugins`. The script lists both, so you can decide.
- Refused: a name with `/` or `..`, a name that is not in the archive, and a symbolic link in a copied tree (zip follows links, so a link could put files from your computer into the site).
- The Worker has a size limit. Each plugin adds to `site.zip`; `build.sh` prints its size.

## Uploads

`media.sh` puts each file `wp-content/uploads/<path>` at the key `uploads/<path>` of the media bucket. That is the key the Worker serves at `/wp-content/uploads/<path>`, and the key `php/r2-uploads.php` writes, so the URLs of the site do not change. The content type comes from the file name.

- It uses R2's S3 API (`curl --aws-sigv4`, as `deploy/variants/r2-empty.sh` does) with a key that exists only for this step: `import.sh` applies Terraform with `media_import = true` (`deploy/terraform/media-import.tf`: object read and write on this site's media bucket only), sends the files, and applies with `false` again, which deletes the key. A trap deletes it when a step fails too.
- Not sent: PHP files and dot files (for example `.htaccess`), which the Worker never runs or serves, and paths whose key is longer than 1,024 bytes.
- Resumable: a key that exists with the same size is not sent again. `import.sh` runs `media.sh` twice, and the second run must send nothing. That is the check.
- Only a HEAD of 404, or a 200 with another size, means "send it" (issue #124). A HEAD that is refused or fails (401, 403, a curl error, a 5xx) is tried again for `R2_RETRY_S` (90) s, and then the file fails with the code (`fail head 403 <key>`). It never counts as missing: on 2026-11-06 (`wp-c1-w92b`) the check run sent a file again right after the first run, which is what a refused HEAD did then. A PUT of 401 or 403 is tried again in the same way. `tests/media-refuse-test.sh` covers it.
- `JOBS` (default 8) sets the requests at a time.

## The archive

`untar.py` treats the archive as untrusted. It stops and extracts nothing if a member is a link, a device or a FIFO, or has an absolute path or `..`. It makes only files and directories, with mode 644 or 755 (no setuid). It skips macOS metadata (`._name` files, which `tar` on macOS adds, and `__MACOSX/`). The archive can have `wp-content/` at its top, or the contents of `wp-content`.

## Rules and limits

- **`--hex-blob` is necessary.** Without it, mysqldump writes binary values as `_binary '...'`. The driver (3.1.3) does not read a character set introducer, so the script stops on that statement and tells you to use `--hex-blob`. Upstream issue [#456](https://github.com/WordPress/sqlite-database-integration/issues/456) (charset and collation support) is open and can be related.
- **The table prefix becomes `wp_`.** The runtime reads `wp_options` by name. The prefix changes in the dump text, before the driver reads it. The driver cannot rename a table after it makes it: `ALTER TABLE ... RENAME TO` returns no error and does not change the table, and `RENAME TABLE` is not supported (3.1.3, measured 2026-11-06). The script also changes the option `<prefix>user_roles` and the user meta keys that start with the prefix. A table without the prefix keeps its name.
- **The site address.** `home` and `siteurl` must be the same origin with no path. WordPress in a subdirectory is not supported. Both schemes (`http://` and `https://`) of the old host change to the new origin. So does the JSON form (`https:\/\/`). A longer host (`old.example.com.other.net`) or another port does not change. The `guid` column does not change (WordPress uses it as an identifier). A `C:` serialized value (custom serialization) does not change, and the output counts it.
- **Not supported:** a multisite network (a `<prefix>blogs` table), and a dump that is not one site.
- **The work files hold the site's data** (user e-mail addresses and password hashes). The directory is mode 700. Remove it when you are done.
- **Numbers.** A dump file from `dbmove-file.py` writes a whole REAL value as `1.0`. The Worker writes it as `1`. The columns are REAL, so SQLite stores both as REAL. That is why step 6 compares row counts, not the text of the rows.

## Terraform state

`import.sh` reads the site's spike token (with `NAME`) and makes the media key from the site's Terraform state. It initialises Terraform as `deploy.sh` does (`deploy/tf-backend.sh`). It never makes a workspace: a site it cannot find is an error that says what to do.

- **Local state (the default)** is only in the clone that ran `deploy.sh` (`deploy/terraform/terraform.tfstate.d/`). Run `import.sh` in that clone.
- **`DEPLOY_STATE=r2`** (with `STATE_BUCKET`, `STATE_ENDPOINT` and the R2 key) works from any clone. If that clone has no `sites/<name>.tfvars`, the script takes the same values from the state's outputs.
- The media key applies use `-target=cloudflare_account_token.media_import`, so they cannot change any other resource of the site.

A fresh clone failed before this with `Required plugins are not installed` (2026-11-06): the script read outputs without `terraform init`.

## Local tests cannot see the edge

A deployed `workers.dev` site has security checks at the edge that `wrangler dev` does not have. The first deployed import (2026-11-06, `wp-import-test`, Workers Paid) stopped at `dbmove.py import`, part 0, with `HTTP 403 error code: 1010`: the edge refused Python urllib's default User-Agent (`Python-urllib/3.x`). Every local test had passed. Nothing reached the object. Now `dbmove.py` sends `User-Agent: wp-on-cf-import/1` (test: `tests/test_user_agent.py`), and so do the `curl` calls of `import.sh` to the site. So a deployed run is part of the gate for this tool, not an extra.

## Fixed on the way

- `dbmove.py import` stopped at part 1 for every dump of more than one part (1.5 MB): part 0 made the tables, and `/_dbimport` refused the next part because tables existed. The second and later parts now send `append=1`.
- `/_dbimport` did not purge the page cache, so logged-out pages showed the old site until the cache time ran out. The import now asks the Worker to purge (`x-php-purge`).

## Measured

2026-11-06, `wrangler dev --env dosql-local` (local, no plan), Wrangler 4.107.0 on macOS. Source: a mysqldump 8.4 (no `--single-transaction`) of the test site of variant `a2` on PlanetScale: WordPress 7.1.4, WooCommerce with test orders and products, and the tables of the 18 plugins of the plugin suite (98 tables, 8583 rows in the dump). No customer data. Command: `URL=http://localhost:8831 SPIKE_TOKEN=local DUMP=wp-a2-dump.sql ./deploy/import.sh`. Result: 3 parts imported, every table matched (10067 rows with the driver's tables), `GET /` 200 with the site title of the source. A test on a deployed site is next; it is not **measured** on a plan yet.

Slice 2, 2026-11-06, same local Worker: `build.sh` with `IMPORT_CONTENT` from the `wp-content` of WordPress 7.1.4 (a macOS `tar` archive: 504 `._` entries skipped) built Akismet and `hello.php` into `site.zip` and `public/`. `import.sh` with `CONTENT` and `SKIP_MEDIA=1` imported the a2 dump as before (every table matched, `GET /` 200). The R2 upload (`media.sh` with the Terraform key) needs a deployed site with `MEDIA=1`: not run yet.

`c1`, 2026-11-06, local (no Docker on this computer, so no container): `tests/run.sh` runs `seed.sh` against the stand-in. It checks a good seed, a wrong SHA-256, a missing object, a restored database (it wins), and no `SEED_SHA256`. Then the `c1` build's own WordPress tree (`spikes/c1-woo-container/build.sh`, WooCommerce in it) ran under `php -S` with `router.php` on the a2 seed (made by `import.sh` steps 1 to 3). `/`, `/?p=1`, `wp-login.php` and the shop page were HTTP 200, with no PHP errors. The real container, Litestream and the deploy are not run yet.

Variant `a`, 2026-11-06, local (no MySQL on this computer): `mysql-prepare.py` on the a2 dump, for MySQL and for MariaDB, made 228 statements with 8583 rows. The address changed in 26 values, as `search-replace.py` does on SQLite. `checkStatement` of the endpoint allowed all 228. Eight `CREATE TABLE` statements of Wordfence were refused before the hex `DEFAULT` rewrite. The import into MySQL is not run yet.

`c1` with `CONTENT`, 2026-11-06, local: a dump whose only active plugin is `my-shop` (in no build) and an archive with `wp-content/plugins/my-shop`. With `CONTENT`, the seed dry run passed and printed `IMPORT_PLUGINS=my-shop`. Without it (the red control), it stopped: `NOT IN THE BUILD: plugin my-shop/my-shop.php`, exit 1. `spikes/c1-woo-container/build.sh` with `IMPORT_CONTENT` and `IMPORT_PLUGINS=my-shop` put `my-shop` in the tree; the default build did not have it. A mutation that removed the build-or-archive rule made the run with `CONTENT` stop.

**Deployed, 2026-11-06** (`docs/results.md`): `wp-import-c1`, a fresh c1 site, from `e7241ff`, run by the lead. The source was the a2 dump with `my-shop` active, plus an archive with `my-shop` and one upload.

| Step | Result |
| --- | --- |
| Seed | 3874816 bytes at `import-20261106t064157z.seed.sqlite` |
| Uploads | 1 sent; the check run 0 sent; the import key deleted |
| Deploy | with the printed line: exit 0, first answer 200 after 15 s |
| `VERIFY=1` | every table matches (10067 rows in 107 tables), `GET /` 200 |
| Upload through the site | `x.jpg` 200, 4 bytes, from R2 |
| Plugin | `my-shop.php` is in the container (200; a missing path gives 301). That it is active is shown only by the seed rows, not by `plugins.php`: there is no admin password for the a2 users. |

The first deploy of `wp-import-c1` failed at the Docker build (`read-only file system`) when the laptop disk filled. That is a result too.

## Measured on a deployed site

2026-11-06, `wp-import-test` (`VARIANT=b-dosql`, `MEDIA=1`, Workers Paid, `workers.dev`), from `plugin-parity` at `508d65d`, run by the lead. Command: `URL=... NAME=wp-import-test DUMP=wp-a2-dump.sql CONTENT=wp-content.tar.gz ./deploy/import.sh`. Source: the a2 dump above and a macOS `tar` of WordPress 7.1.4's `wp-content` with one upload.

| Step | Result |
| --- | --- |
| Dump to SQLite | 228 statements, 8583 rows in 98 tables |
| Site address | 26 values changed |
| Archive | 445 files, 504 macOS entries skipped |
| Import | 3 parts (2637, 3799, 3937 statements), 10373 statements |
| Rows | export 10067 rows: every table matches |
| Uploads | 1 sent, 0 failed; the check run: 0 sent, 1 already there |
| Media key | deleted after the step; the account token list has no import key |
| Site | `GET /` 200 with the source site's title; the upload through the site, from R2: 200 `image/jpeg`, 4 bytes |

The first deployed run stopped at the import with error 1010 (see "Local tests cannot see the edge"). This run is after that fix (#72). R2's S3 endpoint accepted `curl`'s default User-Agent.

## Tests

`deploy/import/tests/run.sh` runs offline (CI step "Import tests"); `KEEP=1` keeps its work files. The dump fixtures are hand-written in the shape of mysqldump 8.0 output; they are not a real site. The archive fixtures are made by the test. The upload loop runs against `tests/fake-s3.py`, a stand-in that accepts any `AWS4-HMAC-SHA256` request: it tests the keys, the content types and the resume, not R2 or the signature.
