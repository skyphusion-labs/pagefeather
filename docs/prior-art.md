# Prior art

Read on 2026-11-03. Star counts and versions change.

## HostlessWP

Repository: [hostlesswp/hostlesswp](https://github.com/hostlesswp/hostlesswp). GPL-2.0. Created 2026-10-19. Version 0.1, early preview.

- Approach A. PHP 8.3 compiled to WebAssembly runs in a Worker. The database is your existing MySQL, reached through Hyperdrive. Media is in an S3-compatible bucket such as R2.
- It says a site runs on Workers Free in its tests. Logged-out pages come from a KV page cache and use no database queries.
- WP-Cron runs from a Cron Trigger every 15 minutes.
- It replaces PHP functions that a Worker cannot run: `curl_*`, sockets, `mail()`, sessions. A `db.php` drop-in sends `wpdb` queries through Hyperdrive.

This is the closest project to approach A. Approach B removes the external MySQL, which HostlessWP still needs.

Read again on 2026-11-05 at commit `739e8e7`. HostlessWP had already solved, and documented, things this repo found on that day:

- **The frozen clock.** A Worker does not advance the clock during CPU work, so `uniqid()` spins. HostlessWP makes the clock strictly monotonic. Our fix in `spikes/b2-wordpress/prepare.sh` is the same idea, found on our own when `wp-admin/plugins.php` hit the CPU limit. HostlessWP was first.
- **Outbound HTTP.** HostlessWP sends `wp_remote_*`, a userland `curl_*` and `http://` streams through the Worker's `fetch()`, and sockets through `connect()`. Approach B now does the same for `wp_remote_*` (`php/http-bridge.php`, issue #26, approach-b.md 8k). It does not do `curl_*`, streams or sockets.
- **Workers Free.** HostlessWP runs PHP in a Durable Object on the Free plan (30 s of CPU) and keeps the Worker for the page cache. Approach B and our approach A run PHP in the Worker and stop at Free's CPU limit.
- **Size.** HostlessWP splits the PHP tree into code bundles and loads files on first read. It deployed 19 plugins (276 MB packaged) as one Worker. Approach B needs groups to stay under 64 MiB.

We measured HostlessWP as it is, with its own CLI: [docs/approach-a.md](approach-a.md).

Approach B now uses HostlessWP's Workers Free design (issue #28, [approach-b.md](approach-b.md) 8i). With `PHP_IN_DO=on`, PHP runs in a `PhpRuntime` Durable Object with a location hint near the database. The Worker answers static files, uploads and the page cache, and forwards the rest to the object. The class name, the `PHP_IN_DO` switch, the location hint and the small pool of objects come from HostlessWP `runtime/src/index.js` (`PhpRuntime`, `render()`) and `lib/cloudflare.mjs` at `739e8e7`, GPL-2.0-or-later. Our object runs approach B's own runtime and D1 bridge, not HostlessWP's engine. Thank you, HostlessWP.

Approach A's userland mysqli (issue #29, `spikes/b2-wordpress/php/hyperdrive-mysqli.php`) follows HostlessWP `runtime/php/hostlesswp-mysqli.php` at `739e8e7`, GPL-2.0-or-later. The design is from it: a `mysqli` and a `mysqli_result` class in PHP for `$wpdb->dbh`, the procedural `mysqli_*` functions as thin wrappers, and every query on the same Worker bridge as `wpdb`. Ours runs on approach A's bridge (`skyphusion_hd_run()`, with the sql_mode handling of a strict server), turns `mysqli_report()` into exceptions as PHP 8.1 does, and leaves out prepared statements. HostlessWP also sends string literals that are not UTF-8 as hex literals; approach A does the same since issue #79 (`php/hyperdrive-literals.php`). Before, it stored such bytes doubled.

## EmDash

Cloudflare released EmDash 0.1 on 2026-04-01. It is a new CMS in TypeScript on Astro that runs on Workers. It is **not WordPress**. It imports WordPress content from a WXR export. It is here because people compare it with WordPress on Cloudflare, and so with Pagefeather.

- [TechRadar: Cloudflare launches EmDash](https://techradar.com/pro/cloudflare-launches-emdash-the-spiritual-successor-that-wants-to-take-on-wordpress)

## WooNuxt

Repository: [scottyzen/woonuxt](https://github.com/scottyzen/woonuxt). GPL-3.0. Version 4.31.0 on 2026-11-02.

- Approach D for WooCommerce. A Nuxt 4 storefront reads WooCommerce through WPGraphQL.
- Its deploy guide covers Netlify and Vercel. It has no Cloudflare guide.

## S3 Uploads, by Human Made

Repository: [humanmade/S3-Uploads](https://github.com/humanmade/S3-Uploads). GPL-2.0. About 2,160 stars, last push 2026-03-09 (read 2026-11-04).

- It keeps the WordPress media library in S3. It is a small drop-in plugin. It registers an `s3://` stream wrapper and points the `upload_dir` filter at it, so WordPress file functions write to the bucket with no other change.
- It also handles the parts core cannot do on a stream: attachment deletion (core uses `realpath()`), file sizes in metadata, image editors.
- Human Made released it free and complete, with no paid tier and no funnel. It is a good example of giving back to the WordPress community.

Our R2 media library in approach B (`spikes/b2-wordpress/php/r2-uploads.php`) uses the same design: a stream wrapper, the `upload_dir` filter, and deletion in `delete_attachment`. We could not use S3 Uploads as it is: it calls S3 over HTTPS with the AWS SDK, and PHP in a Worker has no network. Our wrapper sends each file operation to the Worker, which uses its R2 binding. Thank you, Human Made.

## Litestream

Repository: [benbjohnson/litestream](https://github.com/benbjohnson/litestream). Apache-2.0. Version 0.5.18 is pinned by SHA-256 in `spikes/c1-woo-container/container/Dockerfile`.

- It streams the changes of a SQLite database to S3-compatible storage and restores it from there. Approach C1 uses it to keep the WordPress database of a Container in R2, so a container that sleeps (and loses its disk) restores the store on start.

## APCu Object Cache Backend, by Scott Cariss

Repository: [l3rady/object-cache-apcu](https://github.com/l3rady/object-cache-apcu). GPL-2.0-or-later. Read on 2026-11-05. Release 2.0.1 (2026-10-14), commit `f611f5b`. It is a fork of Mark Jaquith's APC object cache.

- It is a WordPress `object-cache.php` drop-in that keeps the object cache in APCu, the shared memory of one PHP server. Approach C1 uses it unmodified (`spikes/c1-woo-container/build.sh` pins the commit and the SHA-256 of the file). It is on by default (`OBJECT_CACHE=apcu`); `OBJECT_CACHE=none` turns it off.
- We use it because one C1 container has one PHP server: every PHP worker of that server shares the same APCu memory. There is no Redis or Memcached to run.
- `flush()` changes a version that is part of every key, so old entries become unreachable. `incr()` and `decr()` read and then write, so two workers can race on one counter.

## WordPress Playground

Repository: [WordPress/wordpress-playground](https://github.com/WordPress/wordpress-playground). It runs WordPress in WebAssembly with SQLite through the `sqlite-database-integration` plugin.

- [Issue #69: Run on Cloudflare Workers](https://github.com/WordPress/wordpress-playground/issues/69)
- Playground routes WordPress's HTTP requests through JavaScript's `fetch()`. Issue #26 named it as the model for approach B's bridge (`php/http-bridge.php`: a `pre_http_request` answer sent to `fetch()` in the Worker or the PHP object). Thank you, WordPress Playground.

## SQLite on D1

- [sqlite-database-integration#288: Cloudflare D1 Support](https://github.com/WordPress/sqlite-database-integration/issues/288). Open since 2025-11-12. Approach B needs this, or a driver like it.


## Cloudflare Worker Publisher template (Workers for Platforms starter)

Repository: [cloudflare/templates `worker-publisher-template`](https://github.com/cloudflare/templates/tree/main/worker-publisher-template). Read on 2026-11-13 at commit `47645c9` (last change 2026-09-22). The [Workers for Platforms Get started page](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/get-started/) links it as a complete setup "with one click".

- It is a Deploy to Cloudflare button for a platform Worker. The deploy page asks the user to paste a Cloudflare API token (`.dev.vars.example` holds `CLOUDFLARE_API_TOKEN=`).
- Its `deploy` script makes the dispatch namespace through the API first (`scripts/deploy-wfp.ts`), then runs `wrangler deploy`.
- The platform Worker then uploads user Workers into the namespace through the API.

The one-click design for issue #401 ([design-401-one-click.md](design-401-one-click.md)) has the same shape: a button, one pasted token, and the namespace made before the deploy. Thank you, Cloudflare.

## The WordPress install screen

WordPress's own install screen (`wp-admin/install.php`) asks for the site title, a username, a password with a strength meter, an email and the search engine choice, then says "Success!". The Add New Site screen in the #401 design asks for the same things in the same words, so a WordPress developer sees a screen they know. The mockup's styles are written to match the wp-admin look; no WordPress file is copied.

## Cloudflare templates

- [cloudflare/templates#1173: WordPress on Workers (php-wasm + Hyperdrive + R2)](https://github.com/cloudflare/templates/issues/1173). A template proposal, open since 2026-10-20.

## PlanetScale and Hyperdrive

- [Cloudflare and PlanetScale integration](https://developers.cloudflare.com/workers/databases/third-party-integrations/planetscale/): a PlanetScale database made from Cloudflare, reached through Hyperdrive, billed (as announced) through the Cloudflare account. Variant `a2` uses it to make its database ([approach-a2.md](approach-a2.md)). Also [Hyperdrive: PlanetScale](https://developers.cloudflare.com/hyperdrive/planetscale/), the [2025-09 Cloudflare post](https://blog.cloudflare.com/planetscale-postgres-workers), the [2026-04-16 Cloudflare post](https://blog.cloudflare.com/deploy-planetscale-postgres-with-workers) and the [2026-02-19 PlanetScale post](https://planetscale.com/blog/cloudflare-hyperdrive-real-time).

## Moving existing sites

Issue #31 builds `deploy/import.sh`, which moves an existing WordPress site onto a `deploy/` variant. These tools moved WordPress sites first. Read on 2026-11-06.

- [WP Migrate Lite](https://wordpress.org/plugins/wp-migrate-db/) (version 2.7.12). It exports the database as SQL with a find and replace. It replaces strings in serialized data by unserializing, replacing and serializing again, so the string lengths stay correct. We do the same.
- [All-in-One WP Migration](https://wordpress.org/plugins/all-in-one-wp-migration/) (version 7.113). It puts the database, media, themes and plugins in one `.wpress` file, and its import replaces the site address.
- [Duplicator](https://wordpress.org/plugins/duplicator/) (version 5.1.1). It packs the files and the database into an archive with an installer, for a new host or domain.
- WP-CLI [`wp db export`](https://developer.wordpress.org/cli/commands/db/export/) runs `mysqldump` with the credentials of `wp-config.php`. It is the database input of `import.sh`. [`wp search-replace`](https://developer.wordpress.org/cli/commands/search-replace/) changes strings in the database and handles serialized data. It is the model for the address change in `import.sh`.
- HostlessWP `migrate` (`lib/commands/migrate.mjs`, commit `739e8e7`, see the HostlessWP section above). It keeps the database where it is, reached through Hyperdrive, and moves the media to R2.

These tools move a site from one PHP and MySQL host to another. `import.sh` differs because the target database can be SQLite in a Durable Object or a container, and the uploads go to R2.
