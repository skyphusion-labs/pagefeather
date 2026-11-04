# Prior art

Read on 2026-11-03. Star counts and versions change.

## HostlessWP

Repository: [hostlesswp/hostlesswp](https://github.com/hostlesswp/hostlesswp). GPL-2.0. Created 2026-10-19. Version 0.1, early preview.

- Approach A. PHP 8.3 compiled to WebAssembly runs in a Worker. The database is your existing MySQL, reached through Hyperdrive. Media is in an S3-compatible bucket such as R2.
- It says a site runs on Workers Free in its tests. Logged-out pages come from a KV page cache and use no database queries.
- WP-Cron runs from a Cron Trigger every 15 minutes.
- It replaces PHP functions that a Worker cannot run: `curl_*`, sockets, `mail()`, sessions. A `db.php` drop-in sends `wpdb` queries through Hyperdrive.

This is the closest project to approach A. Approach B removes the external MySQL, which HostlessWP still needs.

## EmDash

Cloudflare released EmDash 0.1 on 2026-04-01. It is a new CMS in TypeScript on Astro that runs on Workers. It is **not WordPress**. It imports WordPress content from a WXR export. It is here because people compare it with WordPress on Cloudflare.

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

## WordPress Playground

Repository: [WordPress/wordpress-playground](https://github.com/WordPress/wordpress-playground). It runs WordPress in WebAssembly with SQLite through the `sqlite-database-integration` plugin.

- [Issue #69: Run on Cloudflare Workers](https://github.com/WordPress/wordpress-playground/issues/69)

## SQLite on D1

- [sqlite-database-integration#288: Cloudflare D1 Support](https://github.com/WordPress/sqlite-database-integration/issues/288). Open since 2025-11-12. Approach B needs this, or a driver like it.

## Cloudflare templates

- [cloudflare/templates#1173: WordPress on Workers (php-wasm + Hyperdrive + R2)](https://github.com/cloudflare/templates/issues/1173). A template proposal, open since 2026-10-20.
