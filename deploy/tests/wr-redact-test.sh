#!/usr/bin/env bash
# #1410: a plain `wrangler deploy` of a config with logs on resets Workers Logs query-string redaction
# to false (measured on cf759hl, 2026-11-23). deploy/wr, the one wrangler every script calls, must
# re-apply it after every deploy of a logs-on config and read it back, or fail loudly with the logs off.
# A copy of deploy/wr runs against a stub wrangler (its upload resets the redaction, as the real one does)
# and a stand-in settings API. The control: the same case with the re-apply line removed from the copy
# leaves the redaction false, so this test goes red without the guard.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/wr-redact-test.XXXXXX")
SRV=
trap '[ -n "$SRV" ] && { kill "$SRV"; wait "$SRV"; } 2>/dev/null; rm -rf "$T"' EXIT

# tree <dir> <wr source>: a deploy/ tree with that wr, the real obs_settings.py, and the stub wrangler.
tree() {
  mkdir -p "$1/deploy/tools/node_modules/.bin" "$1/deploy/wfp"
  cp "$2" "$1/deploy/wr"; chmod +x "$1/deploy/wr"
  cp "$ROOT/deploy/wfp/obs_settings.py" "$1/deploy/wfp/"
  cat > "$1/deploy/tools/node_modules/.bin/wrangler" <<'SH'
#!/bin/sh
# Stub: log argv; a deploy (not --dry-run) resets the redaction of every script, as the real upload does.
printf '%s\n' "$*" >> "$STUB_LOG"
[ "${STUB_FAIL:-0}" = 1 ] && { echo "stub: deploy failed" >&2; exit 7; }
case " $* " in *" deploy "*) case " $* " in *" --dry-run "*) ;; *) curl -s -o /dev/null -X POST "$WFP_API/_reset" ;; esac ;; esac
exit 0
SH
  chmod +x "$1/deploy/tools/node_modules/.bin/wrangler"
}
tree "$T/g" "$ROOT/deploy/wr"
sed '/after-deploy/d' "$ROOT/deploy/wr" > "$T/wr.noguard"; tree "$T/n" "$T/wr.noguard"

