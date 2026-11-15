#!/usr/bin/env bash
# #639: OBSERVABILITY=full on a site listed in deploy/live-sites/ is refused before any upload
# or build. A full redaction that does not read back turns the logs off and fails (fail closed,
# obs_settings.py redact-or-off). OBSERVABILITY=1 and unset are not refused.
# Against a stand-in API only (WFP_API). No Cloudflare account.
#   deploy/wfp/tests/obs-full-live-test.sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
LIB="$HERE/../lib.sh"
SITE="$HERE/../site"
SITESH="$HERE/../site.sh"
UPSH="$HERE/../up.sh"
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails + 1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/obs-full-live-test.XXXXXX")
SRV=
trap '[ -n "$SRV" ] && kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; rm -rf "$T"' EXIT

echo "1. full with a redaction that does not read back turns the logs off and fails"
cat > "$T/api.py" <<'PY'
import http.server, json, sys
mode = sys.argv[2]; state = {"obs": {"enabled": True, "head_sampling_rate": 1}, "calls": 0}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, obj):
        b = json.dumps(obj).encode(); self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path == "/_state": return self._send(state)
        state["calls"] += 1
        self._send({"success": True, "result": {"observability": state["obs"]}})
    def do_PATCH(self):
        b = self.rfile.read(int(self.headers.get("content-length", 0))).decode()
        obs = json.loads(b[b.index("{"):b.rindex("}") + 1])["observability"]
        if mode == "broken": obs = dict(obs, redact_query_string=False)
        state["obs"] = obs; state["calls"] += 1; state["path"] = self.path
        self._send({"success": True, "result": {}})
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
api() {
  PORTN=$(python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
  python3 -I "$T/api.py" "$PORTN" "$1" & SRV=$!
  for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORTN/_state" && return 0; sleep 0.1; done
  return 1
}
stop() { kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; SRV=; }
conf() {
  printf 'name = "site-x"\n' > "$2"
  case "$1" in
    1) printf '\n[observability]\nenabled = true\nhead_sampling_rate = 1\n[observability.logs]\nenabled = true\ninvocation_logs = false\n' >> "$2" ;;
    full) printf '\n[observability]\nenabled = true\nhead_sampling_rate = 1\n[observability.logs]\nenabled = true\ninvocation_logs = true\n' >> "$2" ;;
    *) printf '\n[observability]\nenabled = false\n' >> "$2" ;;
  esac
}
red() {
  conf "$1" "$T/c.toml"
  env -i PATH="$PATH" HOME="${HOME:-/tmp}" WFP_API="http://127.0.0.1:$PORTN" CLOUDFLARE_API_TOKEN=test OBS_READBACK_DELAYS=0 \
    bash -c ". '$LIB' && obs_redact_site wfp-ns site-x '$T/c.toml'" > "$T/red.out" 2>&1
}
api broken; red full; rc=$?; st=$(curl -s "http://127.0.0.1:$PORTN/_state"); stop
ok "full: a redaction that does not read back fails (rc $rc) and turns the logs OFF" "$([ "$rc" != 0 ] && grep -q '"enabled": false' <<<"$st" && echo 1 || echo 0)"
api good; red 1; rc=$?; st=$(curl -s "http://127.0.0.1:$PORTN/_state"); stop
ok "1: a good redaction passes (rc $rc) and reads back redact_query_string true" "$([ "$rc" = 0 ] && grep -q '"redact_query_string": true' <<<"$st" && echo 1 || echo 0)"
api good; red unset; rc=$?; st=$(curl -s "http://127.0.0.1:$PORTN/_state"); stop
ok "unset: no redaction call (rc $rc)" "$([ "$rc" = 0 ] && grep -q '"calls": 0' <<<"$st" && echo 1 || echo 0)"

echo "2. full on a live-site name is refused before any upload or build"
ok "deploy/live-sites lists woocap and zarapo" "$([ -f "$ROOT/deploy/live-sites/woocap.env" ] && [ -f "$ROOT/deploy/live-sites/zarapo.env" ] && echo 1 || echo 0)"
echo '{"sites": {}}' > "$T/state.json"
python3 -I "$HERE/fake-account.py" "$T/port" "$T/state.json" & SRV=$!
for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
mkdir -p "$T/bin"
cat > "$T/bin/terraform" <<EOF
#!/bin/sh
printf '%s\\n' "\$*" >> "$T/tf.log"
case "\$*" in
  init*) exit 0 ;;
  "output -raw kv_namespace_id") printf kv1 ;;
  "workspace list") printf '* default\\n  one\\n' ;;
  *) echo "stand-in terraform: \$* is not expected" >&2; exit 9 ;;
