# spikes

Research prototypes. Each one answered a question about running WordPress on Cloudflare, and its findings are written up in `docs/`. These are not the product; the product is the framework (`deploy/provision` and `deploy/wfp`, documented in [docs/framework.md](../docs/framework.md)).

- `b1-boot` can PHP compiled to WebAssembly boot and run in a Worker, and reach D1. Findings: [docs/approach-b.md](../docs/approach-b.md).
- `b2-wordpress` WordPress on that PHP, in a Worker and then in a Durable Object (the `b-dosql` variant, PHP and SQLite in one Durable Object). The build, the variants and the plugin work live here. Findings: [docs/approach-b.md](../docs/approach-b.md), [docs/perf-dosql.md](../docs/perf-dosql.md), [docs/plugins.md](../docs/plugins.md).
- `c1-woo-container` stock WordPress plus WooCommerce in a Cloudflare Container, SQLite on disk replicated to R2 by Litestream, for real checkout. Findings: [docs/approach-c1.md](../docs/approach-c1.md).
