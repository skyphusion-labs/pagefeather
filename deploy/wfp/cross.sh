#!/bin/bash
# The live isolation proof of slice 4 (issue #35): our own site A cannot reach
# site B's R2, Durable Object or secrets, and A's limits hold. Run after up.sh
# with sites one and two. It uploads TWO attacker probes into the namespace,
# cross-a with site one's bindings and secrets, cross-b with site two's, each
# behind a dispatcher entry; reads each one's own markers; then has A (cross-a)
# attempt to reach B (site two / cross-b) and feeds cross.py.
#
#   CLOUDFLARE_API_TOKEN=... ./deploy/wfp/cross.sh
#
# SCOPE (slice 4 method on #35): only our own resources in wp-wfp, documented
# bindings and fetch() only, no isolate or runtime escape, no load past the
# limit tests. A PASS is public. A result where A reaches B against the docs,
# or any platform isolation gap, is sent to the lead ONLY and stops the line
# (cross.py marks it "platform"); this script prints it and exits 3 WITHOUT
# writing it to results.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
tfr shared init -input=false >/dev/null
KV_ID=$(tfr shared output -raw kv_namespace_id)
SUB=$(subdomain)
export KV_ID SUB NAMESPACE CLOUDFLARE_ACCOUNT_ID
have=$(list_sites | tr '\n' ' ')
[ "$have" = "one two " ] || { echo "cross.sh needs the sites one and two (up.sh); there are: ${have:-none}" >&2; exit 2; }
umask 077
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
mkdir -p "$GEN"
site_out() { (cd "$WFP/terraform/site" && terraform workspace select "$1" >/dev/null && terraform output -raw "$2"); }

# cross-a with one's bindings and secrets; cross-b with two's. The entry lets
# the dispatcher apply the limits (A is called with small cpuMs and subRequests).
deploy_probe() { # deploy_probe <name> <site> <cpuMs> <subRequests>
  # <name> is crossa|crossb: the user script is site-<name> (the dispatcher
  # only routes site-* scripts), the dispatcher is wp-<name>.
  local name=$1 site=$2 cpu=$3 sub=$4 script="site-$1"
  render_cross "$script" "wp-wfp-$site-media" > "$GEN/$script.toml"
  printf '{"WP_SALT": "%s", "SPIKE_TOKEN": "%s"}' "$(site_out "$site" wp_salt)" "$(site_out "$site" spike_token)" > "$W/sec.json"
  (cd "$GEN" && npx wrangler deploy --config "$script.toml" --dispatch-namespace "$NAMESPACE" --secrets-file "$W/sec.json") > "$W/$name.log" 2>&1 \
    || { rm -f "$W/sec.json"; tail -20 "$W/$name.log"; exit 1; }
  rm -f "$W/sec.json"
  local host="wp-$name.$SUB.workers.dev"
  api PUT "/storage/kv/namespaces/$KV_ID/values/$host" -H 'content-type: text/plain' \
    --data "{\"script\": \"$script\", \"cpuMs\": $cpu, \"subRequests\": $sub, \"outbound\": true}" >/dev/null
  render_dispatcher "$name" "$KV_ID" > "$GEN/wp-$name.toml"
  (cd "$GEN" && npx wrangler deploy --config "wp-$name.toml") > "$W/wp-$name.log" 2>&1 || { tail -20 "$W/wp-$name.log"; exit 1; }
  for _ in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' "https://$host/_probe/secret")" = 200 ] && break; sleep 5; done
}

log "deploy the probes cross-a (one) and cross-b (two)"
deploy_probe crossa one 1000 2
deploy_probe crossb two 1000 2
A="https://wp-crossa.$SUB.workers.dev"; Bu="https://wp-crossb.$SUB.workers.dev"
EP="https://$CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com"

log "seed each bucket with a distinct key"
python3 -I "$WFP/snapshot.py" seed one two >/dev/null
# A's own and B's own markers (each from its own probe).
get() { curl -s -m 60 "$1"; }
b_do=$(get "$Bu/_probe/do" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("marker",""))')
b_salt=$(get "$Bu/_probe/secret" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("wp_salt_hash",""))')

log "A attempts to reach B"
probe=$(python3 - "$A" "$Bu" "$EP" <<'PY'
import json, subprocess, sys
A, Bu, EP = sys.argv[1:4]
def get(u):
    out = subprocess.run(["curl", "-s", "-m", "60", u], capture_output=True, text=True).stdout
    try: return json.loads(out)
    except ValueError: return {"error": out[:120]}
p = {
 "r2": get(A + "/_probe/r2"),
 "r2_fetch": get(A + "/_probe/r2-fetch?u=" + EP + "/wp-wfp-two-media/wfp-isolation/seed.txt"),
 "do": get(A + "/_probe/do"),
 "secret": get(A + "/_probe/secret"),
 "sub": get(A + "/_probe/sub?n=6&u=https://example.com/"), "sub_limit": 2,
 "cpu": get(A + "/_probe/cpu?ms=4000"), "cpu_limit_ms": 1000,
}
print(json.dumps(p))
PY
)
echo "$probe" > "$W/probe.json"
# B's own object key, for the r2 comparison: B seeded wfp-isolation/seed.txt.
V=$(CROSS_PROBE_B_DO="$b_do" CROSS_PROBE_B_SALT="$b_salt" CROSS_PY="$WFP/cross.py" python3 - "$W/probe.json" <<'PY'
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("cross", os.environ["CROSS_PY"])
cross = importlib.util.module_from_spec(spec); spec.loader.exec_module(cross)
probe = json.load(open(sys.argv[1]))
# A holds only its OWN bindings (bindings.py proves it from the API), so []:
# a reach with no B-binding is a platform gap, not our configuration.
b = {"site": "two", "bucket_key": "wfp-isolation/seed.txt", "do_marker": os.environ["CROSS_PROBE_B_DO"], "wp_salt_hash": os.environ["CROSS_PROBE_B_SALT"]}
res = cross.verdict(probe, b, [])
worst, _ = cross.summarize(res)
print(json.dumps({"worst": worst, "results": res}, indent=1))
PY
)
echo "$V"
worst=$(printf '%s' "$V" | python3 -c 'import json,sys; print(json.load(sys.stdin)["worst"])')

log "tear down the probes"
for n in crossa crossb; do
  (cd "$ROOT/deploy" && npx wrangler delete --name "wp-$n" --force) >/dev/null 2>&1 || true
  api DELETE "/workers/dispatch/namespaces/$NAMESPACE/scripts/site-$n?force=true" >/dev/null || true
  api DELETE "/storage/kv/namespaces/$KV_ID/values/wp-$n.$SUB.workers.dev" >/dev/null || true
  rm -f "$GEN/site-$n.toml" "$GEN/wp-$n.toml"
  st=$(ns_script_state "site-$n"); [ "$st" = gone ] || echo "  warning: site-$n is $st after teardown" >&2
done

case "$worst" in
  pass)
    R="$WFP/results/cross-$(date -u +%Y%m%dT%H%M%SZ).json"; echo "$V" > "$R"
    echo "cross: PASS (A cannot reach B; $R)" ;;
  our-defect)
    echo "cross: OUR DEFECT: a binding we gave A reaches B. Fix it in the open. See the verdict above." >&2; exit 1 ;;
  platform)
    echo "cross: POSSIBLE PLATFORM ISOLATION GAP. Sending to the lead only; NOT written to results; the line stops here. Do not retry." >&2; exit 3 ;;
  *)
    echo "cross: INCONCLUSIVE; a probe could not be read. See the verdict above." >&2; exit 1 ;;
esac
