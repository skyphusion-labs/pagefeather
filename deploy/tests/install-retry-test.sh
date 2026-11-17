#!/usr/bin/env bash
# #811: deploy.sh's /_install retry. A local stub answers for the site. Its response headers are
# constants written below; nothing from the request is copied onto the response. The spike token
# and the admin password are compared and recorded as match or mismatch, never written out.
#   few-403: 403 three times, then the install JSON. The retry must succeed.
#   never: 403 until the bound. The install step must exit non-zero and name the status, the
#   body's first bytes, and the deployment id from the Cloudflare API (not the 403's
#   x-worker-version), and must not print either secret or the API token.
#   api-down: the same 403s, and the deployment API answers 500. Status and body only.
#   after-500, after-text, closed port: the other retry answers (5xx, non-JSON, no answer).
#   fail-json: JSON that is not installed fails at once.
#   already: installed "already" is success.
#   secret-body: a non-JSON body that is the password is redacted.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fails=0
ok() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: got '$2', want '$3'"; fails=$((fails+1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/install-retry-test.XXXXXX")
trap 'kill "${SPID:-}" 2>/dev/null || true; rm -rf "$T"' EXIT
SPIKE_TOKEN=tok-test-811-secret
ADMIN_PASSWORD=pw-test-811-secret
API_TOKEN=cf-test-811-secret
API_ACCOUNT=00000000000000000000000000000000
API_NAME=pf-install-test

# Response headers in answer() are literals. raw is a constant body, not a request header.
# The 403 still carries x-worker-version. The install step must not print it.
cat > "$T/stub.py" <<'PY'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
port = int(sys.argv[1])
mode = sys.argv[2]
log_path = sys.argv[3]
expect_token = sys.argv[4]
expect_pw = sys.argv[5]
expect_api = sys.argv[6]
expect_acct = sys.argv[7]
expect_name = sys.argv[8]
VERSION_OLD = "ef237fa1"
VERSION_NEW = "afcbeff5"
SECRET_BODY = b"pw-test-811-secret"
OK = json.dumps({"bootMs": 1, "ms": 57, "out": json.dumps({"installed": True, "user_id": 1}), "errors": "", "d1": {}}).encode()
ALREADY = json.dumps({"bootMs": 1, "ms": 4, "out": json.dumps({"installed": "already"}), "errors": "", "d1": {}}).encode()
BAD = json.dumps({"bootMs": 1, "ms": 2, "out": json.dumps({"installed": False, "error": "admin password missing or shorter than 12"}), "errors": "", "d1": {}}).encode()
n = {"i": 0}

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def answer(self, status, raw, version, ctype):
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(raw)))
        self.send_header("x-worker-version", version)
        self.end_headers()
        self.wfile.write(raw)
    def do_GET(self):
        deploy = "/accounts/%s/workers/scripts/%s/deployments" % (expect_acct, expect_name)
        if self.path.split("?", 1)[0] == deploy:
            auth = self.headers.get("authorization", "")
            open(log_path, "a").write("api auth=%s\n" % ("match" if auth == "Bearer " + expect_api else "mismatch"))
            if mode == "api-down":
                self.answer(500, SECRET_BODY + b" " + expect_api.encode("utf-8"), VERSION_OLD, "text/plain")
                return
            raw = json.dumps({
                "success": True,
                "result": {"deployments": [{
                    "id": "11111111-1111-4111-8111-111111111111",
                    "author_email": "should-not-print@example.com",
                    "annotations": {"workers/message": expect_pw},
                    "versions": [{"percentage": 100, "version_id": "22222222-2222-4222-8222-222222222222"}],
                }]},
            }).encode("utf-8")
            self.answer(200, raw, VERSION_OLD, "application/json")
            return
        if self.path != "/ready":
            self.answer(404, b"no", VERSION_OLD, "text/plain")
            return
        self.answer(200, b"ok", VERSION_OLD, "text/plain")
    def do_POST(self):
        n["i"] += 1
        i = n["i"]
        tok = self.headers.get("x-spike-token")
        pw = self.headers.get("x-admin-password")
        open(log_path, "a").write("post %d token=%s password=%s\n" % (
            i, "match" if tok == expect_token else "mismatch", "match" if pw == expect_pw else "mismatch"))
        if mode == "few-403" and i <= 3:
            self.answer(403, b"forbidden", VERSION_OLD, "text/plain")
        elif mode == "never" or mode == "api-down":
            self.answer(403, b"forbidden", VERSION_OLD, "text/plain")
        elif mode == "after-500" and i == 1:
            self.answer(502, b"bad gateway", VERSION_OLD, "text/plain")
        elif mode == "after-text" and i == 1:
            self.answer(200, b"not-json", VERSION_OLD, "text/plain")
        elif mode == "fail-json":
            self.answer(200, BAD, VERSION_OLD, "application/json")
        elif mode == "already":
            self.answer(200, ALREADY, VERSION_NEW, "application/json")
        elif mode == "trunc" and i == 1:
            # #605 (TAG 11162233, the npm arm): the envelope cut off mid-body. Its first bytes say installed true, but
            # it is not one JSON value. Headers promise more bytes than arrive, then the connection closes.
            self.send_response(200); self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(OK) + 500)); self.send_header("x-version", VERSION_NEW); self.end_headers()
            self.wfile.write(OK[:90]); self.wfile.flush(); self.close_connection = True
            return
        elif mode == "trunc":
            self.answer(200, ALREADY, VERSION_NEW, "application/json")
        elif mode == "secret-body":
            self.answer(200, SECRET_BODY, VERSION_OLD, "text/plain")
        else:
            self.answer(200, OK, VERSION_NEW, "application/json")
    def log_message(self, *a):
        pass

