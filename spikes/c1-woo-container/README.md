# Spike C1: WooCommerce in a Container, SQLite on disk, Litestream to R2

See `docs/approach-c1.md` for the design and the results.

## Build and deploy (Workers Paid)

```sh
./build.sh                                   # build/wordpress (image), build/public (static files)
wrangler r2 bucket create wp-woo-c1-db       # the database replica
wrangler r2 bucket create wp-woo-c1-media    # uploads
wrangler deploy                              # builds the image (Docker, linux/amd64) and the Worker
wrangler secret put WP_SALT                  # random, 32+ bytes
wrangler secret put ADMIN_PASSWORD           # 12+ characters; used for the first install only
wrangler secret put SPIKE_TOKEN              # gates /_store-stop
wrangler secret put LITESTREAM_ACCESS_KEY_ID # an R2 API token scoped to wp-woo-c1-db: the token id
wrangler secret put LITESTREAM_SECRET_ACCESS_KEY  # SHA-256 of the token value
```

Set `PUBLIC_HOST` and `R2_ENDPOINT` in `wrangler.toml`. The first request starts the container; with no replica it installs WordPress and WooCommerce (about a minute). Test with `B=https://<worker> ADMIN_PASSWORD=... python3 ../b2-wordpress/tests/woo.py`.

## Files

| File | What it does |
| --- | --- |
| `worker.js` | The Worker in front, the `Store` container class, and the `worker.internal` outbound handler (R2, Images, cache purge). |
| `container/Dockerfile` | PHP 8.3, Litestream (pinned), WordPress tree. |
| `container/entrypoint.sh` | Restore from R2, or install; then PHP under `litestream replicate`. |
| `container/litestream.yml` | The R2 replica. |
| `php/wp-config.php` | SQLite file at `/data`, keys from `WP_SALT`, WooCommerce logs on local disk. |
| `php/install.php` | First install, run by the entrypoint. |
| `php/00-worker-call.php` | The transport to `worker.internal` for the shared mu-plugins. |
| `container/kill.php` | Spike only, spike token: stop the container from inside (SIGTERM, or SIGKILL to Litestream like a crash) for durability tests. |
