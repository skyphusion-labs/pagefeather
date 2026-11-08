# Zone cache purge on publish (issue #205, completes CR #18)

The zone cache lever (`deploy/zone/`) caches anonymous HTML at the Cloudflare
edge in front of the WordPress Worker with `edge_ttl` 3600. That is a cost and
capacity win (the Durable Object is not invoked on a cached read), but a
published change is stale at the edge for up to one hour, because nothing purges
the edge on publish. This mu-plugin purges the affected URLs when content
changes, which is what #18 was waiting on.

## Two caches, two purges (do not conflate them)

- `edge-cache.php` purges the Worker's OWN page cache (the Cache API, through
  `Pages.purge(['wp-pages'])`). That is a cache-tag purge of a named Worker cache.
- `zone-cache-purge.php` (this plugin) purges the Cloudflare ZONE edge cache, the
  one `deploy/zone/` configures, through the Cloudflare cache-purge API
  (`POST /zones/{zone}/purge_cache`) by URL.

They are different caches with different purge mechanisms, so both plugins run on
one site without overlap.

## What it hooks

- `transition_post_status`: a post entering or leaving `publish` (newly
  published, edited while published, or unpublished/trashed). One hook covers
  `save_post` and `trashed_post` precisely, because it sees both the old and the
  new status, so autosaves, revisions and auto-drafts (which never touch
  `publish`) do not purge. Public (viewable) post types only.
- `comment_post` (a new, auto-approved comment) and `transition_comment_status`
  (a later approve / unapprove / spam / trash, which is what `wp_set_comment_status`
  fires).
- `switch_theme`, `customize_save_after`, `wp_update_nav_menu`: a site-wide change
  purges the whole zone.

For a post it purges the permalink, the home page, the main feed and the post's
comments feed. Archive pages (category, tag, date, author) also list the post;
purging every archive on each edit is heavy, so they are left to the `edge_ttl`
(the trade-off the issue names). Purge by URL is available on Free; cache-tag
purge is Enterprise only, so the URL list is the portable path.

## Debounce

Every URL a request produces is collected and sent in ONE purge call at
`shutdown`, deduped (the proven `cf-images-editor.php` shutdown-flush pattern).
A site-wide change sends `purge_everything` and skips the URL list. More than 30
URLs in one request (a bulk edit; Free allows 30 URLs per call) also falls back
to `purge_everything`, so a request never needs more than one purge call.

## The token stays in the Worker

The scoped Cloudflare token (Zone > Cache Purge, one zone) never enters PHP. PHP
sends only the URL list to `index.js` through the `post_message_to_js` bridge
(`purgeZone` op); the Worker holds `PURGE_TOKEN` and `PURGE_ZONE` and makes the
API call. This is the same boundary the AI binding uses for alt text
(`ai-alt-text.php`): the secret lives in one place, and PHP sends an op.

> Note on the dispatch. The issue text suggested injecting the token into PHP as
> a var (`SKYPHUSION_PURGE_TOKEN`). This implementation keeps the token in the
> Worker instead, which matches the AI-binding pattern the dispatch also pointed
> at, keeps the token out of PHP entirely, and avoids a dependency on the HTTP
> bridge host allowlist. The deploy wiring is the same either way (a worker
> secret plus a zone-id var); only the `define` of the token is dropped.

## The gate

`index.js` injects `define('SKYPHUSION_CACHE_PURGE', true)` only when the DO
profile is on (`PHP_IN_DO` and `DB_IN_DO`), both `PURGE_TOKEN` and `PURGE_ZONE`
are present, and `CACHE_PURGE` is not `off`. Default on when the bindings are
present, off otherwise, so a site with no zone cache never calls the purge API.
Fail safe throughout: the gate off means no purge, and a purge that errors never
affects the request.

## Bindings (set only on a real-zone deploy)

```
wrangler secret put PURGE_TOKEN --env <env>   # scoped: Zone > Cache Purge, one zone
# in [env.<env>.vars]:
PURGE_ZONE  = "<zone id>"
CACHE_PURGE = "off"   # optional off switch
```

Not set on a `workers.dev` deploy (no zone) or any site without the
`deploy/zone/` cache rule; there the plugin is a no-op.

## Local tests (run and passing, 2026-11-08)

```
node --test tests/purge-zone.test.mjs      # the Worker-side op + gate helpers
php  tests/zone-cache-purge-test.php        # the mu-plugin: hooks, dedupe, debounce
```

Results on this build:

- `node --test tests/purge-zone.test.mjs`: 7 passing (endpoint encoding, dedupe,
  everything path, URL list, empty = no call, over-cap fallback, the gate).
- `php tests/zone-cache-purge-test.php`: 8 checks passing (one call per request,
  deduped permalink + home + feed + comments feed, no purge on a non-publish
  transition, no purge for a non-viewable type, theme switch = everything in one
  call, approved comment purges, held comment does not).
- `node --check index.js` (as a module): clean.

A live purge against a real zone (the API call actually reaching Cloudflare) is
for the lead to verify on deploy; the crew seat has no CF deploy credentials.