HTTPServer(("127.0.0.1", port), H).serve_forever()
PY

SPID=
start_stub() {
  local mode=$1
  kill "${SPID:-}" 2>/dev/null || true
  wait "${SPID:-}" 2>/dev/null || true
  PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
  : > "$T/log"
  python3 -I "$T/stub.py" "$PORT" "$mode" "$T/log" "$SPIKE_TOKEN" "$ADMIN_PASSWORD" "$API_TOKEN" "$API_ACCOUNT" "$API_NAME" &
  SPID=$!
  disown "$SPID" 2>/dev/null || true
  local i
  for i in $(seq 1 50); do curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/ready" && return 0; sleep 0.05; done
  echo "stub did not start" >&2
  return 1
}
run_install() { # run_install <mode> [VAR=value ...]
  local mode=$1
  shift
  start_stub "$mode" || { echo 97 > "$T/rc"; return; }
  env -i PATH="$PATH" HOME="$HOME" SPIKE_TOKEN="$SPIKE_TOKEN" ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    CF_API="http://127.0.0.1:$PORT" \
    "$@" bash -c '. "$1" && install_wordpress "$2"' _ "$ROOT/deploy/install.sh" "http://127.0.0.1:$PORT" \
    > "$T/out" 2> "$T/err"
  echo $? > "$T/rc"
  cat "$T/out" "$T/err" > "$T/both"
}
posts() { grep -c '^post ' "$T/log" 2>/dev/null || true; }
secrets_in() { grep -F -e "$SPIKE_TOKEN" -e "$ADMIN_PASSWORD" -e "$API_TOKEN" -e 'should-not-print@example.com' "$1" 2>/dev/null | wc -l | tr -d ' '; }

echo "1. 403, then the install JSON"
run_install few-403 INSTALL_WAIT_S=30 INSTALL_INTERVAL_S=0
ok "403 three times then JSON: exit 0" "$(cat "$T/rc")" "0"
ok "403 three times then JSON: four posts" "$(posts)" "4"
ok "403 three times then JSON: the success line is the installed JSON" "$(grep -c '^{"installed": true, "user_id": 1} 57 ms$' "$T/out")" "1"
ok "403 three times then JSON: the headers matched and the log has no secret" "$(grep -c 'token=match password=match' "$T/log") $(secrets_in "$T/log")" "4 0"
ok "403 three times then JSON: the output has no secret" "$(secrets_in "$T/both")" "0"
ok "403 three times then JSON: no deployment read on success" "$(grep -c '^api ' "$T/log" || true)" "0"

echo "2. never installs"
run_install never INSTALL_WAIT_S=3 INSTALL_INTERVAL_S=1 \
  NAME="$API_NAME" ACCOUNT_ID="$API_ACCOUNT" CLOUDFLARE_API_TOKEN="$API_TOKEN"
ok "never: exit non-zero" "$([ "$(cat "$T/rc")" != 0 ] && echo 1 || echo 0)" "1"
np=$(posts)
case "$np" in
  2|3|4|5) range=ok ;;
  *) range=bad ;;
esac
ok "never: posts in 2..5 (got $np)" "$range" "ok"
ok "never: names the status, the body and the deployment from the API" "$(grep -c 'install failed after .*s: last status 403; body: forbidden; worker pf-install-test deployment 11111111-1111-4111-8111-111111111111 version 22222222-2222-4222-8222-222222222222' "$T/err")" "1"
ok "never: the 403 header version is not in the output" "$(grep -c ef237fa1 "$T/both" || true)" "0"
ok "never: the API token matched and was not logged" "$(grep -c 'api auth=match' "$T/log") $(secrets_in "$T/log")" "1 0"
ok "never: the output has no secret" "$(secrets_in "$T/both")" "0"

echo "2b. the deployment API does not answer"
run_install api-down INSTALL_WAIT_S=2 INSTALL_INTERVAL_S=1 \
  NAME="$API_NAME" ACCOUNT_ID="$API_ACCOUNT" CLOUDFLARE_API_TOKEN="$API_TOKEN"
ok "api down: exit non-zero" "$([ "$(cat "$T/rc")" != 0 ] && echo 1 || echo 0)" "1"
ok "api down: status and body, no deployment" "$(grep -c 'install failed after .*s: last status 403; body: forbidden$' "$T/err")" "1"
ok "api down: says the deployment was not read" "$(grep -c 'install: Worker deployment was not read (HTTP 500)' "$T/err")" "1"
ok "api down: the 403 version stays out, and so do the secrets" "$(grep -c ef237fa1 "$T/both" || true) $(secrets_in "$T/both")" "0 0"

