#!/bin/bash
# bench-runner: every 30 s, list jobs/ in the R2 bucket. For each job: pull the
# branch, run runjob.py, put results/<job-id>.json, then delete the job.
# Runs as the systemd service bench-runner; the output goes to the journal
# (journalctl -u bench-runner).
#
# Environment (/etc/bench-runner/env): R2_ENDPOINT R2_BUCKET R2_KEY_ID R2_SECRET
# REPO_DIR BRANCH RUNNER_REGION RUNNER_PLAN. For a local test: WORK, RUNJOB, and
# ONCE=1 (one pass, then exit).
set -uo pipefail
: "${R2_ENDPOINT:?}" "${R2_BUCKET:?}" "${R2_KEY_ID:?}" "${R2_SECRET:?}" "${REPO_DIR:?}" "${BRANCH:?}"
WORK=${WORK:-/var/lib/bench/work}
RUNJOB=${RUNJOB:-/usr/local/lib/bench-runner/runjob.py}
umask 077
mkdir -p "$WORK"

# S3 call to the job bucket. The key goes to curl in a config on a pipe, not in
# the arguments, so it is not in the process list.
s3() { curl -sS -K <(printf 'user = "%s:%s"\n' "$R2_KEY_ID" "$R2_SECRET") --aws-sigv4 "aws:amz:auto:s3" "$@"; }
B="$R2_ENDPOINT/$R2_BUCKET"

list_jobs() {
  local code
  code=$(s3 -o "$WORK/list.xml" -w '%{http_code}' "$B?list-type=2&prefix=jobs/") || return 1
  [ "$code" = 200 ] || { echo "list jobs/: HTTP $code"; return 1; }
  python3 -I -c '
import sys, xml.etree.ElementTree as ET
for e in ET.parse(sys.argv[1]).getroot().iter():
    if e.tag.rsplit("}", 1)[-1] == "Key" and e.text.endswith(".json"):
        print(e.text)' "$WORK/list.xml"
}

run_one() {
  local key=$1 id job res br code
  id=${key#jobs/}; id=${id%.json}
  if ! [[ "$id" =~ ^[A-Za-z0-9_-]{1,80}$ ]]; then
    echo "job key $key: bad id; deleting it"
    s3 -o /dev/null -X DELETE "$B/$key"
    return 0
  fi
  job="$WORK/$id.job.json"; res="$WORK/$id.result.json"
  code=$(s3 -o "$job" -w '%{http_code}' "$B/$key") || return 1
  [ "$code" = 200 ] || { echo "job $id: get HTTP $code"; rm -f "$job"; return 1; }
  br=$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1])).get("branch") or "")' "$job" 2>/dev/null || true)
  br=${br:-$BRANCH}
  if ! [[ "$br" =~ ^[A-Za-z0-9._/-]+$ ]]; then
    echo "job $id: bad branch name; using $BRANCH"
    br=$BRANCH
  fi
  echo "job $id: start (branch $br)"
  if git -C "$REPO_DIR" fetch -q --depth 1 origin "$br" && git -C "$REPO_DIR" reset -q --hard FETCH_HEAD; then
    python3 "$RUNJOB" "$job" "$res" "$REPO_DIR" "$id" "$br"
  else
    python3 "$RUNJOB" "$job" "$res" "$REPO_DIR" "$id" "$br" --error "git fetch of branch $br failed"
  fi
  # The job file holds passwords: remove the local copy now.
  rm -f "$job"
  code=$(s3 -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: application/json' --data-binary "@$res" "$B/results/$id.json") || code=000
  if [ "$code" = 200 ]; then
    s3 -o /dev/null -X DELETE "$B/$key"
    echo "job $id: done, results/$id.json"
    rm -f "$res"
  else
    # The job stays in jobs/ and runs again on the next pass.
    echo "job $id: put result: HTTP $code; the job stays for the next pass"
  fi
}

echo "bench-runner: bucket $R2_BUCKET, region ${RUNNER_REGION:-?}, plan ${RUNNER_PLAN:-?}"
while :; do
  if keys=$(list_jobs); then
    for k in $keys; do run_one "$k" || echo "job $k: failed; it stays for the next pass"; done
  fi
  [ "${ONCE:-0}" = 1 ] && exit 0
  sleep 30
done
