#!/usr/bin/env bash
# deploy/deploy.sh OBSERVABILITY (deploy/observability.sh): Workers Logs for a b-do, b-dosql or a site,
# off unless set. 1. The refusals through deploy.sh, behind the fence (lib.sh). 2. The rendered block,
# unset first (nothing: today's render). 3. obs_redact against a stand-in settings API: a good
# redaction passes, and a redaction that does not read back fails AND turns the logs off (fail
# closed), as deploy-a-lean.sh does. 4. deploy.sh redacts right after the upload, before the
# CODE_ONLY exit and before the secrets.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/observability-test.XXXXXX")
SRV=
trap '[ -n "$SRV" ] && kill "$SRV" 2>/dev/null; rm -rf "$T"' EXIT
# shellcheck source=SCRIPTDIR/lib.sh
. "$ROOT/deploy/tests/lib.sh"
FENCE="$T/fence"; fence_dir "$FENCE"

echo "1. refusals through deploy.sh"
for bad in 2 on yes true; do refuse "OBSERVABILITY must be 0, 1 (events only) or full" VARIANT=b-dosql "OBSERVABILITY=$bad"; done
refuse "OBSERVABILITY is for variants b-do, b-dosql and a" VARIANT=c1 OBSERVABILITY=1
refuse "OBSERVABILITY=full needs THROWAWAY=1" VARIANT=b-dosql OBSERVABILITY=full
for bad in 0 yes 2; do refuse "OBSERVABILITY=full needs THROWAWAY=1" VARIANT=b-dosql OBSERVABILITY=full "THROWAWAY=$bad"; done

echo "1b. full is refused for a live site (deploy/live-sites/<NAME>.env), before any step"
# obs_check is called directly with a stand-in ROOT: a deploy.sh run under a live NAME would write that
# site's tfvars before its first Terraform call if the refusal were missing (lib.sh).
O="$ROOT/deploy/observability.sh"
LR="$T/liveroot"; mkdir -p "$LR/deploy/live-sites"; : > "$LR/deploy/live-sites/livesite.env"
chk() { env -i PATH="$PATH" ROOT="$LR" "$@" bash -c ". '$O' && obs_check b-dosql" 2>&1; }
out=$(chk NAME=livesite OBSERVABILITY=full THROWAWAY=1); rc=$?
ok "full on a live site is refused even with THROWAWAY=1 (rc $rc)" "$([ $rc = 2 ] && grep -qF 'is a live site' <<<"$out" && echo 1 || echo 0)"
out=$(chk NAME=livesite OBSERVABILITY=1); rc=$?
ok "1 (events only) on a live site is allowed (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"
out=$(chk NAME=throwaway OBSERVABILITY=full THROWAWAY=1); rc=$?
ok "full with THROWAWAY=1 on a site NOT in deploy/live-sites is allowed (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"
out=$(chk NAME=throwaway OBSERVABILITY=full); rc=$?
ok "full WITHOUT THROWAWAY=1 is refused, also off the list (rc $rc)" "$([ $rc = 2 ] && grep -qF 'needs THROWAWAY=1' <<<"$out" && echo 1 || echo 0)"
out=$(chk NAME=throwaway OBSERVABILITY=1); rc=$?
ok "1 (events only) needs no THROWAWAY (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"

