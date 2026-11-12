# Golden render gate

This test is PR 0 of issue #328. It records what each site config emitter makes today, and it
fails when a render changes.

## What it renders

`cases.json` holds the site configs. Each case has a site name, an origin and an env. Every
emitter gets the same env and only that env (and `PATH`).

For each case, `render.mjs` writes these files to `goldens/<case>/`:

| File | Emitter |
|---|---|
| `render_user.toml` | `deploy/wfp/lib.sh` `render_user <site> <origin>` |
| `cli-upload.json` | `deploy/provision/cli.mjs add --kind wp <site>`. Each API call is recorded. |
| `cli-bindings.json` | `deploy/wfp/bindings.py` on the bindings that the CLI uploads |
| `server-upload.json` | `server-config.mjs` `buildServerCfg` into `provision.mjs` `provisionSite`. Each API call is recorded. |
| `server-bindings.json` | `deploy/wfp/bindings.py` on the bindings that the Worker path uploads |

The API is a stand-in (`capture.mjs`). No network call is made. The test does not change a
live site.

The goldens do not hold a secret value. `capture.mjs` writes `<redacted>` for each
`secret_text` value and does not record request headers. The case env holds test values only.

## Run it

```sh
deploy/tests/render-golden/render-golden-test.sh
```

## Change a render on purpose

1. Make the change.
2. Run `deploy/tests/render-golden/render-golden-test.sh --update`.
3. Read `git diff deploy/tests/render-golden/goldens`. Each line in it is a render change.
4. Commit `goldens/` in the same PR, and say why in the PR body.

In #328, PR 1 to PR 7 must not change a golden. Only PR 8 (the OC_KV L2 for deploy/wfp sites)
changes one.