esac
EOF
chmod +x "$T/bin/terraform"
PORT=$(cat "$T/port")
# A clean environment: the stand-in API and terraform, never the caller's token or account.
run() { # run <command> [args...]; prints rc, writes, tf-lines, then the output
  rm -f "$T/state.json.writes" "$T/tf.log"
  local out rc writes tf
  out=$(env -i PATH="$T/bin:$PATH" HOME="${HOME:-/tmp}" TMPDIR="${TMPDIR:-/tmp}" \
    WFP_API="http://127.0.0.1:$PORT" WFP_STATE=local CLOUDFLARE_API_TOKEN=test \
    ACCOUNT_ID=test-account NAMESPACE=wp-wfp \
    "$@" 2>&1); rc=$?
  writes=$(cat "$T/state.json.writes" 2>/dev/null | wc -l | tr -d ' ')
  tf=0; [ -f "$T/tf.log" ] && tf=$(wc -l < "$T/tf.log" | tr -d ' ')
  printf '%s\n%s\n%s\n' "$rc" "$writes" "$tf"
  printf '%s\n' "$out"
}
# First three lines are rc, api writes, terraform invocations. The rest is the command output.
live_refused() { # live_refused <label> <command> [args...]
  local label=$1; shift
  local meta rc writes tf out
  meta=$(run "$@"); out=$(printf '%s\n' "$meta" | tail -n +4)
  rc=$(printf '%s\n' "$meta" | sed -n '1p')
  writes=$(printf '%s\n' "$meta" | sed -n '2p')
  tf=$(printf '%s\n' "$meta" | sed -n '3p')
  ok "$label: refused before any upload (rc $rc, api writes $writes, terraform calls $tf)" \
    "$([ "$rc" = 2 ] && [ "$writes" = 0 ] && [ "$tf" = 0 ] && printf '%s\n' "$out" | grep -q 'is a live site' && ! printf '%s\n' "$out" | grep -q 'not built' && echo 1 || echo 0)"
  printf '%s\n' "$out" | sed 's/^/      /'
}
for name in woocap zarapo; do
  live_refused "site update $name OBSERVABILITY=full THROWAWAY=1" \
    env OBSERVABILITY=full THROWAWAY=1 "$SITE" update "$name"
  # BUILD stays unset (site add's default is 0). A missing refusal must stop at the
  # "not built" gate, never at build_dosql, so this test cannot start a real build.
  live_refused "site add $name OBSERVABILITY=full (no THROWAWAY)" \
    env OBSERVABILITY=full "$SITE" add "$name"
  live_refused "site.sh up $name OBSERVABILITY=full THROWAWAY=1" \
    env OBSERVABILITY=full THROWAWAY=1 "$SITESH" up "$name"
done
live_refused "up.sh SITES=woocap OBSERVABILITY=full THROWAWAY=1 BUILD=0" \
  env OBSERVABILITY=full THROWAWAY=1 BUILD=0 SITES=woocap "$UPSH"
live_refused "up.sh SITES='one woocap' refuses before the build of either" \
  env OBSERVABILITY=full THROWAWAY=1 BUILD=0 SITES="one woocap" "$UPSH"

