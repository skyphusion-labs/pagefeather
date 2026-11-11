# deploy/provision: the Worker-provisionable core (#154, hardened #182)

One provisioning core, two callers. The core is a set of idempotent Cloudflare
API operations written as pure `fetch` + Web Crypto, so the IDENTICAL module runs
inside a provisioning Worker and from a node CLI. No Docker and no wrangler build
at provision time: a vetted worker bundle is built once and reused for every site.

TWO kinds of namespace WordPress site, driven through ONE idempotent code path:

- `wp` (b-dosql): WordPress with PHP and SQLite in one Durable Object. A
  WooCommerce store is a `wp` site with WooCommerce enabled inside it.
- `a` (approach A, #218/#241): PHP-WASM in the Cloudflare WORKER (not a Durable
  Object), with the database on EXTERNAL managed MySQL reached through a
  `HYPERDRIVE` binding. Proven to run full WooCommerce under the 128 MiB isolate
  cap with no container. The entry is `index-a-lean.js` (the lean MySQL client);
  the bundle is built with `ENGINE=a WOO=1 ./build.sh` plus a precompiled OPcache.

`provisionSite` runs the SAME sequence for both (bucket, optional KV namespaces,
namespace script, registry entry, routing record, WordPress install). The only
differences are DATA, not a separate code path: the binding/var set the caller
builds (`bDosqlBindings` vs `aBindings`), whether a SQLite migration is declared
(`sqliteClasses`: `['PhpRuntime']` for `wp`, `[]` for `a`), and whether a KV
namespace is created (`kvNamespaces`: the OC_KV object-cache L2 store for `a`).

The c1 container store (`kind: shop`) was retired in #214 and is gone from every
provisioning path: `provisionSite`, `selectToken`, `validateRequest` and the CLI
all reject it. Design: issue #154. Worker hardening: issue #182 and `HARDENING.md`.

## Files

- `cf.mjs`: the Cloudflare API layer. `cfFetch` (one call, injectable `fetchImpl`
  for tests), `sha256Hex` (used only by the dormant c1 token op), the R2
  permission-group ids and the bucket resource format.
- `ops.mjs`: the idempotent ops. Used by provisioning: `createR2Bucket`,
  `ensureKVNamespace` (the per-site OC_KV namespace for approach A, idempotent by
  title), `putSecret`, `writeKVMapEntry`, `deployNamespaceScript` (namespace
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
- `wp-site-config.mjs` (#182, #241): the ONE source for what a site must bind, so
  the Worker and the CLI cannot drift. `bDosqlVars` / `bDosqlBindings` for a
  b-dosql `wp` site (MEDIA/IMAGES/PHP_RUNTIME/EMAIL + the runtime vars), matched
  against deploy/wfp lib.sh render_user. `aVars` / `aBindings` for an approach-A
  `a` site (MEDIA/IMAGES/HYPERDRIVE/OC_KV/EMAIL + the object-cache, lazy-node and
  PHP_ENV-with-table-prefix vars, and a conditional HYPERDRIVE_SQL_MODE), matched
  against the b2-wordpress spike `[env.a-paid-lean]`. Drift tests check each set
  against its authoritative generator.
- `demo-gate.mjs`: the `DEMO_GATE` Durable Object. It decides the demo rate and
  concurrency caps as one step, so parallel requests cannot all pass a stale count.
- `demo.mjs` (#182 Path B): the public demo front door controls, per-IP + global
  rate limit (KV counter, a fast first refusal), the live-demo concurrency cap, and the reaper that
  fully tears down every expired demo (script, bucket, DNS record, KV entry).
  A demo site is built locked: it has no `send_email` binding and carries
  `DEMO_LOCK=on`, so it sends no mail and WordPress cannot install, update or edit
  plugin or theme code (`spikes/b2-wordpress/site-lock.mjs`).
- `tests/`: offline, stub `fetchImpl` (or the global fetch + stub bindings for the
  Worker). Ops, orchestration, CLI parsing, custom hostnames, the hardened Worker
  entry, the two config drift guards (`wp-site-config-test`, `a-site-config-test`),
  and the security unit tests, including the #182 injection / auth / idempotency
  guards. The CLI test checks that `--kind shop` is rejected and that `--kind a`
  requires `--hyperdrive`.

## Callers (one shared orchestration)

- `provision.mjs`: `provisionSite(ctx, cfg)` sequences the idempotent ops for a
  namespace site (`wp` or `a`): media bucket, optional KV namespace(s) (the id is
  injected into the matching binding after create), namespace script with secrets
  as atomic secret_text bindings, registry entry, and the proxied routing record.
  It validates the site name and is idempotent (an existing hostname is returned,
  never re-created). The CLI and the Worker both call it. After the site is
  routable it runs the WordPress install (#215), so a provisioned site is READY
  (not stuck at install.php), and returns the admin credential once. WooCommerce
  is NOT installed here; the site owner enables it inside the site.
- `cli.mjs`: `site add --kind wp <name>` or
  `site add --kind a <name> --hyperdrive <HYPERDRIVE_ID> [--hyperdrive-sql-mode <mode>]`
  (node). Implements `add` only. Parses args, loads the PRE-BUILT bundle dir
  (`BDOSQL_BUNDLE_DIR` for `wp`, `A_BUNDLE_DIR` for `a`), generates per-site
  secrets, calls `provisionSite`. The Hyperdrive config id (and whether a strict
  backend needs `HYPERDRIVE_SQL_MODE`) comes from the Phase-1 onboarding step.
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
  **Approach A (`kind: a`) is the operator CLI path for now, not a Worker front
  door:** it needs a per-tenant Hyperdrive config id, which the Worker's
  trusted-config model has no source for until the onboarding flow (Phase 1)
  feeds it one. `aBindings` is the shared source, so wiring the Worker to `a`
  later cannot drift from the CLI. The Worker still mints `wp` only.

## Custom hostnames (end users bring their own domain)

`addCustomHostname` (ops.mjs) attaches an end-user vanity domain to the SaaS zone's dispatcher via Cloudflare for SaaS, in TWO ownership modes that differ ONLY in who places the DNS records:

- **managed**: the customer's zone is on an account we control; the op places the CNAME + DCV record via the API (hands-off). The agency-holds-the-domain case.
- **delegated**: the CUSTOMER holds the domain; the op touches none of their DNS and RETURNS the exact records for them to add (the CNAME target + the DCV name/value), then polls to active. With `dcvDelegation`, it also emits the one-time `_acme-challenge` delegation CNAME so certificate RENEWALS auto-validate without the customer re-doing DNS each cycle.

**Anti-hostage, and it is the selling point, not a caveat:** in delegated mode the customer keeps their domain and registrar, CNAMEs to us, and can repoint away at any time; we never hold their domain. The test asserts delegated mode writes nothing to the customer's DNS. The registry records per site: `domainOwner` (agency or customer), `customHostname`, `customHostnameId`, `customHostnameState` (via `updateSite`).

## Not built here

The core never builds a bundle. A vetted worker bundle (b-dosql, or approach A
built with `ENGINE=a`) is built once and published to the Worker's trusted R2
bucket (see `HARDENING.md`, bundle source).
