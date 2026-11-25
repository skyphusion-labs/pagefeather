#!/usr/bin/env bash
# #751: the version id deploy.sh prints must be the one that serves.
#
# On main, wrangler deploy prints Current Version ID, then wr secret bulk publishes
# a NEW version, and that later version is the one that serves. Secrets now go in
# at the deploy (--secrets-file). A second publisher remains: obs_redact
# (deploy/observability.sh) PATCHes script settings when logs are on
# (OBSERVABILITY=1 or full), and that PATCH can publish another version. The
# printed id has to be read after that PATCH.
#
# This test's stub wrangler and stub settings API model the versions from
# constants. No account, no network. A code-only deploy publishes V_DEPLOY.
# secret bulk then publishes V_BULK (the old serving one). deploy --secrets-file
# publishes V_FILE. A settings PATCH publishes V_PATCH. The deployments list
# also carries an older deployment at 100 percent (V_OLD); the read must use
# the newest deployment's version at 100 percent.
#
# The two-step (as on main) must show printed != serving. Logs off: the
# --secrets-file version serves. Logs on: the PATCH version serves, and the
# printed id must equal it. If the deployments API cannot be read, the step
# exits non-zero and prints no Serving Version ID.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }

# The versions the stubs publish. They must differ, or a case is not a test.
V_DEPLOY=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1
V_BULK=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2
V_FILE=cccccccc-cccc-4ccc-8ccc-ccccccccccc3
V_PATCH=dddddddd-dddd-4ddd-8ddd-ddddddddddd4
V_OLD=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5
SALT=salt-TEST751-not-for-output
TOKEN=tok-TEST751-not-for-output
CF_TOKEN=cftok-TEST751-not-for-output

T=$(mktemp -d "${TMPDIR:-/tmp}/serving-version-test.XXXXXX")
SRV=
cleanup() { [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null || true; rm -rf "$T"; }
trap cleanup EXIT
mkdir -p "$T/bin" "$T/tmp"
export TMPDIR="$T/tmp"
STUB_LOG=$T/wr.log
STUB_STATE=$T/serving
STUB_META=$T/secrets.meta
STUB_PATHS=$T/paths
STUB_MODE=$T/mode
CONF=$T/wrangler.toml
: > "$CONF"
: > "$STUB_PATHS"
echo ok > "$STUB_MODE"
printf '%s\n' '{"wp_salt":{"value":"'"$SALT"'"},"spike_token":{"value":"'"$TOKEN"'"}}' > "$T/tf.json"

# Stub wrangler: records argv (paths, not secret values), models the versions.
cat > "$T/bin/wrangler" <<STUB
#!/bin/bash
set -euo pipefail
V_DEPLOY=$V_DEPLOY
V_BULK=$V_BULK
V_FILE=$V_FILE
LOG=\${STUB_LOG:?}
STATE=\${STUB_STATE:?}
META=\${STUB_META:-}
printf '%s\n' "\$*" >> "\$LOG"
cmd=\${1:-}; shift || true
name=\${NAME:-pf-sv}
secrets_file=
prev=
for a in "\$@"; do
  if [ "\$prev" = --secrets-file ]; then secrets_file=\$a; fi
  prev=\$a
done
print_deploy() {
  local vid=\$1
  cat <<EOF
Total Upload: 1.00 KiB / gzip: 0.50 KiB
Your Worker has access to the following bindings:
Binding                                                         Resource
env.SITE_ORIGIN ("https://\${name}.example.workers.dev")    Environment Variable
Uploaded \${name} (0.10 sec)
Deployed \${name} triggers (0.05 sec)
  https://\${name}.example.workers.dev
Current Version ID: \${vid}
EOF
}
case "\$cmd" in
  deploy)
    if [ -n "\$secrets_file" ]; then
      if [ -n "\$META" ] && [ -f "\$secrets_file" ]; then
        python3 -I -c 'import json, os, sys