echo "1c. OBS_NO_REDACT=1 (#755): unredacted logs on a THROWAWAY only, refused otherwise, before any step"
out=$(chk NAME=throwaway OBSERVABILITY=full THROWAWAY=1 OBS_NO_REDACT=1); rc=$?
ok "OBS_NO_REDACT=1 with THROWAWAY=1 is allowed (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"
out=$(chk NAME=throwaway OBSERVABILITY=full OBS_NO_REDACT=1); rc=$?
ok "OBS_NO_REDACT=1 WITHOUT THROWAWAY=1 is refused (rc $rc)" "$([ $rc = 2 ] && grep -qF 'OBS_NO_REDACT=1 needs THROWAWAY=1' <<<"$out" && echo 1 || echo 0)"
out=$(chk NAME=throwaway OBSERVABILITY=1 OBS_NO_REDACT=1); rc=$?
ok "OBS_NO_REDACT=1 with logs 1 and no THROWAWAY is refused too (rc $rc)" "$([ $rc = 2 ] && echo 1 || echo 0)"
out=$(chk NAME=livesite OBSERVABILITY=1 THROWAWAY=1 OBS_NO_REDACT=1); rc=$?
ok "OBS_NO_REDACT=1 on a live site is refused even with THROWAWAY=1 (rc $rc)" "$([ $rc = 2 ] && grep -qF 'is a live site' <<<"$out" && echo 1 || echo 0)"
for bad in 0 yes 2; do out=$(chk NAME=throwaway OBSERVABILITY=full THROWAWAY=1 "OBS_NO_REDACT=$bad"); rc=$?
  ok "OBS_NO_REDACT=$bad is refused: 1 or unset only (rc $rc)" "$([ $rc = 2 ] && echo 1 || echo 0)"; done
out=$(env -i PATH="$PATH" ROOT="$LR" OBSERVABILITY=full THROWAWAY=1 OBS_NO_REDACT=1 bash -c ". '$O' && obs_redact site-x" 2>&1); rc=$?
ok "obs_redact with OBS_NO_REDACT=1 makes no settings call and says so (rc $rc)" "$([ $rc = 0 ] && grep -qF 'NOT redacted' <<<"$out" && echo 1 || echo 0)"
ok "  (the real list is not empty, so the rule has something to guard)" "$(ls "$ROOT"/deploy/live-sites/*.env >/dev/null 2>&1 && echo 1 || echo 0)"

echo "2. the rendered block (deploy/observability.sh)"
r() { env -i PATH="$PATH" "$@" bash -c ". '$O' && obs_block" 2>&1; }
ok "unset renders nothing (today's render)" "$([ -z "$(r)" ] && echo 1 || echo 0)"
ok "0 renders an explicit enabled = false (a deliberate off)" "$([ "$(r OBSERVABILITY=0)" = "$(printf '[observability]\nenabled = false')" ] && echo 1 || echo 0)"
ok "1 renders events only (invocation_logs = false)" "$([ "$(r OBSERVABILITY=1)" = "$(printf '[observability]\nenabled = true\nhead_sampling_rate = 1\n[observability.logs]\nenabled = true\ninvocation_logs = false')" ] && echo 1 || echo 0)"
ok "full renders the invocation logs too" "$([ "$(r OBSERVABILITY=full)" = "$(printf '[observability]\nenabled = true\nhead_sampling_rate = 1\n[observability.logs]\nenabled = true\ninvocation_logs = true')" ] && echo 1 || echo 0)"
ok "the same three blocks as deploy/wfp render_user (lib.sh), so the two paths agree" "$(for v in 0 1 full; do b=$(env -i PATH="$PATH" OBSERVABILITY=$v bash -c ". '$O' && obs_block" | tr '\n' '|' | sed 's/|$//' | sed 's/|/\\n/g'); if [ -z "$b" ] || ! grep -qF "$b" "$ROOT/deploy/wfp/lib.sh"; then echo 0; exit; fi; done; echo 1)"
ok "obs_wants_redact: on for 1 and full, off for unset and 0" "$(env -i PATH="$PATH" bash -c ". '$O'; for v in 1 full; do OBSERVABILITY=\$v obs_wants_redact || exit 1; done; for v in '' 0; do OBSERVABILITY=\$v obs_wants_redact && exit 1; done; exit 0" && echo 1 || echo 0)"

