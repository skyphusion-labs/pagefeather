# pagefeather.dev theme

The marketing theme for [www.pagefeather.dev](https://www.pagefeather.dev/).

It follows the Skyphusion Labs OSS marketing bar (dark navy, Instrument Serif, DM Sans, JetBrains Mono). The accent is teal to amber so Pagefeather reads as its own product next to vivijure and skyphusion.org.

## Branding

The product mark is [assets/logo.svg](assets/logo.svg). The README at the repository root uses that file. The theme hero loads a copy at `wp-content/themes/pagefeather-site/assets/img/mark.svg` (same artwork).

## Layout

```
site/assets/logo.svg
site/wp-content/themes/pagefeather-site/
```

## Deploy onto the live site

The site is Worker `NAME=pagefeather` on Skyphusion Labs. Themes are code-locked. Add this theme with `IMPORT_CONTENT` and `IMPORT_THEMES`, then activate it.

```sh
# From the repository root. Keep every recorded input.
IMPORT_CONTENT="$PWD/site/wp-content" IMPORT_THEMES=pagefeather-site REPLACE_INPUTS=1 \
  VARIANT=b-dosql LOCATION=enam MEDIA=1 WOO_ACTIVE=0 BENCH=0 \
  OPCACHE_REMOTE=1 SITE_REMOTE=1 \
  CUSTOM_DOMAIN=www.pagefeather.dev \
  NAME=pagefeather ./deploy/deploy.sh
```

Then activate `pagefeather-site` (Appearance > Themes, or REST `POST /wp-json/wp/v2/themes/pagefeather-site` with stylesheet switch).

Fonts are SIL OFL 1.1 (DM Sans, Instrument Serif, JetBrains Mono), self-hosted under `assets/fonts/`.