p = sys.argv[1]
mode = oct(os.stat(p).st_mode)[-3:]
keys = ",".join(sorted(json.load(open(p))))
open(sys.argv[2], "w").write(mode + " " + keys + "\\n")' "\$secrets_file" "\$META"
      fi
      printf '%s\\n' "\$V_FILE" > "\$STATE"
      print_deploy "\$V_FILE"
    else
      printf '%s\\n' "\$V_DEPLOY" > "\$STATE"
      print_deploy "\$V_DEPLOY"
    fi
    ;;
  secret)
    sub=\${1:-}
    if [ "\$sub" = bulk ]; then
      printf '%s\\n' "\$V_BULK" > "\$STATE"
      echo "Creating the secrets for the Worker \\"\$name\\""
      echo "Current Version ID: \$V_BULK"
    else
      echo "stub wrangler: unknown secret subcommand \$sub" >&2
      exit 2
    fi
    ;;
  *)
    echo "stub wrangler: unknown command \$cmd" >&2
    exit 2
    ;;
esac
STUB
chmod +x "$T/bin/wrangler"

# Stub settings API. A PATCH of /settings publishes V_PATCH (logs on).
# GET /deployments returns the newest deployment first, its version at 100
# percent, plus an older deployment also at 100 percent (V_OLD). Mode "fail"
# makes that GET return 500. /_state needs no auth and is the test's own read.
cat > "$T/api.py" <<'PY'
import http.server, json, sys
port, state_path, mode_path, paths_path, v_patch, v_old = sys.argv[1:]
obs = {"enabled": True, "head_sampling_rate": 1, "logs": {"enabled": True, "invocation_logs": False}}

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def _auth(self):
        h = self.headers.get("Authorization") or ""
        return h.startswith("Bearer ") and len(h) > len("Bearer ")
    def _note(self, kind):
        auth = "1" if self._auth() else "0"
        with open(paths_path, "a") as f:
            f.write("%s %s auth=%s\n" % (kind, self.path.split("?")[0], auth))
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/_state":
            serving = ""
            try:
                serving = open(state_path).read().strip()
            except OSError:
                pass
            return self._send(200, {"obs": obs, "serving": serving})
        if not self._auth():
            self._note("GET")
            return self._send(401, {"success": False})
        self._note("GET")
        if path.endswith("/deployments"):
            if open(mode_path).read().strip() == "fail":
                return self._send(500, {"success": False})
            try:
                serving = open(state_path).read().strip()
            except OSError:
                return self._send(500, {"success": False})
            if not serving:
                return self._send(500, {"success": False})
            return self._send(200, {"success": True, "result": {"deployments": [
                {"id": "dep-new", "created_on": "2026-11-16T21:00:01Z", "source": "api",
                 "strategy": "percentage", "versions": [{"percentage": 100, "version_id": serving}]},
                {"id": "dep-old", "created_on": "2026-11-16T20:00:00Z", "source": "wrangler",
                 "strategy": "percentage", "versions": [{"percentage": 100, "version_id": v_old}]},
            ]}})
        return self._send(200, {"success": True, "result": {"observability": obs}})
    def do_PATCH(self):
        path = self.path.split("?")[0]
        if not self._auth():
            self._note("PATCH")
            return self._send(401, {"success": False})
        self._note("PATCH")
        n = int(self.headers.get("content-length", 0))
        b = self.rfile.read(n).decode()
        got = json.loads(b[b.index("{"):b.rindex("}") + 1])["observability"]
        obs.clear()
        obs.update(got)
        if path.endswith("/settings"):
            with open(state_path, "w") as f:
                f.write(v_patch + "\n")
        self._send(200, {"success": True, "result": {}})

