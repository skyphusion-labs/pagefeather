#!/usr/bin/env bash
# #639: deploy/wfp redacts a site's log query strings for OBSERVABILITY=1 AND full, fail closed
# (lib.sh obs_redact_site, called by `site update` right after the upload). Before #639 only 1 was
# redacted (site:172), so a full site logged every URL with its query string. Against a stand-in
# settings API (WFP_API, as obs-settings-test.py): a good redaction passes for 1 and full; one that
# does not read back fails AND turns the logs off; unset and 0 make no call.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
LIB="$HERE/../lib.sh"
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/obs-redact-site-test.XXXXXX")
SRV=
trap '[ -n "$SRV" ] && kill "$SRV" 2>/dev/null; rm -rf "$T"' EXIT
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
red() { # red <OBSERVABILITY value>: obs_redact_site for site-x in namespace wfp-ns; rc
  env -i PATH="$PATH" HOME="$HOME" WFP_API="http://127.0.0.1:$PORTN" CLOUDFLARE_API_TOKEN=test OBS_READBACK_DELAYS=0 OBSERVABILITY="$1" \
    bash -c ". '$LIB' && obs_redact_site wfp-ns site-x" > "$T/red.out" 2>&1
}
for v in 1 full; do
  api good; red "$v"; rc=$?; st=$(curl -s "http://127.0.0.1:$PORTN/_state"); stop
  ok "OBSERVABILITY=$v: a good redaction passes (rc $rc) on the dispatch-namespace path" "$([ $rc = 0 ] && grep -q '"redact_query_string": true' <<<"$st" && grep -q 'dispatch/namespaces/wfp-ns/scripts/site-x/settings' <<<"$st" && echo 1 || echo 0)"
  api broken; red "$v"; rc=$?; st=$(curl -s "http://127.0.0.1:$PORTN/_state"); stop
  ok "OBSERVABILITY=$v: a redaction that does not read back fails (rc $rc) and turns the logs OFF" "$([ $rc != 0 ] && grep -q '"enabled": false' <<<"$st" && echo 1 || echo 0)"
done
for v in '' 0; do
  api good; red "$v"; rc=$?; st=$(curl -s "http://127.0.0.1:$PORTN/_state"); stop
  ok "OBSERVABILITY='$v': no redaction call (rc $rc)" "$([ $rc = 0 ] && grep -q '"calls": 0' <<<"$st" && echo 1 || echo 0)"
done
ok "site update calls obs_redact_site right after the upload" "$(awk '/deploy --config "\$CONF" --dispatch-namespace/ {u=NR} /obs_redact_site "\$NAMESPACE" "site-\$s"/ {r=NR} /tfr site apply/ && u {a=NR} END {print (u && r && a && u < r && r < a) ? 1 : 0}' "$HERE/../site")"
# shellcheck disable=SC2016  # a literal line of the old site
ok "site no longer gates the redaction on OBSERVABILITY=1 alone" "$(grep -q 'if \[ "\${OBSERVABILITY:-0}" = 1 \]; then python3 -I "\$WFP/obs_settings.py" redact' "$HERE/../site" && echo 0 || echo 1)"
echo "$fails failing case(s)"
[ "$fails" = 0 ]
