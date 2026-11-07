# c1 feasibility probe (slice 7, #147)

The minimal test of the #35 open question: can a Workers for Platforms
dispatch-namespace USER WORKER bind and launch a Cloudflare Container? This is
not the c1 WordPress image; it is a tiny container that returns the marker
`c1-probe-ok` on any request (port 8080).

## Files
- `container/server.py`, `container/Dockerfile`: the marker container.
- `worker.js`: the namespace user Worker (the `Probe` Container class, forwards every request to the one instance).
- `wrangler.toml`: the user-script config with the container, Durable Object and migration bindings.
- `package.json`: the `@cloudflare/containers` dependency.
- `probe-selfcheck.sh`: offline, proves the files are well-formed (no deploy).

## The run (lead: creds and the Docker build, one at a time; no crew live apply)

The shared pieces must exist first (`deploy/wfp/up.sh`: the namespace `wp-wfp`,
the site map, the outbound Worker). Then, from `deploy/wfp/c1-probe/`:

1. `npm install`
2. Upload the probe user script (this builds the image with Docker):
   `CLOUDFLARE_API_TOKEN=... npx wrangler deploy --config wrangler.toml --dispatch-namespace wp-wfp`
   - **If wrangler or the API REJECTS the container binding on a dispatch-namespace deploy, STOP.** Feasibility is NO at the upload gate; record the exact error on #147.
3. If it uploaded, map a hostname to the probe script and route it through a dispatcher, exactly as `site.sh up` does for a site:
   ```
   cd deploy/wfp && . lib.sh
   SUB=$(subdomain); KV_ID=$(tfr shared output -raw kv_namespace_id)
   HOST="$(dispatcher_name c1probe).$SUB.workers.dev"
   kv_wait_writable "$KV_ID"
   api_code PUT "/storage/kv/namespaces/$KV_ID/values/$HOST" -H 'content-type: text/plain' --data '{"script": "site-c1probe", "outbound": true}'
   render_dispatcher c1probe "$KV_ID" > gen/wp-c1probe.toml
   wrangler_deploy gen "$TMPDIR/c1probe-disp.log" --config wp-c1probe.toml
   curl -s "https://$HOST/"     # expect the body: c1-probe-ok
   ```

## Decision
- `c1-probe-ok` returns: a namespace user Worker CAN launch a Container. Feasible; strummer builds step 2 (the c1 variant flag on `site`/`up.sh`, offline tests, and a live-proof sequence).
- The upload is rejected, or the container never launches (no marker, a dispatch 502, or a container error): infeasible. Record it on #147 and stop; b-dosql stays the only per-site variant.

## Teardown
```
api DELETE "/workers/dispatch/namespaces/wp-wfp/scripts/site-c1probe?force=true"
(cd deploy/wfp/.. && npx wrangler delete --name wp-c1probe --force)
api DELETE "/storage/kv/namespaces/$KV_ID/values/$HOST"
```
Then confirm each is 404.
