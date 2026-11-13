# deploy/oneclick-live: our live site manager (issue #419)

This directory holds the steps that `.github/workflows/deploy-oneclick.yml` runs to deploy the site manager (`deploy/oneclick`) on **our** account. An owner never runs them: an owner uses the Deploy to Cloudflare button (#416). The workflow deploys the button layout: `PAGEFEATHER_KEY` and `ADMIN_EMAIL` are Worker secrets (`deploy/oneclick/.dev.vars.example`), sent in the same upload as the code. `ADMIN_EMAIL` comes from the `ONECLICK_ADMIN_EMAIL` repo secret, and it is also the one email the Access policy allows.

`live.mjs` has four commands. Each one reads `deploy/oneclick/wrangler.toml` for the Worker name, the dispatch namespace and the R2 bucket.

| Command | What it does |
| --- | --- |
| `prepare` | Makes the dispatch namespace and the R2 bucket if they are missing. A refused read stops the run. |
| `url` | Prints the Worker's `workers.dev` address. |
| `access` | Makes the Access application for the Worker if it is missing: type `self_hosted`, destination type `worker` with the Worker's id, one policy that allows only `ADMIN_EMAIL`. If an application exists and its policy lets in anyone else, the run stops. The workflow never overwrites it. |
| `stranger` | Sends `GET /admin.css`, `GET /` and `GET /api/sites` with no sign-in and no redirects followed. Every one must be a redirect to `*.cloudflareaccess.com`. It tries 12 times, 10 s apart, while Access takes effect. |

Why the stranger check needs the redirect: the site manager refuses a request with no Access identity by itself (its own 403 page). So a 403 does not prove that Access is in front of it. `/admin.css` is the one path the Worker serves to anyone, so a 200 there means that Access is missing. The test `control: the REAL site manager with no Access in front fails the stranger check` runs the real handler with no Access, and checks that the stranger check fails.

**Unmeasured:** which Workers API field is the Access `worker_id` (`live.mjs` `workerId` reads `workers/workers/<name>` `id`, then the script `tag`). The stranger check after it is the proof: with a wrong id, Access does not protect the Worker, and the run fails.

Test: `node deploy/oneclick-live/tests/live-test.mjs`.
