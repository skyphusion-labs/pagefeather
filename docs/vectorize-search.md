# Semantic site search (Vectorize) -- the skyphusion-ai add-on

Issue #201 Phase 2. Status: the Pagefeather side (bindings + per-site index) is wired as an
opt-in provisioning descriptor; the search engine itself is NOT built in Pagefeather. It is
the shipped **skyphusion-ai** plugin (WP.org, GPL-2.0), and Pagefeather references it rather
than duplicating it.

## Why reference, not build

`skyphusion-labs/skyphusion-ai` already ships the whole feature: it embeds published
posts with Workers AI (`@cf/baai/bge-large-en-v1.5`), stores the vectors in Cloudflare
Vectorize, and searches them (member search and related-pages over the stored vectors,
plus an AI Search public box and chat). WordPress's built-in search is a SQL `LIKE`
scan; this replaces it with vector search. Building a second native implementation in
the Pagefeather Worker would duplicate a maintained, WP.org-reviewed product, so Pagefeather instead
provisions the Cloudflare bindings the plugin needs and points the operator at it.

## What the Pagefeather descriptor provides

The `vectorize-search` descriptor (in `deploy/provision/wp-site-config.mjs`,
`B_DOSQL_DESCRIPTORS`) is OPT-IN: `default:false`, Workers AI and Vectorize are both
metered, so no site gets it unless the operator asks. Enabling it adds exactly two
bindings to the b-dosql site, and nothing else (no var, no secret):

- `env.AI` -- the account-level Workers AI binding, for `bge-large-en-v1.5` embeddings.
- `env.SEARCH_INDEX` -- a PER-SITE Vectorize index, created at provision time by the
  descriptor's `resourceCreateOp` (idempotent by name, `wp-wfp-<site>-search`). The
  index is created with the embedding model as a Vectorize v2 `preset` (1024
  dimensions, cosine for bge-large), the same shape skyphusion-ai creates itself, so
  a Pagefeather-provisioned index is a drop-in for the plugin.

### Token-free: bindings, not a stored token

On its own, skyphusion-ai reaches Workers AI and Vectorize over the Cloudflare REST
API with a stored account token (`Authorization: Bearer ...`). A Pagefeather tenant site holds
no such token by design. The point of this descriptor is that Pagefeather hands the site the
Workers AI and Vectorize work through BINDINGS instead: the PHP runtime asks the Worker
(`index.js`) to run the call on `env.AI` / `env.SEARCH_INDEX`, the same op-bridge path
the alt-text feature uses (`aiAlt`). No Cloudflare token is stored in the site.

The Worker serves that path. `handleMessage` answers `aiEmbed` on `env.AI`
(only `@cf/baai/bge-large-en-v1.5`) and `vectorize` on `env.SEARCH_INDEX`
(`query`, `upsert`, `getByIds`, `deleteByIds`). It does not create, list or
delete an index. `boot()` writes `SKYPHUSION_AI_CF_BRIDGE` only when both
bindings are present. skyphusion-ai prefers this bridge when that constant is
set. That plugin change is skyphusion-labs/skyphusion-ai#193 (the repos are not
coupled here). Until it lands (see [known-limitations.md](known-limitations.md)),
this descriptor still provisions the bindings and the index, and a plugin build
that has not taken the bridge keeps the REST path. Index CREATE stays with
Pagefeather's `resourceCreateOp` (a binding cannot create an index), so the plugin
skips its own create when the Pagefeather index is present.

## Enabling it for a tenant

Set `WP_VECTORIZE_SEARCH` (any value other than `off`) in the provisioning environment
for the site. `deploy/provision/cli.mjs` (`bDosqlEnabledIntegrations`) turns the
descriptor on, provisioning adds the `AI` + `SEARCH_INDEX` bindings and creates the
per-site index. Then install and configure skyphusion-ai on the site as its docs
describe; on a Pagefeather site it draws Workers AI and Vectorize from the bindings, token-free.

## Per-site index, and the scale ceiling to watch

The Vectorize index is PER-SITE, not shared: one tenant's vectors must never surface in
another tenant's search, and a per-site index is the clean isolation boundary (the same
call `OC_KV` made). The cost is one Vectorize index per opted-in site, and Cloudflare
caps the number of Vectorize indexes per account. That cap is the scale ceiling: if it
binds, the migration path is one SHARED index partitioned by a per-tenant Vectorize
NAMESPACE (Vectorize v2 supports namespaces and a namespace filter on query), which
trades the hard isolation boundary for a filter the search path must always apply.
Opt-in-metered and default:false, so this is not an immediate risk; verify the live
per-account index limit before enabling it broadly.