http.server.HTTPServer(("127.0.0.1", int(port)), H).serve_forever()
PY
PORTN=$(python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
python3 -I "$T/api.py" "$PORTN" "$STUB_STATE" "$STUB_MODE" "$STUB_PATHS" "$V_PATCH" "$V_OLD" &
SRV=$!
api_up=0
for _ in $(seq 1 50); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORTN/_state" && api_up=1 && break
  sleep 0.1
done

export PATH="$T/bin:$PATH"
export WR="$T/bin/wrangler"
export STUB_LOG STUB_STATE STUB_META
export NAME=pf-sv
export CONF
export CODE_ONLY=0
export TF=$T
export ROOT
export ACCOUNT_ID=acct-TEST751
export CLOUDFLARE_API_TOKEN=$CF_TOKEN
export WFP_API="http://127.0.0.1:$PORTN"
export OBS_READBACK_DELAYS=0
SITE_ORIGIN=https://pf-sv.example.workers.dev
export SITE_ORIGIN
unset OBSERVABILITY

# shellcheck source=../deploy-url.sh
. "$ROOT/deploy/deploy-url.sh"
# shellcheck source=../pdf-invoice.sh
. "$ROOT/deploy/pdf-invoice.sh"
# shellcheck source=../observability.sh
. "$ROOT/deploy/observability.sh"

tf() {
  if [ "${2:-}" = output ] && [ "${3:-}" = -json ]; then
    cat "$T/tf.json"
    return 0
  fi
  echo "stub tf: unexpected $*" >&2
  return 2
}

reset_stub() {
  : > "$STUB_LOG"
  : > "$STUB_PATHS"
  echo ok > "$STUB_MODE"
  rm -f "$STUB_STATE" "$STUB_META"
  rm -rf "$TMPDIR"/pf-secrets.* "$TMPDIR"/tmp.*
}

reported_id() {
  # The Serving Version ID line only. Wrangler's "Current Version ID" is not it.
  grep -E '^Serving Version ID:' "$1" | head -1 | awk '{print $NF}'
}

serving_id() { tr -d ' \n' < "$STUB_STATE"; }

no_leak() {
  # $1.. files. 1 when none of them hold the salt, the spike token, or the API token.
  if grep -Fqe "$SALT" "$@" || grep -Fqe "$TOKEN" "$@" || grep -Fqe "$CF_TOKEN" "$@"; then
    echo 0
  else
    echo 1
  fi
}

# What deploy.sh runs between the upload and the install: upload, then
# obs_redact (a settings PATCH when logs are on), then the serving-version
# line. On a head that still prints inside the upload, pf_print_serving_version
# is absent and that earlier line is the one we compare. It is stale once the
# PATCH publishes V_PATCH.
run_upload_then_report() {
  deploy_code_and_secrets || return 1
  obs_redact "$NAME" || return 1
  if type pf_print_serving_version >/dev/null 2>&1; then
    pf_print_serving_version || return 1
  fi
  return 0
}

# The two-step as deploy.sh is on main: deploy, print that Current Version ID, then secret bulk.
run_main_two_step() {
  local secrets rc=0
  DEP=$("$WR" deploy --config "$CONF" 2>&1) || return 1
  URL=$(deployed_workers_url "$NAME" <<<"$DEP")
  echo "$DEP" | grep -E 'Total Upload|Current Version'
  secrets=$(mktemp); chmod 600 "$secrets"
  tf "$TF" output -json | deploy_secrets_json "$secrets" || { rm -f "$secrets"; return 1; }
  "$WR" secret bulk "$secrets" --config "$CONF" | tail -1
  rm -f "$secrets"
}

echo "1. main two-step (deploy then secret bulk): the stub models #751"
ok "the settings stub is up" "$api_up"
reset_stub
run_main_two_step > "$T/main.out" 2> "$T/main.err"
# The two-step prints Current Version ID, not Serving Version ID.
m_printed=$(grep -E '^Current Version ID:' "$T/main.out" | head -1 | awk '{print $NF}')
m_serving=$(serving_id)
ok "the stub versions differ" "$([ "$V_DEPLOY" != "$V_BULK" ] && [ "$V_BULK" != "$V_FILE" ] && [ "$V_FILE" != "$V_PATCH" ] && [ "$V_PATCH" != "$V_OLD" ] && [ "$V_DEPLOY" != "$V_FILE" ] && [ "$V_DEPLOY" != "$V_PATCH" ] && [ "$V_FILE" != "$V_OLD" ] && echo 1 || echo 0)"
ok "main two-step printed $m_printed, serving $m_serving: they differ (the #751 bug)" "$([ -n "$m_printed" ] && [ -n "$m_serving" ] && [ "$m_printed" != "$m_serving" ] && echo 1 || echo 0)"
ok "  printed is the code-only deploy, serving is the secret-bulk version" "$([ "$m_printed" = "$V_DEPLOY" ] && [ "$m_serving" = "$V_BULK" ] && echo 1 || echo 0)"

if [ ! -f "$ROOT/deploy/deploy-upload.sh" ]; then
  echo "  FAIL deploy/deploy-upload.sh is missing"
  fails=$((fails+1))
else
  # shellcheck source=../deploy-upload.sh
  . "$ROOT/deploy/deploy-upload.sh"

  echo "2. logs off: no settings PATCH; the --secrets-file version serves"
  reset_stub
  CODE_ONLY=0
  unset OBSERVABILITY
  run_upload_then_report > "$T/off.out" 2> "$T/off.err"; off_rc=$?
  off_printed=$(reported_id "$T/off.out")
  off_serving=$(serving_id)
  ok "logs off exits 0 (rc $off_rc)" "$([ "$off_rc" = 0 ] && echo 1 || echo 0)"
  ok "logs off: reported id equals the version that serves (printed $off_printed, serving $off_serving)" "$([ -n "$off_printed" ] && [ "$off_printed" = "$off_serving" ] && [ "$off_serving" = "$V_FILE" ] && echo 1 || echo 0)"
  ok "logs off: exactly one Serving Version ID line, and no Current Version ID line" "$([ "$(grep -cE '^Serving Version ID:' "$T/off.out")" = 1 ] && ! grep -q 'Current Version ID:' "$T/off.out" && echo 1 || echo 0)"
  ok "logs off: no settings PATCH" "$(grep -q 'PATCH ' "$STUB_PATHS" && echo 0 || echo 1)"
  ok "wrangler was called with --secrets-file, not secret bulk" "$(grep -q -- '--secrets-file' "$STUB_LOG" && ! grep -q 'secret bulk' "$STUB_LOG" && echo 1 || echo 0)"
  ok "the secrets file at deploy was mode 600 with WP_SALT and SPIKE_TOKEN" "$([ -s "$STUB_META" ] && grep -q '^600 SPIKE_TOKEN,WP_SALT$' "$STUB_META" && echo 1 || echo 0)"
  ok "no leftover secrets dir under TMPDIR" "$(ls -d "$TMPDIR"/pf-secrets.* >/dev/null 2>&1 && echo 0 || echo 1)"
  ok "the salt and the tokens are not in stdout, stderr, the wrangler log, or the API path log" "$(no_leak "$T/off.out" "$T/off.err" "$STUB_LOG" "$STUB_PATHS")"

  echo "3. logs on: the settings PATCH publishes a new version, and that one serves"
  reset_stub
  CODE_ONLY=0
  OBSERVABILITY=1
  run_upload_then_report > "$T/on.out" 2> "$T/on.err"; on_rc=$?
  on_printed=$(reported_id "$T/on.out")
  on_serving=$(serving_id)
  ok "logs on: the stub PATCH published $V_PATCH (serving $on_serving)" "$([ "$on_serving" = "$V_PATCH" ] && grep -q 'PATCH /workers/scripts/pf-sv/settings' "$STUB_PATHS" && echo 1 || echo 0)"
  ok "logs on: reported id equals the version that serves after the settings PATCH (printed $on_printed, serving $on_serving)" "$([ "$on_rc" = 0 ] && [ -n "$on_printed" ] && [ "$on_printed" = "$on_serving" ] && [ "$on_serving" = "$V_PATCH" ] && echo 1 || echo 0)"
  ok "logs on: exactly one Serving Version ID line, and no Current Version ID line" "$([ "$(grep -cE '^Serving Version ID:' "$T/on.out")" = 1 ] && ! grep -q 'Current Version ID:' "$T/on.out" && echo 1 || echo 0)"
  ok "logs on: the deployments GET is after the settings PATCH, with a bearer token, and it is not the older deployment" "$(
    awk '/PATCH \/workers\/scripts\/pf-sv\/settings/ {p=NR} /GET \/workers\/scripts\/pf-sv\/deployments auth=1/ {g=NR} END {print (p && g && g > p) ? 1 : 0}' "$STUB_PATHS"
  )"
  ok "logs on: secrets still go in at the deploy (--secrets-file, mode 600)" "$(grep -q -- '--secrets-file' "$STUB_LOG" && grep -q '^600 SPIKE_TOKEN,WP_SALT$' "$STUB_META" && echo 1 || echo 0)"
  ok "logs on: the salt and the tokens are not in stdout, stderr, the wrangler log, or the API path log" "$(no_leak "$T/on.out" "$T/on.err" "$STUB_LOG" "$STUB_PATHS")"

  echo "3b. OBSERVABILITY=full: the same PATCH (logs on)"
  reset_stub
  CODE_ONLY=0
  OBSERVABILITY=full
  run_upload_then_report > "$T/full.out" 2> "$T/full.err"; full_rc=$?
  full_printed=$(reported_id "$T/full.out")
  full_serving=$(serving_id)
  ok "OBSERVABILITY=full: reported id equals the PATCH version (printed $full_printed, serving $full_serving, rc $full_rc)" "$([ "$full_rc" = 0 ] && [ "$full_printed" = "$full_serving" ] && [ "$full_serving" = "$V_PATCH" ] && echo 1 || echo 0)"

  echo "4. CODE_ONLY, logs off: no secrets file; the deploy version serves"
  reset_stub
  CODE_ONLY=1
  unset OBSERVABILITY
  run_upload_then_report > "$T/co.out" 2> "$T/co.err"; co_rc=$?
  co_printed=$(reported_id "$T/co.out")
  co_serving=$(serving_id)
  ok "CODE_ONLY logs off exits 0 (rc $co_rc)" "$([ "$co_rc" = 0 ] && echo 1 || echo 0)"
  ok "CODE_ONLY logs off: reported id equals serving (printed $co_printed, serving $co_serving)" "$([ "$co_printed" = "$co_serving" ] && [ "$co_serving" = "$V_DEPLOY" ] && echo 1 || echo 0)"
  ok "CODE_ONLY logs off: exactly one Serving Version ID line" "$([ "$(grep -cE '^Serving Version ID:' "$T/co.out")" = 1 ] && echo 1 || echo 0)"
  ok "CODE_ONLY wrangler argv has neither --secrets-file nor secret bulk" "$(grep -q -- '--secrets-file' "$STUB_LOG" || grep -q 'secret bulk' "$STUB_LOG" && echo 0 || echo 1)"

  echo "4b. CODE_ONLY, logs on: obs_redact runs too; the PATCH version serves"
  reset_stub
  CODE_ONLY=1
  OBSERVABILITY=1
  run_upload_then_report > "$T/co-on.out" 2> "$T/co-on.err"; co_on_rc=$?
  co_on_printed=$(reported_id "$T/co-on.out")
  co_on_serving=$(serving_id)
  ok "CODE_ONLY logs on: the stub PATCH published $V_PATCH (serving $co_on_serving)" "$([ "$co_on_serving" = "$V_PATCH" ] && echo 1 || echo 0)"
  ok "CODE_ONLY logs on: reported id equals the version that serves after the settings PATCH (printed $co_on_printed, serving $co_on_serving)" "$([ "$co_on_rc" = 0 ] && [ -n "$co_on_printed" ] && [ "$co_on_printed" = "$co_on_serving" ] && [ "$co_on_serving" = "$V_PATCH" ] && echo 1 || echo 0)"
  ok "CODE_ONLY logs on: exactly one Serving Version ID line" "$([ "$(grep -cE '^Serving Version ID:' "$T/co-on.out")" = 1 ] && ! grep -q 'Current Version ID:' "$T/co-on.out" && echo 1 || echo 0)"
  ok "CODE_ONLY logs on: no secrets file" "$(grep -q -- '--secrets-file' "$STUB_LOG" && echo 0 || echo 1)"

  echo "5. the deployments API cannot be read: the deploy fails"
  reset_stub
  CODE_ONLY=0
  unset OBSERVABILITY
  echo fail > "$STUB_MODE"
  run_upload_then_report > "$T/bad.out" 2> "$T/bad.err"; bad_rc=$?
  ok "cannot read the serving version: non-zero exit (rc $bad_rc)" "$([ "$bad_rc" != 0 ] && echo 1 || echo 0)"
  ok "  and it says the serving version could not be read" "$(grep -q 'could not be read' "$T/bad.err" && echo 1 || echo 0)"
  ok "  and it does not print a Serving Version ID" "$(grep -q '^Serving Version ID:' "$T/bad.out" && echo 0 || echo 1)"
  ok "  and the salt and the tokens are not in that output" "$(no_leak "$T/bad.out" "$T/bad.err" "$STUB_LOG" "$STUB_PATHS")"
