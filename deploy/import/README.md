# Import an existing WordPress site (issue #31)

`deploy/import.sh` moves an existing WordPress site into a site that `deploy/deploy.sh` made: the database, the uploads, and the theme and plugins. The source site is only read. Nothing in the script connects to it: you give it a dump file.

This version supports the variants `b-dosql` (the database is the SQLite of the PHP Durable Object) and `c1` (the database only; see "Variant c1"). The design for the other variants is in [issue #31](https://github.com/skyphusion-labs/wordpress-on-cloudflare/issues/31). Prior art: [docs/prior-art.md](../../docs/prior-art.md), "Moving existing sites".

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

The container stops (it does not start) if the seed download or its SHA-256 check fails, so it never installs an empty site over an import. To go back, deploy with the old `REPLICA_PATH`: its replica is unchanged. A `c1` import does not take `CONTENT` yet (uploads, theme and plugins).

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

## Fixed on the way

- `dbmove.py import` stopped at part 1 for every dump of more than one part (1.5 MB): part 0 made the tables, and `/_dbimport` refused the next part because tables existed. The second and later parts now send `append=1`.
- `/_dbimport` did not purge the page cache, so logged-out pages showed the old site until the cache time ran out. The import now asks the Worker to purge (`x-php-purge`).

## Measured

2026-11-06, `wrangler dev --env dosql-local` (local, no plan), Wrangler 4.107.0 on macOS. Source: a mysqldump 8.4 (no `--single-transaction`) of the test site of variant `a2` on PlanetScale: WordPress 7.1.4, WooCommerce with test orders and products, and the tables of the 18 plugins of the plugin suite (98 tables, 8583 rows in the dump). No customer data. Command: `URL=http://localhost:8831 SPIKE_TOKEN=local DUMP=wp-a2-dump.sql ./deploy/import.sh`. Result: 3 parts imported, every table matched (10067 rows with the driver's tables), `GET /` 200 with the site title of the source. A test on a deployed site is next; it is not **measured** on a plan yet.

Slice 2, 2026-11-06, same local Worker: `build.sh` with `IMPORT_CONTENT` from the `wp-content` of WordPress 7.1.4 (a macOS `tar` archive: 504 `._` entries skipped) built Akismet and `hello.php` into `site.zip` and `public/`. `import.sh` with `CONTENT` and `SKIP_MEDIA=1` imported the a2 dump as before (every table matched, `GET /` 200). The R2 upload (`media.sh` with the Terraform key) needs a deployed site with `MEDIA=1`: not run yet.

`c1`, 2026-11-06, local (no Docker on this computer, so no container): `tests/run.sh` runs `seed.sh` against the stand-in. It checks a good seed, a wrong SHA-256, a missing object, a restored database (it wins), and no `SEED_SHA256`. Then the `c1` build's own WordPress tree (`spikes/c1-woo-container/build.sh`, WooCommerce in it) ran under `php -S` with `router.php` on the a2 seed (made by `import.sh` steps 1 to 3). `/`, `/?p=1`, `wp-login.php` and the shop page were HTTP 200, with no PHP errors. The real container, Litestream and the deploy are not run yet.

## Tests

`deploy/import/tests/run.sh` runs offline (CI step "Import tests"); `KEEP=1` keeps its work files. The dump fixtures are hand-written in the shape of mysqldump 8.0 output; they are not a real site. The archive fixtures are made by the test. The upload loop runs against `tests/fake-s3.py`, a stand-in that accepts any `AWS4-HMAC-SHA256` request: it tests the keys, the content types and the resume, not R2 or the signature.
