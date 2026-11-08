# deploy/provision: the Worker-provisionable core (#154, hardened #182)

One provisioning core, two callers. The core is a set of idempotent Cloudflare
API operations written as pure `fetch` + Web Crypto, so the IDENTICAL module runs
inside a provisioning Worker and from a node CLI. No Docker and no wrangler build
at provision time: the c1 container image is a prerequisite built once and pushed,
and a store is provisioned by REFERENCING its digest (the #147/#154 hinge, proven
live). Design: issue #154. Worker hardening: issue #182 and `HARDENING.md`.

## Files

- `cf.mjs`: the Cloudflare API layer. `cfFetch` (one call, injectable `fetchImpl`
  for tests), `sha256Hex` (the R2 S3 secret: SHA-256 of the token value with NO
  trailing newline, the #154 fresh-store finding baked in so a caller cannot
  reintroduce it), the R2 permission-group ids and the bucket resource format.
- `ops.mjs`: the idempotent ops. `createR2Bucket`, `mintScopedR2Token`
  (secret derivation included), `putSecret`, `writeKVMapEntry`,
  `deployNamespaceScript` (wp / b-dosql, namespace script, no build),
  `deployContainerWorkerFromDigest` (shop / c1, image-ref, NO build; rejects a
  non-digest image), `addCustomHostname`.
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
- `tests/`: offline, stub `fetchImpl` (or the global fetch + stub bindings for the
  Worker). Ops, orchestration, CLI parsing, custom hostnames, the hardened Worker
  entry, and the security unit tests, including the SHA-256 no-newline guard, the
  container-image-is-a-digest guard, and the #182 injection / auth / idempotency
  guards.

## Callers (one shared orchestration)

- `provision.mjs`: `provisionSite(ctx, cfg)` sequences the idempotent ops per
  kind (wp: bucket, namespace script with secrets as atomic secret_text
  bindings, registry entry; shop: two buckets, mint the scoped token BEFORE the
  deploy, container deploy from the digest with the Litestream secret, registry
  entry with resources). It validates the site name and is idempotent (an
  existing hostname is returned, never re-created). The CLI and the Worker both
  call it.
- `cli.mjs`: `site add --kind wp|shop <name>` (node). Parses args, loads the
  PRE-BUILT bundle dir, generates per-site secrets, calls `provisionSite`.
- `worker.mjs` (hardened, #182): the provisioning Worker. An authenticated caller
  POSTs ONLY `{ kind, name, domain }`; the Worker builds the whole cfg from its
  own trusted config (bundle, namespace, kv id, zone, bindings, secrets), so a
  caller can neither upload code nor target another tenant's resources. Auth,
  rate limit, server-side name validation, the owned-base allowlist, the token
  split and idempotency all live here + in `server-config.mjs`. NOT routed; the
  lead owns the deploy gate. See `HARDENING.md`.

## Custom hostnames (end users bring their own domain)

`addCustomHostname` (ops.mjs) attaches an end-user vanity domain to the SaaS zone's dispatcher via Cloudflare for SaaS, in TWO ownership modes that differ ONLY in who places the DNS records:

- **managed**: the customer's zone is on an account we control; the op places the CNAME + DCV record via the API (hands-off). The agency-holds-the-domain case.
- **delegated**: the CUSTOMER holds the domain; the op touches none of their DNS and RETURNS the exact records for them to add (the CNAME target + the DCV name/value), then polls to active. With `dcvDelegation`, it also emits the one-time `_acme-challenge` delegation CNAME so certificate RENEWALS auto-validate without the customer re-doing DNS each cycle.

**Anti-hostage, and it is the selling point, not a caveat:** in delegated mode the customer keeps their domain and registrar, CNAMEs to us, and can repoint away at any time; we never hold their domain. The test asserts delegated mode writes nothing to the customer's DNS. The registry records per site: `domainOwner` (agency or customer), `customHostname`, `customHostnameId`, `customHostnameState` (via `updateSite`).

## Not built here

The core never builds an image. The c1 image is built once and pushed on the
Docker lane (`wrangler containers push`), and its digest ref
(`registry.cloudflare.com/<acct>/<repo>@sha256:<digest>`) is handed to
`deployContainerWorkerFromDigest`. The vetted Worker bundles are built once and
published to the Worker's trusted R2 bucket (see `HARDENING.md`, bundle source).
Live validation (a fresh wp and a fresh shop provisioned through the core, both
serving, the shop checking out 12/12) is the lead's lane.
