# deploy/zone: the zone cache lever in front of the WordPress Worker

This package puts the Cloudflare zone cache in front of a WordPress Worker, as
code. It is the answer to CR #18. It is for people who run WordPress and know a
LAMP stack, not Cloudflare internals. The tool applies the Cloudflare settings;
the site operator never opens a Cloudflare setting by hand.

## Why a Worker needs this

A Worker on a route runs BEFORE the zone cache. So a plain Worker route does not
get the zone edge cache at all. To put the zone cache in front, the Worker must
be the ORIGIN behind a proxied hostname. A Workers Custom Domain does exactly
this. `apply.sh` attaches the hostname to the Worker as a Custom Domain, then
writes a cache rule that caches anonymous HTML at the edge.

## The measured finding (CR #18, 2026-11-08)

Measured live on `posterntesting.com`:

- Without the rule: the Worker's own Cache API serves the HTML (a `cf-cache
  HIT`, about 0.15 s), but the Durable Object still runs on every request.
- With the rule: the ZONE edge serves the HTML. The `Age` header grows across
  repeat requests (0, 3, 6, 9, 13). On an edge hit the Worker is NOT invoked:
  zero Workers requests, zero Durable Object CPU, and no isolate memory pressure
  for an anonymous cached page view.
- Warm latency is about the same (around 0.15 s, both served from the colo).

The win is cost, capacity, and less exposure to the 128 MiB write ceiling, not
latency. `browser_ttl` is 0, so the browser does not cache the HTML; only the
edge does.

## What apply.sh changes

1. A Workers Custom Domain: `HOSTNAME` points at the Worker `WORKER_SERVICE`, so
   the Worker is the origin behind the proxied hostname.
2. Two rules in the zone `http_request_cache_settings` phase (from
   `cache-ruleset.json`):
   - Rule 1 bypasses the cache for `/wp-admin`, `/wp-login`, `/wp-json`,
     `/wp-cron`, `/cart`, `/checkout`, `/my-account`, for any logged-in or cart
     cookie, and for any non-GET method.
   - Rule 2 caches anonymous HTML for the host at the edge, with `edge_ttl` 3600
     and `browser_ttl` 0.

It does not create DNS, enable APO, or change anything else on the zone.

## Use

```
CLOUDFLARE_API_TOKEN=... ACCOUNT_ID=... ZONE_ID=... \
  HOSTNAME=wp.example.com WORKER_SERVICE=my-worker \
  ./deploy/zone/apply.sh
```

Both scripts are idempotent, so you can run them again safely. Reverse the whole
lever:

```
CLOUDFLARE_API_TOKEN=... ACCOUNT_ID=... ZONE_ID=... HOSTNAME=wp.example.com \
  ./deploy/zone/destroy.sh
```

Verify a cached page:

```
curl -sI https://wp.example.com/ | grep -iE 'cf-cache-status|age|cache-control'
```

A growing `Age` header on repeat GETs means the zone edge is serving and the
Worker is not invoked.

## Token scope

The token needs, on the one zone and account:

- Workers Routes: Edit (attach the Custom Domain).
- Zone Rulesets / Cache Rules: Edit (write the cache ruleset).

The token is read from `CLOUDFLARE_API_TOKEN` and passed to curl through a `-K`
config on a pipe, so it is never in the process arguments. No secret is written
into any file in this package.

## Cost and caveats (read before you recommend this to users)

### Required follow-up: purge on publish (issue #205, CR #18 stays open)

`edge_ttl` is 3600, so a published change can be stale at the edge for up to one
hour, because nothing purges the edge when content changes. The lever is NOT
complete for real editors without purge-on-publish. Issue #205 tracks a gated
mu-plugin that purges the affected URLs on `save_post`, comment, and theme
change, by URL (purge-by-URL is available on Free; cache-tag purge is Enterprise
only), through a scoped Cache Purge token. CR #18 stays open until that lands.

Free purge limits are 5 per second. Workers Cache purges are 5 per minute, so
the zone path also gives more purge throughput (part of the #18 finding).

### APO is a paid, manual, optional upgrade

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

### Zaraz is opt-in, not a default

Zaraz offloads third-party browser scripts (analytics, tag managers) to the
edge. A headless b-dosql WordPress ships no trackers by default, because privacy
is the primary goal, so there is nothing to offload unless a tenant adds one.
apply.sh carries a commented Zaraz scaffold only; it does not build a Zaraz
config.
