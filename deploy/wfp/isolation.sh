#!/bin/bash
# The live proof of slice 3 (issue #35): "site add" and "site remove" change
# no other site. Run it after up.sh with SITES="one two"; it leaves sites one
# and three (down.sh removes them).
#
#   CLOUDFLARE_API_TOKEN=... ./deploy/wfp/isolation.sh
#
# 1. seed: a known object in the buckets of one and two
# 2. snapshot one, two                     (snapshot.py take)
# 3. site add three
# 4. snapshot one, two again; diff: one and two must be UNCHANGED
#    (dispatcher etag and modified_on, user Worker hash and modified_on, map
#    entry, bucket keys and ETags, page title)
# 5. seed three's bucket; snapshot one, three
# 6. site remove two (it verifies two's parts gone)
# 7. snapshot one, three again; diff: one and three must be UNCHANGED
# The snapshots and a summary go to deploy/wfp/results/isolation-<time>/.
# Exits 1 at the first difference or unreadable part.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
tfr shared init -input=false >/dev/null
KV_ID=$(tfr shared output -raw kv_namespace_id)
SUB=$(subdomain)
export KV_ID SUB NAMESPACE CLOUDFLARE_ACCOUNT_ID
have=$(list_sites | tr '\n' ' ')
[ "$have" = "one two " ] || { echo "isolation.sh needs exactly the sites one and two (up.sh); there are: ${have:-none}" >&2; exit 2; }
R="$WFP/results/isolation-$(date -u +%Y%m%dT%H%M%SZ)"; mkdir -p "$R"
snap() { python3 -I "$WFP/snapshot.py" take "$R/$1.json" "${@:2}" > /dev/null; }
check() { # check <before> <after> <what>
  local rc=0
  log "diff: $3"
  python3 -I "$WFP/snapshot.py" diff "$R/$1.json" "$R/$2.json" > "$R/diff-$1-$2.txt" || rc=$?
  cat "$R/diff-$1-$2.txt"
  [ "$rc" = 0 ] || { echo "isolation: $3 FAILED (see $R/diff-$1-$2.txt)" >&2; exit 1; }
}

log "seed the buckets of one and two"
python3 -I "$WFP/snapshot.py" seed one two
snap s0 one two
log "site add three"
"$WFP/site" add three
snap s1 one two
check s0 s1 "site add three changed nothing of one and two"
# Seed three too, so its bucket comparison has an object in it (the first
# live run, 2026-11-06, compared three's empty bucket: [] with []).
python3 -I "$WFP/snapshot.py" seed three
snap s2 one three
log "site remove two"
"$WFP/site" remove two
snap s3 one three
check s2 s3 "site remove two changed nothing of one and three"
echo "isolation: PASS (snapshots in $R)"
