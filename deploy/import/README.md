# Import an existing WordPress site (issue #31)

`deploy/import.sh` moves the database of an existing WordPress site into a site that `deploy/deploy.sh` made. The source site is only read. Nothing in the script connects to it: you give it a dump file.

This version supports the variant `b-dosql` (the database is the SQLite of the PHP Durable Object). The design for the other variants, the uploads and the theme and plugins is in [issue #31](https://github.com/skyphusion-labs/wordpress-on-cloudflare/issues/31). Prior art: [docs/prior-art.md](../../docs/prior-art.md), "Moving existing sites".

## Use

1. On the source server, make a dump with `--hex-blob`:

   ```sh
   wp db export site.sql --hex-blob
   # or
   mysqldump --single-transaction --hex-blob -u USER -p DATABASE > site.sql
   ```

2. Make the target site with `deploy/deploy.sh` (`VARIANT=b-dosql`). Build it with the theme and the active plugins of the source site (`PLUGINS=...`).

3. Import:

   ```sh
   URL=https://my-site.acct.workers.dev NAME=my-site DUMP=site.sql ./deploy/import.sh
   ```

   `NAME` reads `SPIKE_TOKEN` from the Terraform workspace of `deploy.sh`. You can set `SPIKE_TOKEN` instead.

The import replaces the whole database of the target site. Log in with the users and passwords of the source site.

Options: `DRY_RUN=1` stops before the import and shows what changes. `OLD_ORIGIN` sets the old site address (default: the `home` option of the dump). `ALLOW_MISSING=1` imports when the theme or an active plugin is not in the build. `WORK` sets the directory for the work files.

## Steps

| Step | Tool | What it does |
| --- | --- | --- |
| 1 | `import.sh` | Gets the SQLite driver at `SQLITE_DI_REF` of `spikes/b2-wordpress/build.sh`. The driver writes its own `_wp_sqlite_*` tables, and the runtime reads them, so the version must be the same. |
| 2 | `dump-to-sqlite.php` | Runs the dump through the driver into a new SQLite file. Changes the table prefix to `wp_`. Prints the rows of each table, the site address, the theme and the active plugins. |
| 3 | `search-replace.py` | Changes the site address to the new origin. Safe for PHP serialized data. |
| 4 | `import.sh` | Stops if the theme or an active plugin is not in the local build. |
| 5 | `dbmove-file.py`, `spikes/b2-wordpress/dbmove.py` | Writes the SQLite file as a `dbmove` dump and imports it into the PHP object. |
| 6 | `dbmove.py export`, `dbmove-file.py counts` | Exports the database again and compares the rows of each table. |
| 7 | `import.sh` | Gets the home page without the page cache. It must be HTTP 200. |

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

2026-11-06, `wrangler dev --env dosql-local` (local, no plan), Wrangler 4.107.0 on macOS. Source: a mysqldump 8.4 of the test site of variant `a2` (WooCommerce, 98 tables, 8583 rows in the dump). Command: `URL=http://localhost:8831 SPIKE_TOKEN=local DUMP=wp-a2-dump.sql ./deploy/import.sh`. Result: 3 parts imported, every table matched (10067 rows with the driver's tables), `GET /` 200 with the site title of the source. A test on a deployed site is next; it is not **measured** on a plan yet.

## Tests

`deploy/import/tests/run.sh` runs offline (CI step "Import tests"). The fixtures are hand-written in the shape of mysqldump 8.0 output; they are not a real site.
