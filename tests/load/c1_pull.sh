#!/bin/bash
# Save the container side of one c1 load job for tests/load/c1_arm.py (#99):
#   B=https://<site> SPIKE_TOKEN=... tests/load/c1_pull.sh <dir>
# Writes <dir>/req.log, samples.log, purge.log, db.json, info.json, apcu.json
# and store-info.json, and <dir>/pulled_utc. Copy the runner's result to
# <dir>/result.json (deploy/results/bench-runner-<job>.json).
# Run it right after the job and before any deploy: the container holds these
# in /tmp only, and a deploy or an idle stop ends it. The token goes to curl in
# a config on a pipe, not in the arguments.
set -euo pipefail
D=${1:?usage: B=... SPIKE_TOKEN=... c1_pull.sh <dir>}
: "${B:?set B}" "${SPIKE_TOKEN:?set SPIKE_TOKEN}"
mkdir -p "$D"
get() { curl -sf -m "${2:-60}" -K <(printf 'header = "x-spike-token: %s"\n' "$SPIKE_TOKEN") "$B$1"; }
date -u +%FT%TZ > "$D/pulled_utc"
get /_store-info > "$D/store-info.json"
for w in req samples purge; do get "/_stats.php?what=$w" 120 > "$D/$w.log"; done
for w in db info apcu; do get "/_stats.php?what=$w" > "$D/$w.json"; done
echo "replica $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("replica_path"))' "$D/store-info.json"); req $(wc -l < "$D/req.log") lines, samples $(wc -l < "$D/samples.log")"