echo "3. the other retry answers, and a JSON failure"
run_install after-500 INSTALL_WAIT_S=30 INSTALL_INTERVAL_S=0
ok "502 then JSON: exit 0 after two posts" "$(cat "$T/rc") $(posts)" "0 2"
run_install after-text INSTALL_WAIT_S=30 INSTALL_INTERVAL_S=0
ok "non-JSON then JSON: exit 0 after two posts" "$(cat "$T/rc") $(posts)" "0 2"
run_install fail-json INSTALL_WAIT_S=30 INSTALL_INTERVAL_S=5
ok "installed false: exit 1 on the first post" "$(cat "$T/rc") $(posts)" "1 1"
ok "installed false: names the status and does not claim success" "$(grep -c 'install failed: last status 200;' "$T/err") $(grep -c 'user_id' "$T/out")" "1 0"
run_install already INSTALL_WAIT_S=30 INSTALL_INTERVAL_S=0
ok "installed already: exit 0, one post" "$(cat "$T/rc") $(posts)" "0 1"
run_install trunc INSTALL_WAIT_S=30 INSTALL_INTERVAL_S=0
ok "#605 a cut-off answer (installed true in its first bytes), then already: exit 0, two posts" "$(cat "$T/rc") $(posts)" "0 2"
ok "installed already: the success line" "$(grep -c '^{"installed": "already"} 4 ms$' "$T/out")" "1"

echo "4. no answer, and a body that is the password"
CLOSED=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
env -i PATH="$PATH" HOME="$HOME" SPIKE_TOKEN="$SPIKE_TOKEN" ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  INSTALL_WAIT_S=2 INSTALL_INTERVAL_S=1 \
  bash -c '. "$1" && install_wordpress "$2"' _ "$ROOT/deploy/install.sh" "http://127.0.0.1:$CLOSED" \
  > "$T/out" 2> "$T/err"
echo $? > "$T/rc"
cat "$T/out" "$T/err" > "$T/both"
ok "no answer: exit 1" "$(cat "$T/rc")" "1"
ok "no answer: status none, empty body, no version" "$(grep -c 'install failed after .*s: last status none; body: (empty)$' "$T/err")" "1"
ok "no answer: the output has no secret" "$(secrets_in "$T/both")" "0"

run_install secret-body INSTALL_WAIT_S=2 INSTALL_INTERVAL_S=1
ok "secret body: exit 1" "$(cat "$T/rc")" "1"
ok "secret body: redacted, no version from the 403" "$(grep -c 'body: \[redacted\]$' "$T/err") $(grep -c ef237fa1 "$T/both" || true)" "1 0"
ok "secret body: the output has no secret" "$(secrets_in "$T/both")" "0"

echo "5. deploy.sh calls the retry and no longer ignores a non-JSON install"
ok "deploy.sh sources install.sh and fails the deploy when install_wordpress fails" \
  "$(grep -q '\. "\$ROOT/deploy/install.sh"' "$ROOT/deploy/deploy.sh" && grep -q 'install_wordpress "\$URL" || exit 1' "$ROOT/deploy/deploy.sh" && ! grep -q 'install did not answer JSON' "$ROOT/deploy/deploy.sh" && echo yes || echo no)" "yes"
ok "the headers still go through curl -K and a process substitution" \
  "$(grep -q -- '-K <(printf' "$ROOT/deploy/install.sh" && ! grep -E -- '-H[[:space:]]+["'"'"']x-(spike-token|admin-password)' "$ROOT/deploy/install.sh" && echo yes || echo no)" "yes"
# #855: PhpRuntime /_cron-tick adds one more plain 403 (not spike; no build id).
ok "a refused spike stays the plain 403, with no build id" \
  "$(grep -c "return new Response('forbidden', { status: 403 });" "$ROOT/spikes/b2-wordpress/index.js") $(grep -c 'spikeForbidden' "$ROOT/spikes/b2-wordpress/index.js" || true) $(grep -c 'x-worker-version' "$ROOT/spikes/b2-wordpress/index.js" || true)" "3 0 0"
ok "install.sh does not read x-worker-version" "$(grep -c 'x-worker-version' "$ROOT/deploy/install.sh" || true)" "0"

# #605: deploy/wfp's site add installs through the SAME helper (one check, no drift): its own one-read check took a
# cut-off answer as a failure and an answer that said installed false as a pass.
ok "#605 deploy/wfp/site.sh sources deploy/install.sh and installs with install_wordpress" "$(grep -q '\. "\$ROOT/deploy/install.sh"' "$ROOT/deploy/wfp/site.sh" && grep -q 'install_wordpress "\$ORIGIN"' "$ROOT/deploy/wfp/site.sh" && echo 1 || echo 0)" "1"
ok "#605 deploy/wfp/site.sh has no install check of its own left" "$(grep -c 'install did not answer JSON' "$ROOT/deploy/wfp/site.sh" || true)" "0"

echo "$fails failing case(s)"
exit "$fails"
