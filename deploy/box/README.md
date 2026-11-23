# deploy/box: a throwaway Vultr box for a heavy job (#1327)

The standing rule (2026-11-22): heavy jobs run on throwaway Vultr boxes, not on the laptop. A heavy job is a `BUILD=1` deploy, a bundle build, a release build, or a heavy suite run. `box.py` makes the box, hands it its creds once, collects its outputs and destroys it. It uses only the Python standard library.

## What it guarantees

- **No credential in the user-data.** The Vultr API and the instance metadata both expose the user-data for the box's whole life. It carries only presigned urls. `build_userdata` refuses (`SecretInUserData`) if any creds value, or its base64, is in the job script or the user-data, and the refusal never repeats the value. The R2 secret and the Vultr key are always on that check list; so are the values in `BOX_CREDS_FILE` when it is set. The base64 check finds a value encoded on its own, or at the start of an encoded run (an aligned match); a value encoded mid-run is not found that way. That gap is covered because the job script is also checked in clear text, before it is encoded into the user-data.
- **No inbound, on IPv4 and IPv6.** Every box gets its own firewall group with one sentinel rule (tcp/1 from 192.0.2.1/32, a documentation address). Vultr's *empty* group allows everything, so the rule is required, and `create` reads it back before it makes the box. That rule is IPv4, so the box gets no IPv6 address at all: `create` sends `enable_ipv6: false` and reads back the instance's `v6_main_ip`. If it is set (or cannot be read), the box and its firewall are destroyed and `create` fails. No SSH key is attached. The box only calls out.
- **The creds are one-shot.** With `--creds`, the box polls ONE presigned GET for `box/<run>/creds.env`. `release` puts the file there, waits for the box's `creds-read` marker, deletes the object, and reads it back. Only a **HEAD 404** passes. A HEAD that still finds the object fails the release (exit 1). The object is deleted even if the box never read it. On the box, `creds.env` is mode 600 and is removed when the job ends.
- **Teardown reads back.** `destroy` deletes the instance, then the firewall, then lists both and fails if either is still there.

## Use

```
export VULTR_API_KEY=...  BOX_R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com  BOX_R2_BUCKET=<bucket>
export BOX_R2_KEY_ID=...  BOX_R2_SECRET=...      # an R2 S3 key for the results bucket, kept on the laptop
export BOX_OUTPUTS="result.json run.log"          # files the job writes to /root/out/ (each gets a presigned PUT)
python3 -I deploy/box/box.py create  <run> job.sh --creds   # BOX_CREDS_FILE=creds.env also checks its values against the user-data
python3 -I deploy/box/box.py release <run> creds.env        # exit 0 only when the box read them AND the object is 404
python3 -I deploy/box/box.py status  <run>                  # started / creds-read / done / FAILED
python3 -I deploy/box/box.py fetch   <run> <out-dir>
python3 -I deploy/box/box.py destroy <run>                  # exit 0 only when both read back gone
```

- `<run>` is letters, digits and dashes. The box is labelled `pfbox-<run>`. Its ids go to `$BOX_STATE_DIR` (default `~/scratch/box/<run>`, mode 700).
- Results go to `box/<run>/` in the bucket: the markers, `box.log`, and `out/<name>`.
- Defaults: `BOX_REGION=lax`, `BOX_PLAN=vhf-3c-8gb` (3 vCPU, 8 GB, about $0.066/h). `create` reads `/plans?type=all` first and stops if the plan is not offered in the region. When that happens, read `/regions/<r>/availability` before deciding why (see #1327's notes).
- The presigned urls last 6 days, the S3 presign maximum is 7. The box keeps them only for its own life, and destroying it ends that.

## Limits

- The creds file is in R2 from `release` until the box reads it. That is up to 1 hour if the box is slow to boot, and the box polls every 15 s for at most 60 min. Run `release` only after `create`.
- The outputs stay in R2 until you remove them. Delete `box/<run>/` once you have fetched it.
- Which creds a box may hold is set in #1327: a per-run Cloudflare token the lead mints (short expiry, only the grants needed, deleted at teardown), and only a per-site MySQL user, never the server admin password.

## Tests

`python3 -I deploy/box/tests/box-test.py` (CI job `ci`) runs with no network. It checks that the SigV4 presigning reproduces AWS's published example, and that a secret in the job script (plain or base64) is refused. Against the fake S3 (`deploy/wfp/tests/fake-s3.py`), it checks that the handoff passes only on a 404 read-back and **fails when the object is left in place**. Against a fake Vultr API, it checks that `destroy` fails when a firewall is still listed.