fi

echo "6. deploy.sh wiring"
D="$ROOT/deploy/deploy.sh"
U="$ROOT/deploy/deploy-upload.sh"
ok "deploy.sh sources deploy-upload.sh" "$(grep -q 'deploy/deploy-upload.sh' "$D" && echo 1 || echo 0)"
ok "deploy.sh calls deploy_code_and_secrets, then obs_redact, then pf_print_serving_version, before CODE_ONLY" "$(awk '
  /deploy_code_and_secrets/ {u=NR}
  /obs_redact "\$NAME"/ {r=NR}
  /pf_print_serving_version/ {p=NR}
  /^if \[ "\$CODE_ONLY" = 1 \]; then$/ && u {c=NR}
  END {print (u && r && p && c && u < r && r < p && p < c) ? 1 : 0}
' "$D")"
ok "deploy.sh does not run secret bulk" "$(grep -q 'secret bulk' "$D" && echo 0 || echo 1)"
ok "deploy-upload.sh uses --secrets-file, not secret bulk" "$(grep -q -- '--secrets-file' "$U" && ! grep -q 'secret bulk' "$U" && echo 1 || echo 0)"
ok "the deployments read is curl -K with a process substitution, not -H Authorization" "$(
  grep -q 'workers/scripts/\$NAME/deployments' "$U" && grep -q -- '-K <(printf' "$U" && ! grep -q -- '-H "Authorization' "$U" && echo 1 || echo 0
)"
# #1476 review: the cron-schedules source must sit outside the CODE_ONLY terraform branch and before
# the readback call, or a code-only deploy calls an undefined cron_schedules_readback and fails
# loudly after a successful upload (the pre-#1476 arrangement, since 1f03dcd).
ok "deploy.sh sources cron-schedules.sh outside the CODE_ONLY terraform branch, before the readback" "$(awk '
  /^if \[ "\$CODE_ONLY" != 1 \]; then$/ && !b {b=NR}
  b && !e && /^else$/ {e=NR}
  /^\. .*cron-schedules\.sh/ {s=NR}
  /cron_schedules_readback/ && !r {r=NR}
  END {print (s && r && s < r && !(b && e && s > b && s < e)) ? 1 : 0}
' "$D")"

echo "$fails failing case(s)"
[ "$fails" = 0 ]
