# Pagefeather

A framework for running WordPress and WooCommerce on a Cloudflare Workers for Platforms account (`docs/framework.md`, `deploy/deploy.sh`), plus the research record of which approaches work on which plan. The README matrix is that record, not the only product.

## Rules

- Every plan limit in the README names its Cloudflare documentation page and the date it was read.
- A cell is **measured** only after a real deploy on that plan and a test in `tests/<id>/`. Record the command, the date, the Wrangler version and the result in `docs/results.md`. Documentation or a third-party claim is never **measured**.
- A failed deploy is a result. Record it. Do not delete a cell because it failed.
- Prior art is credited in `docs/prior-art.md` before we build the same thing.
- No funnel and no upsell. The reader's own Cloudflare account runs everything.
- Docs a reader reads are Simplified Technical English. No em-dashes or en-dashes.
- Deploys go to a `workers.dev` address only. Do not route a zone without a CR issue.
- Approach B's D1 spike is `spikes/b2-wordpress/wrangler.toml`. `env.free` is the Workers Free test account (worker `wp-on-d1-spike`, D1 `wp-on-d1-spike`). `env.paid` is the Skyphusion Labs account on Workers Paid (worker `wp-on-d1-paid`, D1 `wp-on-d1-paid`; confirmed 2026-11-04). `deploy/deploy.sh` does not use those two envs. It builds a per-site config. The other spike envs are separate (`env.a-free`, `env.a-paid`, `env.do-free`, `env.dosql-free`; `env.dosql-free` has no D1).
