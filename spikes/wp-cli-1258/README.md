# WP-CLI local spike (issue 1258)

This harness checks whether the real `wp-cli.phar` runs in the pagefeather PHP runtime on a local site. It does not deploy. It does not call Cloudflare. It does not change a product code path.

The runner is a PHP file. The harness puts that file and the phar into the local `site.zip` for the run, then puts the zip back.

## Rerun

From this directory:

```sh
./run.sh
```

When `spikes/b2-wordpress/node_modules`, `vendor/php_8_3.wasm`, or `build/site.zip` is missing, the script runs `npm ci`, `./prepare.sh`, and `./build.sh` there.

The script downloads `wp-cli.phar` from `https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar` and checks it against `wp-cli.phar.sha512` from the same directory. The files stay in `cache/`. That directory is gitignored.

It then boots two local shapes, with `DEV_LOCAL=1` so Wrangler does not open a remote session:

1. `DEV_ENV=dosql-local` (PHP and SQLite in the Durable Object).
2. `DEV_ENV=a-shape-local` (PHP in the Worker, database on local D1).

Each shape gets a new directory under `state/`, a WordPress install (`POST /_install`), a home page, a runtime probe, and these commands:

- `wp option get siteurl`
- `wp user list`
- `wp cache flush`
- `wp cron event list`
- `wp plugin install hello-dolly`

Two entries are measured. `mode=phar` includes `wp-cli.phar` (the real entry). `mode=inner` loads `wp-cli.php` from inside the phar, after the SAPI check in `boot-phar.php`. The inner entry is a probe. It is not how WP-CLI starts. `wp user list` is last. A command that returns no JSON restarts the dev server before the next command, so a hung request does not block the rest.

`node probe-engine.mjs` boots the same wasm in Node, with no WordPress database, and tries `php.cli()` and `setSapiName('cli')`.

`term=off` on the runner clears `TERM` before the include. A rerun of `wp user list` with that flag still hung. The dev log still reported `SPAWN_UNSUPPORTED`. The flag is only a probe.

Results go to `out/results.json` and `out/engine.json`.

Needs Node 24 or later, python3, and curl. The dev server is `spikes/b2-wordpress/run.sh`, which uses the pinned Wrangler at `deploy/wr`. The first run needs the network for npm, the engine pin, WordPress, WooCommerce, and the WP-CLI build.

OPcache starts empty (`build/opcache.zip` from `build.sh`). The first PHP request compiles scripts. `./opcache.sh` is not part of this harness.
