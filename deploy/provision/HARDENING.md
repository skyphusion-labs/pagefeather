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

## Config completeness (the functional gap, #182 review)

The security rewrite initially deployed `resourceBindings: []` and no vars, so a
minted b-dosql site would have been missing MEDIA, IMAGES, PHP_RUNTIME, EMAIL and
every runtime var, and would not have run. Closed here.

`wp-site-config.mjs` is now the ONE source for what a b-dosql site must bind. The
Worker (`buildServerCfg`) and the CLI (`buildCfg`) both consume it, so the two
provisioning callers cannot drift from each other. The authoritative generator is
`deploy/wfp/lib.sh` `render_user` (it deploys the same namespace site), and
`tests/wp-site-config-test.mjs` reads `render_user` and `deploy/wfp/bindings.py`
and asserts the shared module matches them, so a change to the generator that is
not mirrored here fails CI without a deploy.

The set, matching `render_user`:
- vars (plain_text): `PHP_ENV` (`USE_ZEND_ALLOC` off), `SITE_ORIGIN` (the site own
  origin, issue #33), `PHP_IN_DO=on`, `PHP_LOCATION`, `PHP_DO_POOL=1`, `DB_IN_DO=on`
- `images` IMAGES, `r2_bucket` MEDIA (the site own `wp-wfp-<name>-media`),
  `durable_object_namespace` PHP_RUNTIME (PhpRuntime), `send_email` EMAIL
- the PhpRuntime v1 migration (declared by `provisionSite` sqliteClasses)
- secrets WP_SALT, SPIKE_TOKEN (added by `provisionSite` as secret_text)

The `SKYPHUSION_*` feature gates (object cache, route cache, theme.json cache,
async email, bootstrap trim, media-write trim) are NOT vars: `index.js` enables
each by default unless its var is `"off"`, gated on `PHP_IN_DO=on` + `DB_IN_DO=on`
+ the MEDIA binding being present. So setting those three preconditions turns the
gates on with no gate var set; the drift test records this.

`deployNamespaceScript` already carries these: vars ride as `plain_text` entries
in the same `bindings` array the op passes to the script-upload metadata, and
`worker-test.mjs` now asserts the deployed metadata contains the vars and the four
resource bindings end to end.

### Two deltas for the lead (not silently closed)

1. **`render_user` omits `send_email`.** The WFP generator does not emit an EMAIL
   binding, so a WFP site deployed by `lib.sh` today has NO email, although
   `index.js` uses `env.EMAIL` and `deploy.sh` (standalone) emits it. Our config
   ADDS EMAIL (it is in `bindings.py` USER_OK). `lib.sh render_user` should gain
   it too, or the two paths stay inconsistent. A bare `send_email` may need a
   sender domain onboarded at deploy time (issue #104); that is a box-gate step.

2. **`[assets]` and the page cache are not bindings.** `render_user` also sets
   `[assets] directory = build/public` (static files, uploaded via the assets
   API) and `[cache]` / `[exports.Pages.cache]` (the page-cache feature). These
   are not script-metadata bindings, so neither this change nor the old worker
   ships them: the provisioning path uploads code modules only. For a minted site
   to fully match a `deploy.sh`/`lib.sh` site (static assets served, page cache
   warmed, the ~99 MiB warmed figure), the bake lane must publish `build/public`
   into the bundle store and `provisionWp` must do the assets-upload step, and the
   cache/exports config must be set. Flagged for the box-gate; out of scope for
   the security + binding fix here.

## Adversarial pass residuals (#182, grok)

grok confirmed the core holds (no parser bypass, no SSRF, CF-Connecting-IP is
edge-set and not spoofable, wp never gets the shop token, absent/empty
PROVISION_AUTH cannot pass). Five residuals were folded in:

1. **authorize() requires a STRING** (High). A `PROVISION_AUTH` bound as a Secrets
   Store / KV / R2 object cannot pass: `typeof expected !== "string"` fails closed.
   The mint-time half (confirm `SHOP_PROVISION_TOKEN` is NOT account-wide Workers
   Scripts Edit) is the lead deploy-gate step.
2. **Reserved-name denylist + anti-clobber** (the most important residual).
   `shared.mjs` RESERVED_NAMES / RESERVED_PREFIXES reject www, mail, api, admin,
   and the project's own structural prefixes (site-, c1-, wp-wfp-, wp-woo-), in
   `validateRequest` (400) and `assertValidName` (core backstop). And
   `provisionSite` now calls `scriptExists` before any deploy: a script already
   named `site-<name>` (namespace) or `c1-<name>` (standalone) that is NOT in the
   registry is a foreign/orphaned site, so the provision refuses rather than
   overwrite it. Idempotency only protected a hostname already in the KV map; this
   closes the name-collision clobber a stolen-auth caller could have used.
3. **selectToken is an explicit map** that THROWS on an unknown kind, so a kind
   sneaked past validation can never fall through to the elevated (minting) token.
4. **mint is idempotent by name** (`mintScopedR2Token`): it lists account tokens,
   and if one with the site's litestream name exists it ROLLS that token (same id,
   recovering a usable value) instead of creating a second. This removes the
   retry-after-mint zombie. A true concurrent double-submit of the same NEW name is
   still bounded only by the rate limit + the reserved/collision checks (a stateless
   Worker cannot serialize without a Durable Object lock); noted as the residual.
5. **Minor**: `resolveBase` and `selectToken` use `Object.hasOwn`, so prototype
   keys (`__proto__`, `constructor`) are never treated as a base or a token kind.
   NOT done, by design/scope: a PRE-auth IP rate limit (the 401 path does a SHA-256
   only, no network or Containers cost, so unauthenticated stuffing is cheap; a
   stolen valid secret from many IPs defeats the per-IP limiter and wants a global
   or identity-keyed limit, which ties to the self-serve decision), and genericizing
   the 405 body (an API fingerprint, low value). Both recorded for the lead.

### Token-policy delta from these residuals

- The **anti-clobber** `scriptExists` GET means both tokens need script READ:
  `WP_PROVISION_TOKEN` read on the dispatch namespace script (implied by
  Workers-for-Platforms Edit), `SHOP_PROVISION_TOKEN` read on `/workers/scripts`
  (implied by Workers Scripts Edit).
- The **mint reuse-or-roll** means `SHOP_PROVISION_TOKEN` also needs token LIST
  (`GET /accounts/{a}/tokens`) and token ROLL (`PUT .../{id}/value`) in addition to
  create. If listing is not permitted the code falls through to create (no worse
  than before), but without roll the zombie-avoidance is lost, so grant both.
