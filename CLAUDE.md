# wordpress-on-cloudflare

A record of which ways to run WordPress on Cloudflare work, on which plan. The README matrix is the product.

## Rules

- Every plan limit in the README names its Cloudflare documentation page and the date it was read.
- A cell is **measured** only after a real deploy on that plan and a test in `tests/<id>/`. Record the command, the date, the Wrangler version and the result in `docs/results.md`. Documentation or a third-party claim is never **measured**.
- A failed deploy is a result. Record it. Do not delete a cell because it failed.
- Prior art is credited in `docs/prior-art.md` before we build the same thing.
- No funnel and no upsell. The reader's own Cloudflare account runs everything.
- Docs a reader reads are Simplified Technical English. No em-dashes or en-dashes.
- Deploys go to a test account and a `workers.dev` address. Do not route a zone without a CR issue.
