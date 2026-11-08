# Provisioning Worker hardening (#182)

The design for the provisioning Worker, built so it CAN be safely routed. The
lead owns the threat model, the security review and the deploy gate; this is the
build and the two decisions that need the lead's sign off (the bundle source and
the two token policies). Nothing here deploys, routes, or mints a token.

## The threat this closes

The old `worker.mjs` POSTed a whole caller-supplied cfg to `provisionSite` with
NO auth, holding `PROVISION_TOKEN`, a token that can mint account tokens. An
unauthenticated POST could upload arbitrary Worker code, bind another tenant's
resources, write DNS in any zone the token reached, and mint fresh tokens: full
account takeover. That is why #182 said do not route it and the CLI was the only
safe path.

## The fix is the opinionation: invert who builds the cfg

The authenticated caller sends ONLY `{ kind, name, domain }`. The Worker builds
everything else from its own trusted config. A caller cannot supply code,
bindings, a namespace, a kv id, a zone, or secrets, because the request parser
(`validateRequest`, server-config.mjs) reads only those three fields and drops
the rest. `worker-test.mjs` proves an injected `modules` / `resourceBindings` /
`namespace` / `kvId` / `saasZoneId` / `secrets` never reaches the account.

`domain` is not free text: it must be a key of the server-owned `WFP_BASES`
allowlist, which maps an owned base domain to its SaaS zone id and workers.dev
subdomain. The caller picks a base by name; it never supplies a zone id. An
unowned domain is a 400.

### Checklist status (all implemented + tested offline)

1. Caller auth, before any op: `Authorization: Bearer <PROVISION_AUTH>`,
   constant-time compare over SHA-256 digests (no byte or length leak), fail
   closed when the secret is unset. Isolated in `authorize()` so a self-serve
   identity layer replaces just that function later.
2. Server-built cfg: `buildServerCfg()` constructs modules, bindings, namespace,
   kvId, hostname, saasZoneId, secrets from env + the base + the bundle.
3. Server-side name validation: `assertValidName` (the shared `SITE_NAME_RE`,
   one source now in `shared.mjs`) runs inside `provisionSite`, not only the CLI.
4. Least-privilege token split: see "Token policies" below.
5. Idempotency: a hostname already in the registry returns the existing site,
   no second create, no overwrite (guarded in `provisionSite` AND pre-checked in
   the Worker to skip the bundle read on a duplicate).
6. Rate limit per caller: the native `RATE_LIMITER` binding, keyed on the
   caller IP for the operator baseline (becomes the identity under self-serve).

## Decision 1: the bundle source (needs the lead's pick)

The Worker needs the pre-built b-dosql / c1 Worker bundle (the `modules`). The
CLI reads it from a disk dir; a Worker cannot. Two options:

- **A. Bundle it into the provisioning Worker itself** (as its own extra modules
  or static assets). Self-contained, one artifact, no external read at provision
  time. BUT the b-dosql bundle carries a PHP `.wasm` plus `.zip` data blobs, so
  it inflates the security-critical Worker, and every WordPress code update forces
  a redeploy of the provisioning Worker (the one artifact we least want to churn)
  just to ship a WP change.

- **B. Read it from a trusted R2 bucket the Worker controls** (a read-only
  `BUNDLES` binding; the operator / bake lane writes vetted bundles under a
  version prefix). Decouples a WP bundle update (push to R2, flip the prefix)
  from redeploying the provisioning Worker, keeps that Worker small and stable,
  and R2 is built for the binary `.wasm` / `.zip` blobs (KV is not). The trust
  property holds because the source is the Worker's own binding, never the
  request; a tenant can neither name nor write it.

**Recommendation: B.** It keeps the security-critical artifact small and stable
and makes bundle rotation a data operation, not a redeploy of the front door.
Implemented as `loadBundle(env, kind)` reading `env.BUNDLES` under
`WP_BUNDLE_PREFIX` (default `bundles/b-dosql/current/`) and `C1_BUNDLE_PREFIX`
(default `bundles/c1/current/`), binary for `.wasm` / `.zip`, text for JS. NOT
wired into any `wrangler.toml` (the lead owns deploy): the binding, the bucket,
and the bake-lane upload step are the lead's to stand up.

## Decision 2: the two token policies (the lead mints; never minted here)

The Worker holds TWO tokens and picks by kind (`selectToken`). The wp path NEVER
holds the elevated token. Values are env secrets; nothing is in code. The exact
permission groups below are by NAME; map each to its id with
`GET /accounts/{acct}/tokens/permission_groups` at mint time (the R2 item
read/write ids already in `cf.mjs` are a precedent, but these are different
groups).

### `WP_PROVISION_TOKEN` (restricted; the common blog / light path)

Account-scoped to THIS account only. Permission groups:
- Workers R2 Storage: Edit  (create the one media bucket)
- Workers for Platforms: Edit  (deploy the dispatch-namespace script; carries the
  secret_text bindings atomically, so no separate put-secret call)
- Workers KV Storage: Edit  (read for idempotency + write the one site-map entry;
  scope to the `WFP_KV_ID` namespace if the API supports per-namespace scoping,
  else account KV edit)
- Zone > DNS: Edit, resources scoped to the ONE SaaS zone only (place the proxied
  routing record via `ensureProxiedHostname`)

Explicitly NOT in this token: API Tokens (account token minting), Workers Scripts
(plain `/workers/scripts` write), Containers. `worker-test.mjs` proves the wp
path makes no `/tokens` POST and no plain `/workers/scripts/<name>` write.

### `SHOP_PROVISION_TOKEN` (elevated; the c1 / store path only)

Everything above, plus:
- User API Tokens: Edit, or account token create (`POST /accounts/{acct}/tokens`)
  for the scoped Litestream R2 token
- Workers Scripts: Edit  (the standalone container Worker + enable workers.dev)
- Cloudflare Containers / Workers Containers: Edit  (create / update the container
  application)

Isolating minting + Containers to the shop token bounds the blast radius: even if
the wp caller auth were bypassed, the wp token cannot mint a token or write a
plain script.

## What is NOT done here (the lead's lane)

Deploy, routing, the `wrangler.toml` bindings (`BUNDLES` R2, `RATE_LIMITER`,
`WFP_BASES` var, `WFP_KV_ID`, `C1_IMAGE_REF`, the two token secrets,
`PROVISION_AUTH`), minting the two tokens, the bake-lane bundle upload, and the
operator-vs-self-serve auth decision (#182 open item; the token-gated baseline is
built to accept that layer in front of `authorize()`). Live validation against a
real account is the lead's gate.