echo "3. obs_redact against a stand-in settings API"
cat > "$T/api.py" <<'PY'
import http.server, json, sys
mode = sys.argv[2]; state = {"obs": {"enabled": True, "head_sampling_rate": 1}}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, obj):
        b = json.dumps(obj).encode(); self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path == "/_state": return self._send(state)
        self._send({"success": True, "result": {"observability": state["obs"]}})
    def do_PATCH(self):
        b = self.rfile.read(int(self.headers.get("content-length", 0))).decode()
        obs = json.loads(b[b.index("{"):b.rindex("}") + 1])["observability"]
        if mode == "broken": obs = dict(obs, redact_query_string=False)
        state["obs"] = obs; state.setdefault("paths", []).append(self.path)
        self._send({"success": True, "result": {}})
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
api() { # api <mode>: start the stand-in; sets SRV and PORTN
  PORTN=$(python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
  python3 -I "$T/api.py" "$PORTN" "$1" & SRV=$!
  for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORTN/_state" && return 0; sleep 0.1; done
  return 1
}
red() { env -i PATH="$PATH" WFP_API="http://127.0.0.1:$PORTN" CLOUDFLARE_API_TOKEN=test OBS_READBACK_DELAYS=0 ROOT="$ROOT" OBSERVABILITY=1 bash -c ". '$O' && obs_redact pf-refusal-test" > "$T/red.out" 2>&1; }
api good; red; rc=$?
st=$(curl -s "http://127.0.0.1:$PORTN/_state"); kill "$SRV"; wait "$SRV" 2>/dev/null; SRV=
ok "a good redaction passes (rc $rc), on the ordinary-Worker path" "$([ $rc = 0 ] && grep -q '/workers/scripts/pf-refusal-test/settings' <<<"$st" && grep -q '"redact_query_string": true' <<<"$st" && echo 1 || echo 0)"
api broken; red; rc=$?
st=$(curl -s "http://127.0.0.1:$PORTN/_state"); kill "$SRV"; wait "$SRV" 2>/dev/null; SRV=
ok "a redaction that does not read back FAILS (rc $rc)" "$([ $rc != 0 ] && echo 1 || echo 0)"
ok "  and it turns the logs OFF (fail closed: enabled false, read back)" "$(grep -q '"enabled": false' <<<"$st" && echo 1 || echo 0)"
ok "  and says the site is deployed with its logs off" "$(grep -q 'logs are OFF' "$T/red.out" && echo 1 || echo 0)"
ok "obs_redact does nothing when OBSERVABILITY is unset (no API call)" "$(env -i PATH="$PATH" ROOT="$ROOT" WFP_API=http://127.0.0.1:9 CLOUDFLARE_API_TOKEN=test bash -c ". '$O' && obs_redact pf-refusal-test" >/dev/null 2>&1 && echo 1 || echo 0)"

echo "4. deploy.sh wiring"
D="$ROOT/deploy/deploy.sh"
# shellcheck disable=SC2016  # a literal line of deploy.sh
ok "deploy.sh checks OBSERVABILITY before any step (it sources observability.sh and calls obs_check)" "$(grep -q '^obs_check "\$VARIANT" || exit 2$' "$D" && echo 1 || echo 0)"
# #666: the render moved to render-conf.sh (render_conf), which deploy.sh sources and runs.
ok "the block is in the rendered config" "$(grep -q '^  obs_block$' "$ROOT/deploy/render-conf.sh" && grep -q '^render_conf > "\$CONF"$' "$D" && echo 1 || echo 0)"
ok "deploy.sh redacts after the upload, before the CODE_ONLY exit and the secrets" "$(awk '/^DEP=.*deploy --config/ {d=NR} /obs_redact "\$NAME"/ {r=NR} /^if \[ "\$CODE_ONLY" = 1 \]; then$/ && d {c=NR} /secret bulk/ {s=NR} END {print (d && r && c && s && d < r && r < c && r < s) ? 1 : 0}' "$D")"

echo "$fails failing case(s)"
[ "$fails" = 0 ]
