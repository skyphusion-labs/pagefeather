# deploy/provision: the Worker-provisionable core (#154)

One provisioning core, two callers. The core is a set of idempotent Cloudflare
API operations written as pure `fetch` + Web Crypto, so the IDENTICAL module runs
inside a provisioning Worker and from a node CLI. No Docker and no wrangler build
at provision time: the c1 container image is a prerequisite built once and pushed,
and a store is provisioned by REFERENCING its digest (the #147/#154 hinge, proven
live). Design: issue #154.

## Files (stage 1, this change)

- `cf.mjs`: the Cloudflare API layer. `cfFetch` (one call, injectable `fetchImpl`
  for tests), `sha256Hex` (the R2 S3 secret: SHA-256 of the token value with NO
  trailing newline, the #154 fresh-store finding baked in so a caller cannot
  reintroduce it), the R2 permission-group ids and the bucket resource format.
- `ops.mjs`: the idempotent ops. `createR2Bucket`, `mintScopedR2Token`
  (secret derivation included), `putSecret`, `writeKVMapEntry`,
  `deployNamespaceScript` (wp / b-dosql, namespace script, no build),
  `deployContainerWorkerFromDigest` (shop / c1, image-ref, NO build; rejects a
  non-digest image).
- `registry.mjs`: the site list as the KV map itself (each site a hostname entry
  carrying `kind` and its resources). The light #154 option; a separate store is
  the alternative.
- `tests/ops-test.mjs`: offline, stubs `fetchImpl`. 26 checks, including the
  SHA-256 no-newline guard and the container-image-is-a-digest guard.

## Callers (next stages)

- Stage 2: `site add --kind wp|shop <name>` CLI (node) over the core.
- Stage 3: a minimal provisioning Worker entry calling the same ops, to prove
  Worker-executability.

## Not built here

The core never builds an image. The c1 image is built once and pushed on the
Docker lane (`wrangler containers push`), and its digest ref
(`registry.cloudflare.com/<acct>/<repo>@sha256:<digest>`) is handed to
`deployContainerWorkerFromDigest`. Live validation (a fresh wp and a fresh shop
provisioned through the core, both serving, the shop checking out 12/12) is the
lead's lane.
