#!/bin/bash
# Measure, for slice 5 (issue #35), how a re-uploaded b-dosql user Worker's new
# code becomes live: does a re-upload alone activate it on the next request, or
# does the warm object keep the old build until it sleeps or is evicted? Run
# after up.sh (sites one and two). It changes NO source: build.sh takes the id
# from BUILD_ID_OVERRIDE, so two builds differ by id alone.
#
#   CLOUDFLARE_API_TOKEN=... ./deploy/wfp/measure-activation.sh
#
# Steps on site one:
#   1. read /_build: the build up.sh deployed (B0);
#   2. rebuild with a fresh id and re-upload site-one (same script, same object);
#   3. poll /_build every POLL_S (10) for up to WATCH_S (360): record when it
#      flips from B0 to the new id, with no traffic but the polls (idle);
#   4. if it has not flipped, call /_evict and poll again: whether abort() resets
#      the object on this compatibility date (or 501, the fallback to the sleep).
# It writes deploy/wfp/results/activation-<time>.json and prints it. It leaves
# site one on the new build; down.sh removes it. Read-mostly: it deploys site
# one twice and never touches site two or any other site.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
need_account
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
tfr shared init -input=false >/dev/null
SUB=$(subdomain); export SUB
list_sites | grep -qx one || { echo "run up.sh first (site one must exist)" >&2; exit 2; }
HOST="wp-one.$SUB.workers.dev"; ORIGIN="https://$HOST"
TOK=$(cd "$WFP/terraform/site" && terraform workspace select one >/dev/null && terraform output -raw spike_token)
build_now() { curl -s -m 60 -H "x-spike-token: $TOK" "$ORIGIN/_build" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("build",""))
except ValueError: print("")'; }
POLL_S=${POLL_S:-10}; WATCH_S=${WATCH_S:-360}
R="$WFP/results/activation-$(date -u +%Y%m%dT%H%M%SZ).json"
out() { python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin), indent=1))'; }

B0=$(build_now)
echo "B0 (the build up.sh deployed): $B0"

log "rebuild site one with a fresh id and re-upload"
NEW="measure-$(date -u +%s)"
( cd "$APP" && BUILD_ID_OVERRIDE="$NEW" ./build.sh >/dev/null && DEV_ENV=dosql-local ./opcache.sh >/dev/null 2>&1 )
# Re-upload the SAME script with the new build (site.sh up, build already made).
BUILD=0 "$WFP/site.sh" up one >/dev/null 2>&1 || true
reupload_at=$(date -u +%s)

log "poll /_build (idle) until it flips to $NEW"
flipped_idle=""
while [ $(( $(date -u +%s) - reupload_at )) -lt "$WATCH_S" ]; do
  b=$(build_now)
  t=$(( $(date -u +%s) - reupload_at ))
  echo "  +${t}s /_build=$b"
  [ "$b" = "$NEW" ] && { flipped_idle=$t; break; }
  sleep "$POLL_S"
done

evict_code=""; flipped_after_evict=""
if [ -z "$flipped_idle" ]; then
  log "still on the old build after ${WATCH_S}s idle; call /_evict"
  evict_code=$(curl -s -o /dev/null -w '%{http_code}' -m 30 -H "x-spike-token: $TOK" "$ORIGIN/_evict")
  echo "  /_evict HTTP $evict_code"
  e0=$(date -u +%s)
  for _ in $(seq 1 20); do
    b=$(build_now); t=$(( $(date -u +%s) - e0 ))
    echo "  evict +${t}s /_build=$b"
    [ "$b" = "$NEW" ] && { flipped_after_evict=$t; break; }
    sleep 3
  done
fi

python3 - "$R" "$B0" "$NEW" "${flipped_idle:-}" "${evict_code:-}" "${flipped_after_evict:-}" <<'PY'
import json, sys
r, b0, new, fi, ec, fe = sys.argv[1:7]
d = {"b0": b0, "new": new,
     "flipped_on_reupload_alone": fi != "", "seconds_to_flip_idle": int(fi) if fi else None,
     "evict_http": int(ec) if ec else None, "evict_available": ec not in ("", "501"),
     "seconds_to_flip_after_evict": int(fe) if fe else None}
d["conclusion"] = ("a re-upload alone activates the new build" if d["flipped_on_reupload_alone"]
                   else "re-upload does not activate while warm; /_evict (abort) does" if d["seconds_to_flip_after_evict"] is not None
                   else "re-upload does not activate while warm, and /_evict did not flip it (HTTP %s)" % ec)
json.dump(d, open(r, "w"), indent=1)
print(json.dumps(d, indent=1))
PY
echo "activation: $R"
