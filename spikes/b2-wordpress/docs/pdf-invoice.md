# PDF order invoices with Browser Rendering (issue #227, part of #201)

A WooCommerce store gets a real PDF invoice for each order, generated at the edge
with the Cloudflare Browser Rendering binding. On normal hosting this is a paid
plugin; here it is one binding and zero config. The customer and the admin get a
download link; the PDF is rendered by the Worker, not by PHP.

## How it works

1. An order reaches `processing` (payment received) or `completed`. The mu-plugin
   `php/pdf-invoice.php` collects the order into a structured payload: the store
   identity, the order number and date, the billing party, the line items, and the
   totals. No markup is built in PHP; the money strings are reduced to plain text.
2. PHP sends one `browserRender` op to `index.js` through the `post_message_to_js`
   bridge (`skyphusion_worker_call`). The op carries the order id and the structured
   invoice data, not HTML.
3. The Worker builds the invoice HTML from that data (one escaping path, in
   `pdf-invoice.mjs`), renders it to a PDF with the Browser Rendering binding
   (`env.BROWSER`, `@cloudflare/puppeteer`), and stores the PDF in the `MEDIA` R2
   bucket under a private `invoices/` prefix.
4. The Worker signs an expiring download URL (HMAC with `INVOICE_TOKEN`) and returns
   it. PHP stores the URL and the R2 key as order meta and shows the link on the
   order page, in the order emails, and on the admin order screen.
5. A GET of `/skyphusion-invoice?k=&e=&s=` is served by the Worker. It verifies the
   HMAC and the expiry, confirms the key is a well formed `invoices/` key, and
   streams the PDF from R2 with private, no-store cache headers.

## Why the Worker builds the HTML

PHP sends data, not markup. The invoice HTML is built in one place in the Worker, so
every shopper controlled field (names, addresses, product titles) passes through a
single escape step before it reaches the rendered page. This is the same boundary the
other bindings use: PHP sends an op, the Worker holds the capability.

## The signing secret stays in the Worker

The HMAC key `INVOICE_TOKEN` never enters PHP. The Worker mints the signed download
URL and PHP relays it, so PHP can show a link but can never forge one, and a link
cannot be edited to read another R2 object or used after it expires. This is the same
boundary the AI binding uses for alt text (`ai-alt-text.php`) and the purge token uses
for the zone cache (`zone-cache-purge.php`): the secret lives in one place.

## The gate

`index.js` injects `define('SKYPHUSION_PDF_INVOICE', true)` only when the DO profile
is on (`PHP_IN_DO` and `DB_IN_DO`), the `MEDIA` and `BROWSER` bindings are both
present, and `PDF_INVOICE` is not `off`. Default on when the bindings are present, off
otherwise, so a site without the Browser Rendering binding never renders anything.
Fail safe throughout: the gate off means no generation, and a render that errors, is
slow, or returns nothing stores no link and leaves the order untouched. Generation
runs on the order-status transition, never on the checkout critical path.

## Bindings (set on the deploy env you render on)

```
# in [env.<env>]:
[env.<env>.browser]
binding = "BROWSER"

wrangler secret put INVOICE_TOKEN --env <env>   # any long random string; the HMAC key
# optional, in [env.<env>.vars]:
INVOICE_URL_TTL = "604800"   # download link lifetime in seconds (default 7 days)
PDF_INVOICE     = "off"      # off switch
```

Browser Rendering is a Paid feature and does not run in local `wrangler dev`, so the
live render is tested on a Paid deploy, not locally. Without the `BROWSER` binding the
plugin is a no-op and existing sites are unchanged.

## The download link lifetime

The signed URL expires after `INVOICE_URL_TTL` (default 7 days). The order email, the
usual delivery, is well inside that window. The stored link on the My Account order
page expires with the same TTL; a longer lived My Account link (a sign-only op that
re-mints the URL per view, without re-rendering) is a cheap follow-on and is not built
here.

## OG social-share images

The same `browserRender` op can render a post share-card to a PNG. It is tracked under
#201 and is not built in this change; the op and the storage path are shaped so it can
be added without new wiring.

## Local tests (run and passing, 2026-11-08)

```
node --test tests/pdf-invoice.test.mjs   # the Worker-side helpers: gate, op shaping, HTML builder, key, token
php  tests/pdf-invoice-test.php           # the mu-plugin: payload shaping, generate, skip, degraded, surfaces
```

Results on this build:

- `node --test tests/pdf-invoice.test.mjs`: 13 passing (the gate, HTML escaping, the
  invoice key and its prefix guard, the HTML builder with full and empty data, op-body
  shaping, HMAC and the signature, the constant-time compare, download verify for a
  fresh, tampered, expired and malformed token, and the download URL round-trip).
- `php tests/pdf-invoice-test.php`: 25 checks passing (the structured payload with
  built billing lines and plain-text items and totals, generation storing the URL and
  key as meta, the skip when a link already exists, a degraded render storing nothing,
  and the customer surface printing the link only when one is stored).
- `node --check index.js` (as a module): clean.

The live PDF render (the Browser Rendering binding actually producing a PDF and the R2
store) is for the lead to verify on a Paid deploy; this lane has no CF deploy
credentials, and Browser Rendering does not run in local `wrangler dev`.
