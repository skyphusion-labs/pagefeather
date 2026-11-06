#!/bin/bash
# List what of the spike exists, by exact name, from the API (read only).
# destroy.sh runs it at the end: after a teardown every line must say "gone".
#
#   CLOUDFLARE_API_TOKEN=... ./tests/wfp/list.sh
#
# PREFIX (default wp-on-cf-wfp), NS (default wp-on-cf-spike), SITES (default
# wp-dosql). Exit 0 when all are gone, 1 when any exists, 2 when the API
# could not answer (then nothing is known).
set -uo pipefail
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
A=${ACCOUNT_ID:-fabcb25d9c7eb087110ec474a03e50d2}
PREFIX=${PREFIX:-wp-on-cf-wfp}; NS=${NS:-wp-on-cf-spike}; SITES=${SITES:-wp-dosql}
B="https://api.cloudflare.com/client/v4/accounts/$A"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
get() { curl -sS -o "$W/$1.json" -w '%{http_code}' -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") "$2"; }
for x in "ns $B/workers/dispatch/namespaces" "scripts $B/workers/scripts" "apps $B/containers/applications" \
         "d1 $B/d1/database?name=$PREFIX-d1" "r2 $B/r2/buckets?per_page=1000"; do
  set -- $x
  code=$(get "$1" "$2") || code=000
  [ "$code" = 200 ] || { echo "API $1: HTTP $code: cannot tell what exists" >&2; exit 2; }
done
WORKERS="$PREFIX-dispatch $PREFIX-echo $PREFIX-outbound $PREFIX-cdirect"
for s in $SITES; do WORKERS="$WORKERS $PREFIX-site-$s"; done
python3 - "$W" "$NS" "$PREFIX" "$WORKERS" <<'PY'
import json, os, sys
w, ns, prefix, workers = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].split()
def res(f):
    r = json.load(open(os.path.join(w, f + ".json"))).get("result")
    return r.get("buckets", []) if isinstance(r, dict) else (r or [])
rows = []
names = {n.get("namespace_name") for n in res("ns")}
rows.append(("dispatch namespace", ns, ns in names))
scripts = {s.get("id") for s in res("scripts")}
rows += [("worker", x, x in scripts) for x in workers]
apps = {a.get("name") for a in res("apps")}
rows += [("container application", x, x in apps) for x in ("tenant-c-box", prefix + "-cdirect-box")]
rows.append(("D1 database", prefix + "-d1", any(d.get("name") == prefix + "-d1" for d in res("d1"))))
rows.append(("R2 bucket", prefix + "-r2", any(b.get("name") == prefix + "-r2" for b in res("r2"))))
for kind, name, there in rows:
    print("%-22s %-32s %s" % (kind, name, "EXISTS" if there else "gone"))
sys.exit(1 if any(t for _, _, t in rows) else 0)
PY