cat > "$T/api.py" <<'PY'
import http.server, json, sys
mode = sys.argv[2]; state = {"paths": {}, "patched": []}
DEF = {"enabled": True, "head_sampling_rate": 1, "redact_query_string": True}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, obj):
        b = json.dumps(obj).encode(); self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        if self.path == "/_reset":
            state["reset"] = True
            for p in list(state["paths"]): state["paths"][p] = dict(state["paths"][p], redact_query_string=False)
        self._send({"success": True})
    def obs(self):
        o = state["paths"].setdefault(self.path, dict(DEF))
        return dict(o, redact_query_string=False) if state.get("reset") and self.path not in state["patched"] else o
    def do_GET(self):
        if self.path == "/_state": return self._send(state)
        self._send({"success": True, "result": {"observability": self.obs()}})
    def do_PATCH(self):
        b = self.rfile.read(int(self.headers.get("content-length", 0))).decode()
        obs = json.loads(b[b.index("{"):b.rindex("}") + 1])["observability"]
        if mode == "broken": obs = dict(obs, redact_query_string=False)
        state["paths"][self.path] = obs; state["patched"].append(self.path)
        self._send({"success": True, "result": {}})
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
api() {
  [ -n "$SRV" ] && { kill "$SRV"; wait "$SRV" 2>/dev/null; SRV=; }
  PORTN=$(python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
  python3 -I "$T/api.py" "$PORTN" "$1" & SRV=$!
  for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORTN/_state" && return 0; sleep 0.1; done
  return 1
}
st() { curl -s "http://127.0.0.1:$PORTN/_state"; }
# redacted <settings path>: the stand-in's redact_query_string for that path, as GET answers it
redacted() { python3 -I -c 'import json,sys,urllib.request; print(json.load(urllib.request.urlopen(sys.argv[1]+sys.argv[2]))["result"]["observability"].get("redact_query_string"))' "http://127.0.0.1:$PORTN" "$1"; }
# wr <tree> <dir> <args...>: run that tree's deploy/wr from <dir>, offline env
wr() { local t=$1 d=$2; shift 2; (cd "$d" && env -i PATH="$PATH" HOME="$T" STUB_LOG="$T/stub.log" STUB_FAIL="${STUB_FAIL:-0}" WFP_API="http://127.0.0.1:$PORTN" CLOUDFLARE_API_TOKEN="${TOK-test}" CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef OBS_READBACK_DELAYS=0 "$t/deploy/wr" "$@") > "$T/out" 2>&1; }

C="$T/conf"; mkdir -p "$C"
printf 'name = "site-on"\nmain = "w.js"\n\n[observability]\nenabled = true\nhead_sampling_rate = 1\n[observability.logs]\nenabled = true\ninvocation_logs = false\n' > "$C/on.toml"
printf 'name = "site-off"\nmain = "w.js"\n\n[observability]\nenabled = false\n' > "$C/off.toml"
printf 'name = "site-none"\nmain = "w.js"\n' > "$C/none.toml"
printf 'name = "base"\nmain = "w.js"\n\n[env.lean]\nname = "wp-lean"\n[env.lean.observability]\nenabled = true\n[env.plain]\n' > "$C/env.toml"
printf 'name = "site-default"\nmain = "w.js"\n[observability]\nenabled = true\n' > "$C/wrangler.toml"
P=/workers/scripts

echo "1. a deploy of a logs-on config re-applies the redaction and reads it back"
api good; wr "$T/g" "$C" deploy --config on.toml; rc=$?
ok "it passes (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"
ok "the stub upload ran (it resets the redaction)" "$(grep -q '^deploy --config on.toml$' "$T/stub.log" && st | grep -q '"reset": true' && echo 1 || echo 0)"
ok "the script reads back redact_query_string=true" "$([ "$(redacted $P/site-on/settings)" = True ] && echo 1 || echo 0)"
ok "it said so" "$(grep -q 'site-on query strings redacted in its logs (read back)' "$T/out" && echo 1 || echo 0)"

echo "2. the control: the same deploy through a deploy/wr WITHOUT the re-apply leaves it false"
ok "  (the copy really lost its re-apply line)" "$([ "$(grep -c after-deploy "$ROOT/deploy/wr")" -ge 1 ] && [ "$(grep -c after-deploy "$T/n/deploy/wr")" = 0 ] && echo 1 || echo 0)"
api good; wr "$T/n" "$C" deploy --config on.toml
ok "without the guard the redaction reads back false (so case 1 can go red)" "$([ "$(redacted $P/site-on/settings)" = False ] && echo 1 || echo 0)"

echo "3. it fails LOUDLY, with the logs off, when the redaction does not stick"
api broken; wr "$T/g" "$C" deploy --config on.toml; rc=$?
ok "the deploy fails (rc $rc)" "$([ $rc != 0 ] && echo 1 || echo 0)"
ok "  and the script's logs are now OFF (fail closed)" "$(python3 -I -c 'import json,sys,urllib.request; print(json.load(urllib.request.urlopen(sys.argv[1]))["result"]["observability"]["enabled"])' "http://127.0.0.1:$PORTN$P/site-on/settings" | grep -qx False && echo 1 || echo 0)"
ok "  and says it was DEPLOYED with its logs off" "$(grep -q 'site-on is DEPLOYED, but its query-string redaction did not read back, so its logs are OFF' "$T/out" && echo 1 || echo 0)"

echo "4. the right script and settings path"
api good; wr "$T/g" "$C" deploy --config on.toml --dispatch-namespace ns1
ok "--dispatch-namespace: the namespace's settings path" "$(st | grep -q '"/workers/dispatch/namespaces/ns1/scripts/site-on/settings"' && echo 1 || echo 0)"
api good; wr "$T/g" "$C" deploy --config=on.toml --name other
ok "--config=X and --name: the named script" "$(st | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["patched"])' | grep -q "'$P/other/settings'" && echo 1 || echo 0)"
api good; wr "$T/g" "$C" deploy -c env.toml --env lean
ok "--env: the env's name and its own observability block" "$(st | grep -q "\"$P/wp-lean/settings\"" && [ "$(redacted $P/wp-lean/settings)" = True ] && echo 1 || echo 0)"
api good; wr "$T/g" "$C" deploy -c env.toml -e plain; rc=$?
ok "--env with no observability of its own and none at top level: no settings call (rc $rc)" "$([ $rc = 0 ] && [ "$(st | python3 -I -c 'import json,sys; print(len(json.load(sys.stdin)["patched"]))')" = 0 ] && echo 1 || echo 0)"
api good; wr "$T/g" "$C" deploy
ok "no --config: the wrangler.toml in the working directory" "$(st | grep -q "\"$P/site-default/settings\"" && [ "$(redacted $P/site-default/settings)" = True ] && echo 1 || echo 0)"

