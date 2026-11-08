# deploy/provision: the Worker-provisionable core (#154, hardened #182)

One provisioning core, two callers. The core is a set of idempotent Cloudflare
API operations written as pure `fetch` + Web Crypto, so the IDENTICAL module runs
inside a provisioning Worker and from a node CLI. No Docker and no wrangler build
at provision time: the vetted b-dosql bundle is built once and reused for every
site.

There is ONE kind of site: `wp` (b-dosql, WordPress with PHP and SQLite in one
Durable Object). A WooCommerce store is a `wp` site with WooCommerce enabled
inside it. The c1 container store (`kind: shop`) was retired in #214 and is gone
from every provisioning path: `provisionSite`, `selectToken`, `validateRequest`
and the CLI all reject it. Design: issue #154. Worker hardening: issue #182 and
`HARDENING.md`.

## Files

- `cf.mjs`: the Cloudflare API layer. `cfFetch` (one call, injectable `fetchImpl`
  for tests), `sha256Hex` (used only by the dormant c1 token op), the R2
  permission-group ids and the bucket resource format.
- `ops.mjs`: the idempotent ops. Used by provisioning: `createR2Bucket`,
  `putSecret`, `writeKVMapEntry`, `deployNamespaceScript` (b-dosql, namespace
  script, no build), `ensureProxiedHostname`, `installWordPress`,
  `addCustomHostname`, and the teardown ops. **Dormant, not a live path:**
  `mintScopedR2Token`, `deployContainerWorkerFromDigest` and
  `enableWorkersDevSubdomain` are left over from the retired c1 store. Nothing in
  provisioning calls them, and the Worker's token cannot run them. They stay as
  unreferenced library code only.
- `registry.mjs`: the site list as the KV map itself (each site a hostname entry
  carrying `kind` and its resources). The light #154 option; a separate store is
  the alternative.
- `shared.mjs` (#182): ONE source for the site-name allowlist (`SITE_NAME_RE`,
  `assertValidName`) and the per-site secret generator (`genSecret`), shared by
  the CLI, the orchestration and the Worker so the name rule cannot drift.
- `server-config.mjs` (#182): the Worker's security boundary. Caller auth
  (constant-time bearer), the minimal-request parser (reads only kind/name/domain),
  the owned-base allowlist, the least-privilege token split, the trusted bundle
  loader, and the server-side cfg builder.
- `wp-site-config.mjs` (#182): the ONE source for what a b-dosql site must bind
  (MEDIA/IMAGES/PHP_RUNTIME/EMAIL and the runtime vars), matching deploy/wfp
  lib.sh render_user. The Worker and the CLI both consume it so they cannot drift;
  a drift test checks it against render_user + bindings.py.
- `demo.mjs` (#182 Path B): the public demo front door controls, per-IP + global
  rate limit (KV counter), the live-demo concurrency cap, and the reaper that
  fully tears down every expired demo (script, bucket, DNS record, KV entry).
- `tests/`: offline, stub `fetchImpl` (or the global fetch + stub bindings for the
  Worker). Ops, orchestration, CLI parsing, custom hostnames, the hardened Worker
  entry, and the security unit tests, including the #182 injection / auth /
  idempotency guards. The CLI test checks that `--kind shop` is rejected.

## Callers (one shared orchestration)

- `provision.mjs`: `provisionSite(ctx, cfg)` sequences the idempotent ops for a
  `wp` site: media bucket, namespace script with secrets as atomic secret_text
  bindings, registry entry, and the proxied routing record. It validates the site
  name and is idempotent (an existing hostname is returned, never re-created).
  The CLI and the Worker both call it. After the site is routable it runs the
  WordPress install (#215), so a provisioned site is READY (not stuck at
  install.php), and returns the admin credential once. WooCommerce is NOT
  installed here; the site owner enables it inside the site.
- `cli.mjs`: `site add --kind wp <name>` (node). Implements `add` only. Parses
  args, loads the PRE-BUILT bundle dir, generates per-site secrets, calls
  `provisionSite`.
- `worker.mjs` (hardened, #182): the provisioning Worker, TWO front doors over one
  core. `POST /` is Path A (private operator bearer, b-dosql only, caller names it);
  `POST /demo` is Path B (public Turnstile, demo-tier b-dosql only, ephemeral); the
  `scheduled` handler runs the demo reaper. An authenticated caller
  POSTs ONLY `{ kind, name, domain }`; the Worker builds the whole cfg from its
  own trusted config (bundle, namespace, kv id, zone, bindings, secrets), so a
  caller can neither upload code nor target another tenant's resources. Auth,
  rate limit, server-side name validation, the owned-base allowlist, the token
  split and idempotency all live here + in `server-config.mjs`. See `HARDENING.md`.
  The Worker uses ONE restricted token (KV, Workers for Platforms, R2, and DNS for
  the one SaaS zone). It has no token-minting and no Containers scope.

## Custom hostnames (end users bring their own domain)

`addCustomHostname` (ops.mjs) attaches an end-user vanity domain to the SaaS zone's dispatcher via Cloudflare for SaaS, in TWO ownership modes that differ ONLY in who places the DNS records:

- **managed**: the customer's zone is on an account we control; the op places the CNAME + DCV record via the API (hands-off). The agency-holds-the-domain case.
- **delegated**: the CUSTOMER holds the domain; the op touches none of their DNS and RETURNS the exact records for them to add (the CNAME target + the DCV name/value), then polls to active. With `dcvDelegation`, it also emits the one-time `_acme-challenge` delegation CNAME so certificate RENEWALS auto-validate without the customer re-doing DNS each cycle.

**Anti-hostage, and it is the selling point, not a caveat:** in delegated mode the customer keeps their domain and registrar, CNAMEs to us, and can repoint away at any time; we never hold their domain. The test asserts delegated mode writes nothing to the customer's DNS. The registry records per site: `domainOwner` (agency or customer), `customHostname`, `customHostnameId`, `customHostnameState` (via `updateSite`).

## Not built here

The core never builds a bundle. The vetted Worker bundle is built once and
published to the Worker's trusted R2 bucket (see `HARDENING.md`, bundle source).
