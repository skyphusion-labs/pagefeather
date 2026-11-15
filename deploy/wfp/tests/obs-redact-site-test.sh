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
conf() { # conf <OBSERVABILITY value> <file>: the [observability] block render_user writes for it
  printf 'name = "site-x"\n[vars]\nSITE_ORIGIN = "https://x.example"\n' > "$2"
  case "$1" in
    0|'') printf '\n[observability]\nenabled = false\n' >> "$2" ;;
    1) printf '\n[observability]\nenabled = true\nhead_sampling_rate = 1\n[observability.logs]\nenabled = true\ninvocation_logs = false\n' >> "$2" ;;
    full) printf '\n[observability]\nenabled = true\nhead_sampling_rate = 1\n[observability.logs]\nenabled = true\ninvocation_logs = true\n' >> "$2" ;;
    none) ;;
  esac
}
red() { # red <OBSERVABILITY value of the rendered config>: obs_redact_site for site-x in wfp-ns; rc
  # The env says nothing here (OBSERVABILITY is unset): the rendered config decides (#639, the add and
  # rollback paths upload a config whose env may be another run's).
  conf "$1" "$T/c.toml"
  env -i PATH="$PATH" HOME="$HOME" WFP_API="http://127.0.0.1:$PORTN" CLOUDFLARE_API_TOKEN=test OBS_READBACK_DELAYS=0 \
    bash -c ". '$LIB' && obs_redact_site wfp-ns site-x '$T/c.toml'" > "$T/red.out" 2>&1
}
for v in 1 full; do
  api good; red "$v"; rc=$?; st=$(curl -s "http://127.0.0.1:$PORTN/_state"); stop
  ok "OBSERVABILITY=$v: a good redaction passes (rc $rc) on the dispatch-namespace path" "$([ $rc = 0 ] && grep -q '"redact_query_string": true' <<<"$st" && grep -q 'dispatch/namespaces/wfp-ns/scripts/site-x/settings' <<<"$st" && echo 1 || echo 0)"
  api broken; red "$v"; rc=$?; st=$(curl -s "http://127.0.0.1:$PORTN/_state"); stop
  ok "OBSERVABILITY=$v: a redaction that does not read back fails (rc $rc) and turns the logs OFF" "$([ $rc != 0 ] && grep -q '"enabled": false' <<<"$st" && echo 1 || echo 0)"
done
for v in '' 0 none; do
  api good; red "$v"; rc=$?; st=$(curl -s "http://127.0.0.1:$PORTN/_state"); stop
  ok "OBSERVABILITY='$v': no redaction call (rc $rc)" "$([ $rc = 0 ] && grep -q '"calls": 0' <<<"$st" && echo 1 || echo 0)"
done
ok "site update redacts right after its upload, by its rendered config" "$(awk '/"\$WR" deploy --config "\$CONF" --dispatch-namespace/ {u=NR} /obs_redact_site "\$NAMESPACE" "site-\$s" "\$CONF"/ && u && !r {r=NR} /tfr site apply/ && u && !a {a=NR} END {print (u && r && a && u < r && r < a) ? 1 : 0}' "$HERE/../site")"
# #639 review (the lead): site ADD is site.sh up, which uploaded and never redacted. It must redact right
# after the upload and fail BEFORE the dispatcher routes the site.
ok "site add (site.sh up) redacts right after the user Worker upload, before the dispatcher" "$(awk '/deploy --config "\$CONF" --dispatch-namespace "\$NAMESPACE" --secrets-file/ {u=NR} /obs_redact_site "\$NAMESPACE" "\$U" "\$CONF"/ {r=NR} /render_site_dispatcher/ && !d {d=NR} END {print (u && r && d && u < r && r < d) ? 1 : 0}' "$HERE/../site.sh")"
ok "  and a failed redaction stops the add (exit, never on to the dispatcher)" "$(grep -E 'obs_redact_site "\$NAMESPACE" "\$U" "\$CONF" \|\| \{.*exit 1' "$HERE/../site.sh" >/dev/null && echo 1 || echo 0)"
ok "the rollback re-deploy redacts after its upload, by the rollback config" "$(awk '/deploy --config "\$SAVED\/wrangler.rollback.toml"/ {u=NR} /obs_redact_site "\$NAMESPACE" "site-\$s" "\$SAVED\/wrangler.rollback.toml"/ {r=NR} END {print (u && r && u < r) ? 1 : 0}' "$HERE/../site")"
# shellcheck disable=SC2016  # a literal line of the old site
ok "site no longer gates the redaction on OBSERVABILITY=1 alone" "$(grep -q 'if \[ "\${OBSERVABILITY:-0}" = 1 \]; then python3 -I "\$WFP/obs_settings.py" redact' "$HERE/../site" && echo 0 || echo 1)"
echo "$fails failing case(s)"
[ "$fails" = 0 ]
