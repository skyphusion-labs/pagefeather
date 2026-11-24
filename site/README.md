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

## Cutover

Removing the theme from this repository does not change the live Worker by itself. The theme already on www.pagefeather.dev stays until the next deploy that runs with `IMPORT_CONTENT` from pagefeather-dev (or another path that still holds the theme). Keep a marketing checkout ready before that deploy.
