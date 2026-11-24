# pagefeather.dev marketing site

The live marketing theme for [www.pagefeather.dev](https://www.pagefeather.dev/) lives in a separate repository:

**https://github.com/skyphusion-labs/pagefeather-dev**

Do not add the theme tree back here. The product mark for this engine README is a copy at [assets/logo.svg](assets/logo.svg). The source of truth for the mark is in the marketing repository (`assets/logo.svg` there, and `wp-content/themes/pagefeather-site/assets/img/mark.svg` in the theme).

## Deploy

Worker IaC and `deploy/deploy.sh` stay in this engine repository. No zone change without a CR issue.

Clone the marketing repository, then import the theme from that checkout:

```sh
MARKETING=/path/to/pagefeather-dev

IMPORT_CONTENT="$MARKETING/wp-content" IMPORT_THEMES=pagefeather-site REPLACE_INPUTS=1 \
  VARIANT=b-dosql LOCATION=enam MEDIA=1 WOO_ACTIVE=0 BENCH=0 \
  OPCACHE_REMOTE=1 SITE_REMOTE=1 \
  CUSTOM_DOMAIN=www.pagefeather.dev \
  NAME=pagefeather ./deploy/deploy.sh
```

Activate `pagefeather-site` in Appearance > Themes after the import.

## Zone edge cache (CR #1461)

Guest HTML on `www.pagefeather.dev` uses the zone Cache Rules in
[deploy/zone](../deploy/zone/). Apply with maximum edge TTL:

```sh
EDGE_TTL=31536000 \
  CLOUDFLARE_API_TOKEN=... \
  ACCOUNT_ID=fabcb25d9c7eb087110ec474a03e50d2 \
  ZONE_ID=ed4aedb29f0a0f498ff756de2b5a72c4 \
  HOSTNAME=www.pagefeather.dev \
  WORKER_SERVICE=pagefeather \
  ./deploy/zone/apply.sh
```

The first Durable Object hit pays TTFB. After that the edge should serve
anonymous guests.

### Purge on update: UNBUILT

Purge-on-publish is **UNBUILT** for this product site. A content change can stay
stale at the edge until `EDGE_TTL` ends, or until someone purges by hand. Do not
claim automatic purge for www.pagefeather.dev yet. Customer auto-apply of cache
rules is later. This apply is the marketing site only.

## Privacy

The product site collects no Cloudflare Web Analytics / Insights. The zone
setting `rum` stays off. The marketing theme does not embed
`static.cloudflareinsights.com` or a `data-cf-beacon` script. Zone apply keeps
RUM off; see [deploy/zone/README.md](../deploy/zone/README.md#web-analytics-rum-stays-off).

## Cutover

Removing the theme from this repository does not change the live Worker by itself. The theme already on www.pagefeather.dev stays until the next deploy that runs with `IMPORT_CONTENT` from pagefeather-dev (or another path that still holds the theme). Keep a marketing checkout ready before that deploy.
