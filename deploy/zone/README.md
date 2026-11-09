# deploy/zone: the zone cache lever in front of the WordPress Worker

This package puts the Cloudflare ZONE cache in front of a WordPress Worker, as
code. It is the answer to CR #18 and the "edge / zone cache + purge-on-publish"
item of the #201 Phase 1 productization. It is for people who run WordPress and
know a LAMP stack, not Cloudflare internals. The tool applies the Cloudflare
settings; the site operator never opens a Cloudflare setting by hand.

This is the ZONE edge cache (Cloudflare Cache Rules), one layer ABOVE the
Worker's own in-worker page cache. On a zone-edge hit the Worker is not invoked
at all.

## Why a Worker needs this

A Worker on a route runs BEFORE the zone cache. So a plain Worker route does not
get the zone edge cache at all. To put the zone cache in front, the Worker must
be the ORIGIN behind a proxied hostname. A Workers Custom Domain does exactly
this. In the dedicated mode, `apply.sh` attaches the hostname to the Worker as a
Custom Domain, then writes the cache rules.

## Which zone this applies to (placement decision)

Cache Rules require a real proxied zone; a `*.workers.dev` host has no zone and
no zone cache. There are two placements, and this package supports both:

- **Dedicated zone, one site (MODE=dedicated, the default).** A bring-your-own
  -domain site (#157) on its own zone. `apply.sh` attaches the one hostname to
  the Worker and writes a per-hostname cache ruleset. This is the path proven on
  `posterntesting.com` for CR #18.
- **SaaS home zone, many tenants (MODE=multitenant).** One zone (e.g.
  `skyphusionwp.dev`, zone id `a18f75d980042a17bec427edc6b04592`, Pro plan)
  terminates many tenant hostnames via Cloudflare for SaaS custom hostnames.
  Here the cache rule is NOT keyed to one hostname; it matches a tenant-host
  expression and the zone is managed as ONE ruleset applied ONCE. See
  "Multi-tenant" below.

Cache Rules (free, as code, reversible) are the right placement for both. APO is
a paid, manual overlap; see "APO" below.

## Multi-tenant cache-key safety (the correctness/security question)

On the SaaS home zone, many tenants share one zone. The question is whether
tenant A's cached HTML could ever be served to tenant B. The answer is NO,
because of the cache key:

- **Cloudflare's DEFAULT cache key already includes the Host.** Verified in the
  Cache Keys docs: a default cache key is the "Full URL: scheme, host, URI with
  query string". A Cloudflare Trace of a request shows the host inside the key
  object and the key string (`...::::https://example.com/...`). So the same path
  on two different tenant hosts is two different cache entries.
- **This ruleset sets NO custom cache key.** It relies on the default, which is
  exactly what multi-tenancy needs. We deliberately do not add a custom Host
  cache-key component, for two reasons: it is redundant (Host is already in the
  default key), and the custom **Host** cache-key component is **Enterprise
  only** (Free/Pro/Business cannot set it; `skyphusionwp.dev` is Pro). Trying to
  "add host to the key" would fail on plan and buy nothing.

Do not add a custom cache key to these rules on a non-Enterprise zone. If a
future rule ever does set a custom cache key, it must keep Host in the key, or
one tenant's page can be served to another.

## WooCommerce / logged-in safety (the ordering fix and the bypass set)

Caching a cart, a checkout, or a logged-in page is the failure mode. Two things
make this safe, and the first is a correctness fix over the first cut of this
package:

### 1. Rule ORDER: last match wins

Cloudflare Cache Rules are stackable and use **last-match-wins** for the
non-terminating `set_cache_settings` action (Cloudflare docs: "for
non-terminating actions the last change made by rules in the same phase will
win"). A cart or logged-in request matches BOTH the cache rule (by host) and the
bypass rule (by cookie/path). Therefore the **bypass rule must be LAST**, so its
`cache:false` overrides the cache rule's `cache:true`.

The ruleset is ordered `[cache, bypass]` for this reason. The first cut ordered
them `[bypass, cache]`, which (under last-match-wins, not the first-match-wins of
the old Page Rules) would have let the cache rule win and **cached the cart**.
This is the classic Page-Rules-to-Cache-Rules migration trap; it is fixed here.

### 2. The bypass conditions (enumerated)

The bypass rule (`cache:false`) fires on any of:

- **Path**: `/wp-admin`, `/wp-login`, `/wp-json`, `/wp-cron`, `/cart`,
  `/checkout`, `/my-account`.
- **Cookie** (`http.cookie contains ...`):
  - `wordpress_logged_in` (covers `wordpress_logged_in_<hash>`): any logged-in
    user.
  - `wp-postpass`: password-protected post reader.
  - `wp-settings` (covers `wp-settings-<id>` and `wp-settings-time-<id>`): a user
    with saved admin/profile preferences.
  - `comment_author` (covers `comment_author_<hash>` etc.): a commenter who sees
    their own pending comment.
  - `woocommerce_` : the whole WooCommerce family. This one substring also
    matches `wp_woocommerce_session_<hash>` (the WooCommerce session cookie),
    `woocommerce_items_in_cart` and `woocommerce_cart_hash` (a non-empty cart),
    and `woocommerce_recently_viewed`. So any shopper with a session or a cart
    bypasses the edge cache.
- **Method**: any non-GET request (`http.request.method ne "GET"`).

Tradeoff noted: `woocommerce_recently_viewed` is set when an anonymous visitor
views a product, so a browsing shopper bypasses the edge cache on subsequent
product views. That lowers the hit rate for active shoppers but is the safe
(correct-over-fast) choice the issue calls for; anonymous visitors who have not
interacted with the store still get edge-cached pages.

## The measured finding (CR #18, 2026-11-08)

Measured live on `posterntesting.com` (dedicated mode):

- Without the rule: the Worker's own Cache API serves the HTML (a `cf-cache
  HIT`, about 0.15 s), but the Durable Object still runs on every request.
- With the rule: the ZONE edge serves the HTML. The `Age` header grows across
  repeat requests (0, 3, 6, 9, 13). On an edge hit the Worker is NOT invoked:
  zero Workers requests, zero Durable Object CPU, and no isolate memory pressure
  for an anonymous cached page view.
- Warm latency is about the same (around 0.15 s, both served from the colo).

The win is cost, capacity, and less exposure to the 128 MiB write ceiling, not
latency. `browser_ttl` is 0, so the browser does not cache the HTML; only the
edge does. (The reorder above does not change this result: an anonymous page
still matches only the cache rule.)

## What apply.sh changes

### MODE=dedicated (default)

1. A Workers Custom Domain: `HOSTNAME` points at the Worker `WORKER_SERVICE`, so
   the Worker is the origin behind the proxied hostname.
2. Two rules in the zone `http_request_cache_settings` phase (from
   `cache-ruleset.json`), in this order:
   - Rule 1 caches anonymous HTML for the host at the edge, `edge_ttl` 3600,
     `browser_ttl` 0.
   - Rule 2 (LAST) bypasses the cache for the paths, cookies and methods listed
     above, overriding rule 1 for any dynamic/session request.

### MODE=multitenant

1. No Custom Domain attach (the provisioning core attaches tenant hostnames).
2. One zone-wide ruleset (from `cache-ruleset.multitenant.json`): the same two
   rules, but the cache rule matches `CACHE_EXPR` (the tenant-host expression)
   instead of one hostname. Tenants stay isolated by the default Host-inclusive
   cache key.

Neither mode creates DNS, enables APO, or changes anything else on the zone.

## Use

Dedicated (one site, its own zone):

```
CLOUDFLARE_API_TOKEN=... ACCOUNT_ID=... ZONE_ID=... \
  HOSTNAME=wp.example.com WORKER_SERVICE=my-worker \
  ./deploy/zone/apply.sh
```

Multi-tenant (SaaS home zone, applied ONCE for the whole zone):

```
CLOUDFLARE_API_TOKEN=... ACCOUNT_ID=... ZONE_ID=a18f75d980042a17bec427edc6b04592 \
  MODE=multitenant \
  CACHE_EXPR='(ends_with(http.host, ".skyphusionwp.dev")) and (http.host ne "skyphusionwp.dev")' \
  ./deploy/zone/apply.sh
```

`CACHE_EXPR` above is an EXAMPLE. The exact tenant-host expression for
`skyphusionwp.dev` must be confirmed against the live zone before applying: it
must match every tenant hostname (subdomain tenants and any BYO custom hostnames
on the SaaS zone) and must EXCLUDE the control-plane / apex host, or the control
plane's anonymous GETs get edge-cached with `browser_ttl` 0. The PUT replaces the
whole entrypoint, so run multitenant mode ONCE for the zone, never per tenant (a
per-tenant apply would wipe the other tenants' rules).

Both modes are idempotent. Reverse:

```
# dedicated
CLOUDFLARE_API_TOKEN=... ACCOUNT_ID=... ZONE_ID=... HOSTNAME=wp.example.com \
  ./deploy/zone/destroy.sh
# multitenant (clears the zone-wide ruleset; tenant hostnames untouched)
CLOUDFLARE_API_TOKEN=... ACCOUNT_ID=... ZONE_ID=... MODE=multitenant \
  ./deploy/zone/destroy.sh
```

## Lead test procedure (apply is the lead's deploy gate)

Run against a real zone with a scoped token. This proves the three behaviours the
issue requires: an anonymous page is served from the edge, a cart/logged-in
request bypasses, and a publish purges then re-caches.

1. **Anonymous GET is an edge HIT.** Request the home page twice as a stranger
   (no cookies):

   ```
   curl -sI https://<host>/ | grep -iE 'cf-cache-status|age|cache-control'
   curl -sI https://<host>/ | grep -iE 'cf-cache-status|age|cache-control'
   ```

   Expect `cf-cache-status: HIT` and an `Age` that GROWS on the second request.
   A growing Age means the zone edge is serving and the Worker is not invoked.

2. **A cart/session cookie BYPASSES.** Repeat with a WooCommerce cookie and with
   a logged-in cookie:

   ```
   curl -sI -H 'cookie: woocommerce_cart_hash=abc' https://<host>/cart/ \
     | grep -i cf-cache-status
   curl -sI -H 'cookie: wp_woocommerce_session_1=zzz' https://<host>/ \
     | grep -i cf-cache-status
   curl -sI -H 'cookie: wordpress_logged_in_1=zzz' https://<host>/ \
     | grep -i cf-cache-status
   ```

   Expect `cf-cache-status: BYPASS` (or `DYNAMIC`) on all three. Confirm the
   same for a POST: `curl -sI -X POST https://<host>/` is never a HIT.

3. **Multi-tenant isolation (multitenant mode only).** Request `/` on two
   different tenant hosts and confirm each returns its OWN page (compare a
   tenant-identifying string in the body), both as edge HITs. The default
   Host-inclusive cache key keeps them separate.

4. **Publish purges, then re-caches.** With the purge-on-publish plugin deployed
   (see below), warm the cache (step 1), then publish or edit a post. The next
   anonymous GET of that URL is a MISS (the purge cleared the edge), and the GET
   after that is a HIT again (re-cached):

   ```
   # after publishing /hello-world/
   curl -sI https://<host>/hello-world/ | grep -i cf-cache-status   # MISS
   curl -sI https://<host>/hello-world/ | grep -i cf-cache-status   # HIT
   ```

   Verify in the Cloudflare dashboard (or Trace) that the purge call hit only the
   changed URLs, not `purge_everything`, for a single-post edit.

## Purge on publish (issue #205, the other half of #18)

`edge_ttl` is 3600, so without a purge a published change is stale at the edge
for up to one hour. The purge-on-publish path (proven, in `spikes/b2-wordpress/`)
closes that:

- `php/zone-cache-purge.php` (a gated mu-plugin) hooks `transition_post_status`
  (publish/unpublish/trash of a viewable post type), `comment_post` and
  `transition_comment_status` (approved comments), and `switch_theme` /
  `customize_save_after` / `wp_update_nav_menu` (site-wide -> purge everything).
- For a post it queues the permalink, the home page, the main feed and the
  post's comments feed. Archive pages are left to `edge_ttl` (the issue's
  trade-off).
- It batches every URL a request produces into ONE call at `shutdown`, deduped.
  Over 30 URLs, or a site-wide change, falls back to `purge_everything` (Free
  allows 30 URLs per purge-by-URL call).
- The call goes PHP -> `index.js` (`purgeZone` op, via `post_message_to_js`) ->
  `purge-zone.mjs` helpers -> `POST /zones/{zone}/purge_cache`. The scoped Cache
  Purge token (`PURGE_TOKEN`) and zone id (`PURGE_ZONE`) live in the WORKER; PHP
  never sees the token (same boundary as the AI alt-text binding).
- Purge by URL is on Free; cache-tag purge is Enterprise only, so the URL list is
  the portable path.
- Gated: the Worker injects `define('SKYPHUSION_CACHE_PURGE', true)` only when the
  DO profile is on and both `PURGE_TOKEN` and `PURGE_ZONE` are present
  (`CACHE_PURGE=off` disables it). A site with no zone cache never calls the API.

The descriptor wiring that provisions `PURGE_TOKEN` / `PURGE_ZONE` onto a site is
a separate follow-up (it lands after the provisioning-core scaffold). CR #18 can
close once the plugin is deployed on a real zone and a live purge is verified
with the test procedure above.

Free purge-by-URL limits are 5 per second, versus 5 per minute for a Workers
Cache purge, so the zone path also gives more purge throughput (part of #18).

## Token scope

The token needs, on the one zone and account:

- Workers Routes: Edit (attach the Custom Domain, dedicated mode only).
- Zone Rulesets / Cache Rules: Edit (write the cache ruleset).
- Account Rulesets: Edit (required by the Cache Rules API).

The purge plugin's token is SEPARATE and narrower: Zone > Cache Purge on the one
zone, held by the Worker. The token is read from `CLOUDFLARE_API_TOKEN` and
passed to curl through a `-K` config on a pipe, so it is never in the process
arguments. No secret is written into any file in this package.

## APO is a paid, manual, optional upgrade

Automatic Platform Optimization (APO) is a zone cache feature for a WordPress
ORIGIN response. On Free the setting is `editable=false`; it needs the 5 USD per
month APO add-on or a Pro or higher plan. For a Worker origin, APO overlaps the
free Cache Rule this package applies. So the opinionated default is Cache Rules:
free, as code, reversible. APO is an optional upgrade, not part of apply.sh.

To enable APO by hand on a paid zone (this is the exact call; it is paid and
manual, so apply.sh keeps it commented):

```
PATCH /zones/{zone_id}/settings/automatic_platform_optimization
  {"value":{"enabled":true,"cf":true,"wordpress":true,"wp_plugin":false,
            "hostnames":["wp.example.com"],"cache_by_device_type":false}}
```

## Zaraz is opt-in, not a default

Zaraz offloads third-party browser scripts (analytics, tag managers) to the
edge. A headless b-dosql WordPress ships no trackers by default, because privacy
is the primary goal, so there is nothing to offload unless a tenant adds one.
apply.sh carries a commented Zaraz scaffold only; it does not build a Zaraz
config.