echo "3. 1 and unset behave as today (not the live-site refusal)"
as_today() { # as_today <label> <command> [args...]
  local label=$1; shift
  local meta rc out
  meta=$(run "$@"); out=$(printf '%s\n' "$meta" | tail -n +4)
  rc=$(printf '%s\n' "$meta" | sed -n '1p')
  # The same refusal site update gives a name with no workspace: exit 2, no live-site line.
  ok "$label: not a live-site refusal (rc $rc)" \
    "$([ "$rc" = 2 ] && ! printf '%s\n' "$out" | grep -q 'is a live site' && printf '%s\n' "$out" | grep -q 'no site woocap' && echo 1 || echo 0)"
}
as_today "site update woocap OBSERVABILITY=1" env OBSERVABILITY=1 "$SITE" update woocap
as_today "site update woocap OBSERVABILITY unset" env -u OBSERVABILITY "$SITE" update woocap
as_today "site update woocap OBSERVABILITY=0" env OBSERVABILITY=0 "$SITE" update woocap
# A name with no deploy/live-sites file is not this refusal (THROWAWAY still gates the render).
meta=$(run env OBSERVABILITY=full THROWAWAY=1 "$SITE" update pf639)
out=$(printf '%s\n' "$meta" | tail -n +4); rc=$(printf '%s\n' "$meta" | sed -n '1p')
ok "site update pf639 OBSERVABILITY=full is not a live-site refusal (rc $rc)" \
  "$([ "$rc" = 2 ] && ! printf '%s\n' "$out" | grep -q 'is a live site' && printf '%s\n' "$out" | grep -q 'no site pf639' && echo 1 || echo 0)"

# shellcheck disable=SC1090
. "$LIB"
render_rc() { # render_rc <site> [NAME=value ...]; toml in $T/render.toml, stderr in $T/render.err
  local site=$1; shift
  env "$@" bash -c ". '$LIB'; render_user \"\$1\" \"\$2\"" _ "$site" "https://$site.example" > "$T/render.toml" 2>"$T/render.err"
}
render_rc woocap THROWAWAY=1 OBSERVABILITY=full; rc=$?
ok "render_user woocap OBSERVABILITY=full THROWAWAY=1 is refused as a live site (rc $rc)" \
  "$([ "$rc" != 0 ] && grep -q 'is a live site' "$T/render.err" && ! grep -q 'invocation_logs = true' "$T/render.toml" && echo 1 || echo 0)"
render_rc woocap OBSERVABILITY=1; rc=$?
ok "render_user woocap OBSERVABILITY=1 still renders events only (rc $rc)" \
  "$([ "$rc" = 0 ] && grep -q 'invocation_logs = false' "$T/render.toml" && echo 1 || echo 0)"
render_rc woocap; rc=$?
ok "render_user woocap OBSERVABILITY unset still renders an explicit off (rc $rc)" \
  "$([ "$rc" = 0 ] && grep -q 'enabled = false' "$T/render.toml" && echo 1 || echo 0)"
render_rc one THROWAWAY=1 OBSERVABILITY=full; rc=$?
ok "render_user one (not a live site) OBSERVABILITY=full THROWAWAY=1 still has invocation logs (rc $rc)" \
  "$([ "$rc" = 0 ] && grep -q 'invocation_logs = true' "$T/render.toml" && echo 1 || echo 0)"

echo "4. the refusal is ordered before the build and the upload"
order() { # order <label> <file> <awk program printing 1 when the early line is before the late one>
  local got; got=$(awk "$3" "$2")
  ok "$1" "$got"
}
order "site refuses full before shared terraform init" "$SITE" \
  '/obs_refuse_full/ && !e {e=NR} /tfr shared init/ && !t {t=NR} END {print (e && t && e < t) ? 1 : 0}'
order "site update_one refuses full before its build_dosql" "$SITE" \
  '/update_one_inner\(\)/ {u=NR} /obs_refuse_full/ && u && !r {r=NR} /build_dosql/ && u && !b {b=NR} END {print (u && r && b && u < r && r < b) ? 1 : 0}'
order "site add refuses full before its build (BUILD=1 would build)" "$SITE" \
  '/obs_refuse_full/ && !e {e=NR} /BUILD:-0/ && !b {b=NR} END {print (e && b && e < b) ? 1 : 0}'
order "site.sh up refuses full before the user Worker upload" "$SITESH" \
  '/obs_refuse_full/ && !e {e=NR} /deploy --config/ && !d {d=NR} END {print (e && d && e < d) ? 1 : 0}'
order "up.sh refuses full before build_dosql" "$UPSH" \
  '/obs_refuse_full/ && !e {e=NR} /build_dosql/ && !b {b=NR} END {print (e && b && e < b) ? 1 : 0}'

echo "$fails failing case(s)"
[ "$fails" = 0 ]
