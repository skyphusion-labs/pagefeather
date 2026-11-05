# Benchmark runner at Vultr

The page benchmark, `e2e.sh` and the database ping run from one Vultr box in Chicago (`ord`). Results from different days and from different sites then come from the same place.

## Why a fixed vantage

A benchmark measures the network and the client too. The laptop is not a good client for this: it is on a home network, its load average goes up to 20, and builds run on it at the same time. Two runs from the laptop can differ because of the laptop, not because of the site. A small box in a data center has a stable network and nothing else to do, so a change in a number is a change in the site.

## How it works

1. `run.sh` on the laptop makes a job file. The job has, for each site: the address, the variant, the admin password and the spike token (from the site's Terraform outputs in `deploy/terraform`). It puts the job in the R2 bucket `bench-runner` at `jobs/<job-id>.json`.
2. The service `bench-runner` on the box lists `jobs/` every 30 seconds. For each job it pulls the branch (`do28-deploy` unless the job names one), then for each site it runs the database ping (`/_d1ping`, or `/_dbping?db=object` for `b-dosql`; none for `c1`), `spikes/b2-wordpress/e2e.sh` and `tests/a/bench.py`. `deploy/summarize.py` makes one result per site, the same shape as `deploy/results/`.
3. The box puts `results/<job-id>.json` in the bucket and deletes the job. The result also has the runner data: region, plan, start and end time (UTC), the git sha it ran, and the `curl --version` line. Passwords and tokens are not in the result.
4. `run.sh` waits for the result, prints a table and writes `deploy/results/bench-runner-<job-id>.json`.

The box has no way in. The Vultr firewall group has only one rule, a sentinel (TCP port 1 from `192.0.2.1/32`, a documentation address): a Vultr group with no rules lets everything in. SSH is turned off. The box only makes connections out, to R2, to GitHub and to the sites. To read its log, use the Vultr web console: `journalctl -u bench-runner`.

## What it costs

- The box: Vultr plan `vc2-1c-1gb` (1 vCPU, 1 GB), $5 a month, billed by the hour while the box exists. Destroy it when you do not need it.
- R2: one bucket with a few small JSON files. This is in the R2 free tier.

## The credential on the box

The box has one credential: an R2 key that can read and write objects in the bucket `bench-runner` only. It is a Cloudflare account API token that Terraform makes; the S3 access key id is the token id, and the secret is the SHA-256 of the token value.

The key is in the box's `user_data`. So it is also in the Vultr instance metadata and in the Terraform state. This is acceptable because the box is ours, it lives only for a benchmark campaign, and the key reaches only the job bucket. On the box the key is in `/etc/bench-runner/env` (mode 600, root); systemd gives it to the service. The scripts give it to `curl` in a config on a pipe, not in the command line.

The job files hold the sites' admin passwords and spike tokens while they wait in the bucket. The box deletes each job after it runs it, and deletes its local copy before it uploads the result. Use the runner for test sites only.

## Make the runner

Terraform state is in the R2 bucket `wp-on-cf-tfstate` (key `bench-runner/terraform.tfstate`). `tf.sh` loads the credentials (see the top of the file).

```sh
cd tests/bench-runner
./tf.sh init
./tf.sh apply
```

Terraform makes the bucket, the key, the firewall group and the box. The box installs itself with cloud-init (`terraform/cloud-init.yaml.tftpl`) on its first boot (time not measured yet). A job that you put in the bucket before the service starts waits in `jobs/`. The runner scripts are `box/bench-runner.sh`, `box/runjob.py` and `box/bench-runner.service`; a change to them makes a new box on the next `apply`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `region` | `ord` | Vultr region (Chicago) |
| `plan` | `vc2-1c-1gb` | Vultr plan |
| `branch` | `do28-deploy` | Branch the box pulls before a job that names no branch |
| `repo` | this repository on GitHub | Where the box gets `bench.py`, `e2e.sh` and `summarize.py` |
| `bucket` | `bench-runner` | R2 bucket for jobs and results |

## Run a benchmark

```sh
export CLOUDFLARE_API_TOKEN=...   # reads the workers.dev subdomain of the site's account
set -a; . /Users/conrad/.wp-on-cf-tfstate.env; set +a   # state of the runner (and of the sites with DEPLOY_STATE=r2)
./tests/bench-runner/run.sh wp-c1 wp-ref-free
```

A site is `NAME` or `NAME=URL`. For `NAME`, the address is `https://NAME.<subdomain>.workers.dev`; the subdomain comes from the API for the account in the site's Terraform outputs. The sites can be on two accounts (the Free test account and the Paid account). If `CLOUDFLARE_API_TOKEN` cannot read one of them, give `NAME=https://...` for that site.

| Option | Default | Meaning |
| --- | --- | --- |
| `N` | `10` | Fresh renders per page (1 to 100) |
| `BRANCH` | the box's `branch` | Branch the box pulls for this job |
| `WAIT` | `3600` | Seconds to wait for the result |
| `DEPLOY_STATE` | `local` | `r2`: read the sites' outputs from the R2 state, as `deploy.sh` writes it (`STATE_BUCKET`, `STATE_ENDPOINT`) |
| `DRY_RUN` | `0` | `1`: print the job with the passwords hidden, and upload nothing |

The table shows, for each site: the median database time per statement, the `e2e.sh` result (exit code, and requests that answered 2xx or 3xx), and the median seconds of fresh renders for each page of `bench.py`.

## Remove the runner

```sh
cd tests/bench-runner
./tf.sh destroy
```

R2 does not delete a bucket that has objects. If `destroy` stops at the bucket, delete the objects first (`results/` holds the old results), for example with `deploy/variants/r2-empty.sh` and the runner key:

```sh
R2_KEY_ID=$(./tf.sh output -raw access_key_id) R2_SECRET=$(./tf.sh output -raw secret_access_key) \
  ../../deploy/variants/r2-empty.sh "$(./tf.sh output -raw endpoint)" "$(./tf.sh output -raw bucket)"
./tf.sh destroy
```
