# deploy/product-site

Zone levers for the Pagefeather product marketing site. This is not the
customer product path. Test deploys stay on `workers.dev`. Zone changes need a
CR issue.

## pagefeather.com redirect (CR #1460)

`redirect-com.sh` puts HTTP for `pagefeather.com` and `www.pagefeather.com` onto
Cloudflare, then redirects both hosts to `https://www.pagefeather.dev` (path and
query kept). Mail records stay.

```sh
CLOUDFLARE_API_TOKEN=... \
  ZONE_ID=19cd63f2dec4d27a65eb003d6ba183c1 \
  ./deploy/product-site/redirect-com.sh
```

The ruleset file is `redirect-com-ruleset.json`. Re-run is safe.

### Verify

```sh
curl -sI https://pagefeather.com/ | grep -iE 'HTTP/|location:'
curl -sI https://www.pagefeather.com/about/?q=1 | grep -iE 'HTTP/|location:'
```

Expect 301 to `https://www.pagefeather.dev/` and
`https://www.pagefeather.dev/about/?q=1`.

### Rollback

Delete the originless A/AAAA for the apex and for www. Clear the
`http_request_dynamic_redirect` phase entrypoint on the zone. Leave mail
records.
