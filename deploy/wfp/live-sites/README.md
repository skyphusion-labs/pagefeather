# deploy/wfp/live-sites

One file per live Workers for Platforms site. The file name is the site name. Presence is the marker. No setting and no secret goes here.

`deploy/live-sites/` does not fit these sites. That directory is one file per live b-dosql site whose code `.github/workflows/deploy-workers.yml` redeploys with `CODE_ONLY=1`. The file pins `VARIANT`, `MEDIA`, `SITE_ORIGIN` and the other keys in its README, and the workflow checks a `PHP_RUNTIME` Durable Object on that Worker. `ggc` (ggc.sh) and `ggc-test` are namespace scripts. `deploy/wfp/site` is their operator surface. The workflow says the per-site Workers are not deployed there.

`OBSERVABILITY=full` is refused for a name listed here, even with `THROWAWAY=1`, before any upload or build. Use `1` (events only). The check is `wfp_live_site`, the second clause of `obs_live_site` in `deploy/wfp/lib.sh` (#693). The first clause is a `deploy/live-sites/<name>.env` file (b-dosql, #639). Keep both clauses in that one function. Do not add a second refusal.

`deploy/wfp/demo-sites/` marks public examples that must render `DEMO_LOCK=on` on every config update. This keeps code edits off and enables the variant notice on the home page. The worker reads the actual database bindings to name `b-dosql` or Hyperdrive.