echo "5. no settings call when there is nothing to redact, or nothing was deployed"
for c in off.toml none.toml; do
  api good; wr "$T/g" "$C" deploy --config "$c"; rc=$?
  ok "$c (logs not on): passes with no PATCH (rc $rc)" "$([ $rc = 0 ] && [ "$(st | python3 -I -c 'import json,sys; print(len(json.load(sys.stdin)["patched"]))')" = 0 ] && echo 1 || echo 0)"
done
api good; wr "$T/g" "$C" deploy --dry-run --outdir "$T/dry" --config on.toml; rc=$?
ok "--dry-run: no PATCH (rc $rc)" "$([ $rc = 0 ] && [ "$(st | python3 -I -c 'import json,sys; print(len(json.load(sys.stdin)["patched"]))')" = 0 ] && echo 1 || echo 0)"
api good; STUB_FAIL=1 wr "$T/g" "$C" deploy --config on.toml; rc=$?
ok "a failed upload keeps wrangler's exit code (7) and makes no PATCH" "$([ $rc = 7 ] && [ "$(st | python3 -I -c 'import json,sys; print(len(json.load(sys.stdin)["patched"]))')" = 0 ] && echo 1 || echo 0)"
api good; wr "$T/g" "$C" whoami; rc=$?
ok "another command passes straight through (rc $rc, no PATCH)" "$([ $rc = 0 ] && grep -qx whoami "$T/stub.log" && [ "$(st | python3 -I -c 'import json,sys; print(len(json.load(sys.stdin)["patched"]))')" = 0 ] && echo 1 || echo 0)"
api good; TOK='' wr "$T/g" "$C" deploy --config on.toml; rc=$?
ok "logs on and no CLOUDFLARE_API_TOKEN to check with: fails loudly (rc $rc)" "$([ $rc != 0 ] && grep -q 'cannot re-apply' "$T/out" && echo 1 || echo 0)"

echo "6. a deploy/wr copied WITHOUT deploy/wfp/obs_settings.py (as a mirror or a test root can be)"
mkdir -p "$T/bare/deploy/tools/node_modules/.bin"; cp "$ROOT/deploy/wr" "$T/bare/deploy/wr"; cp "$T/g/deploy/tools/node_modules/.bin/wrangler" "$T/bare/deploy/tools/node_modules/.bin/"
api good; wr "$T/bare" "$C" deploy --dry-run --outdir "$T/dry2" --config on.toml; rc=$?
ok "a --dry-run still passes, with no settings step (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"
api good; wr "$T/bare" "$C" deploy --config on.toml; rc=$?
ok "a real deploy fails LOUDLY (exit 3), naming the missing re-apply (rc $rc)" "$([ $rc = 3 ] && grep -q 'cannot re-apply' "$T/out" && echo 1 || echo 0)"

echo "7. the rollback mirror (deploy/wfp/lib.sh rollback_deploy_dir) carries obs_settings.py next to its deploy/wr"
ok "rollback_deploy_dir copies deploy/wfp/obs_settings.py into the mirror" "$(awk '/^rollback_deploy_dir\(\)/{f=1} f&&/^}/{exit} f' "$ROOT/deploy/wfp/lib.sh" | grep -q 'deploy/wfp/obs_settings.py' && echo 1 || echo 0)"

echo "$fails failing case(s)"
[ "$fails" = 0 ]
