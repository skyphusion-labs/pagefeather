# shellcheck shell=bash
# Sourced by deploy/import.sh for VARIANT=c1 (issue #31). Not run on its own.
#
# c1 keeps its database in SQLite on the container disk, replicated to R2 by
# Litestream at REPLICA_PATH in the replica bucket. The import does not touch
# that replica. It puts the new database at <new path>.seed.sqlite and prints
# the deploy.sh line with REPLICA_PATH=<new path> and SEED_SHA256: the next
# container finds no replica at the new path, loads the seed (checked by
# SHA-256; container/entrypoint.sh), and replicates it. To go back, deploy
# with the old REPLICA_PATH (default store): its replica is unchanged.
#
#   phase 1 (default): seed. Needs NAME, CLOUDFLARE_API_TOKEN, ACCOUNT_ID.
#   phase 2 (VERIFY=1, the same WORK): after the deploy, compare the rows of
#   each table that the container loaded with the seed, then GET /.
# Uses: ROOT IMP WORK URL SPIKE_TOKEN NAME tf_ready tfi from import.sh.

C1="$ROOT/spikes/c1-woo-container"

# Terraform: tf_ready and tfi from import.sh (deploy/tf-backend.sh), as deploy.sh keeps the state.

c1_seed() {
  : "${NAME:?set NAME (the Terraform workspace of deploy.sh)}"
  : "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}" "${ACCOUNT_ID:?set ACCOUNT_ID}"
  [ -z "${CONTENT:-}" ] || { echo "c1: CONTENT (uploads, theme, plugins) is not supported for c1 yet" >&2; exit 2; }
  # The theme and plugins must be in the c1 build.
  python3 - "$WORK/report.json" "$C1/build/wordpress/wp-content" <<'PY'
import json, os, sys
r = json.load(open(sys.argv[1]))["site"]
wc = sys.argv[2]
missing = [f"theme {t}" for t in {r["template"], r["stylesheet"]} if t and not os.path.isdir(os.path.join(wc, "themes", t))]
missing += [f"plugin {p}" for p in (r["active_plugins"] or []) if not os.path.exists(os.path.join(wc, "plugins", p))]
if missing:
    print("NOT IN THE c1 BUILD (spikes/c1-woo-container/build): " + ", ".join(missing))
    sys.exit(0 if os.environ.get("ALLOW_MISSING") == "1" else 1)
print("theme and active plugins: all in the c1 build")
PY
  [ -z "${DRY_RUN:-}" ] || { echo "DRY_RUN: stopped before the seed"; exit 0; }

  # One file, no WAL beside it: the seed is the whole database.
  python3 -I -c '
import sqlite3, sys, os
c = sqlite3.connect(sys.argv[1]); c.execute("PRAGMA wal_checkpoint(TRUNCATE)"); c.execute("PRAGMA journal_mode=DELETE"); c.close()
for x in ("-wal", "-shm"):
    p = sys.argv[1] + x
    if os.path.exists(p) and os.path.getsize(p):
        sys.exit("c1: " + p + " is not empty")
' "$WORK/site.sqlite"
  local sha path ep bucket size code
  sha=$(shasum -a 256 "$WORK/site.sqlite" | cut -d' ' -f1)
  size=$(wc -c < "$WORK/site.sqlite" | tr -d ' ')
  path="import-$(date -u +%Y%m%dt%H%M%Sz)"
  tf_ready || exit 1
  bucket=$(tfi output -raw replica_bucket)
  ep=$(tfi output -raw r2_endpoint)
  [ -n "$bucket" ] || { echo "c1: $NAME has no replica bucket (is it a c1 site?)" >&2; exit 1; }
  # The Litestream key of the site: object read and write on the replica
  # bucket only (deploy/terraform/c1.tf). The container reads the seed with it.
  R2_KEY_ID=$(tfi output -raw litestream_access_key_id)
  R2_SECRET=$(tfi output -raw litestream_secret_access_key)
  s3() { curl -sS -K <(printf 'user = "%s:%s"\n' "$R2_KEY_ID" "$R2_SECRET") --aws-sigv4 "aws:amz:auto:s3" "$@"; }
  code=$(s3 -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: application/vnd.sqlite3' -T "$WORK/site.sqlite" "$ep/$bucket/$path.seed.sqlite")
  [ "$code" = 200 ] || { echo "c1: seed upload failed ($code)" >&2; exit 1; }
  code=$(s3 -I -o /dev/null -w '%{http_code} %header{content-length}' "$ep/$bucket/$path.seed.sqlite")
  [ "$code" = "200 $size" ] || { echo "c1: seed check failed ($code, want 200 $size)" >&2; exit 1; }
  unset R2_KEY_ID R2_SECRET
  php "$C1/container/seed-counts.php" "$WORK/site.sqlite" "$sha" "$path" > "$WORK/c1-seed.json"
  echo "c1: seed $bucket/$path.seed.sqlite ($size bytes, SHA-256 $sha)"
  echo "Next: deploy with the new replica path (keep your other c1 options the same as before):"
  echo "  VARIANT=c1 NAME=$NAME REPLICA_PATH=$path SEED_SHA256=$sha ./deploy/deploy.sh"
  echo "Then check it:"
  echo "  VARIANT=c1 VERIFY=1 WORK=$WORK URL=$URL NAME=$NAME DUMP=$DUMP ./deploy/import.sh"
  echo "To go back: deploy with your old REPLICA_PATH (default store)."
}

c1_verify() {
  [ -f "$WORK/c1-seed.json" ] || { echo "c1: no $WORK/c1-seed.json: run the seed phase first, with the same WORK" >&2; exit 2; }
  local code
  # The first request can start the container (and load the seed): wait.
  for _ in $(seq 1 30); do
    code=$(curl -s -m 120 -A wp-on-cf-import/1 -o "$WORK/c1-loaded.json" -w '%{http_code}' -K <(printf 'header = "x-spike-token: %s"\n' "$SPIKE_TOKEN") "$URL/_stats.php?what=seed" || true)
    [ "$code" = 200 ] && break
    [ "$code" = 404 ] && { echo "c1: the container loaded no seed (a replica exists at its REPLICA_PATH, or SEED_SHA256 is not set)" >&2; exit 1; }
    sleep 10
  done
  [ "$code" = 200 ] || { echo "c1: /_stats.php?what=seed answered $code" >&2; exit 1; }
  python3 - "$WORK/c1-seed.json" "$WORK/c1-loaded.json" <<'PY'
import json, sys
want, got = (json.load(open(p)) for p in sys.argv[1:3])
bad = [k for k in ("sha256", "replica_path") if want[k] != got.get(k)]
if bad:
    sys.exit("c1: the container loaded another seed: " + ", ".join(f"{k} {got.get(k)} (want {want[k]})" for k in bad))
if want["rows"] != got.get("rows"):
    diff = {t: (want["rows"].get(t), got.get("rows", {}).get(t)) for t in set(want["rows"]) | set(got.get("rows", {})) if want["rows"].get(t) != got.get("rows", {}).get(t)}
    sys.exit(f"c1: ROWS DIFFER (want, got): {diff}")
print(f"rows: every table matches ({sum(want['rows'].values())} rows in {len(want['rows'])} tables), seed {want['sha256'][:12]}")
PY
}

if [ -n "${VERIFY:-}" ]; then
  c1_verify
else
  c1_seed
  exit 0
fi
