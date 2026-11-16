#!/usr/bin/env bash
# #751: the version id deploy.sh prints must be the one that serves. On main, wrangler
# deploy prints Current Version ID, then wr secret bulk publishes a NEW version, and
# that later version is the one that serves. This test's stub wrangler models those
# versions from constants: a code-only deploy publishes V_DEPLOY; secret bulk then
# publishes V_BULK (the serving one); deploy --secrets-file publishes V_FILE, which
# serves. The two-step (as on main) must show printed != serving. deploy_code_and_secrets
# must print exactly one version id, labelled as the serving one, equal to the version
# that serves. No account, no network. The stub is a shell script on PATH.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }

# The three versions the stub publishes. They must differ, or the two-step case is not a test.
V_DEPLOY=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1
V_BULK=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2
V_FILE=cccccccc-cccc-4ccc-8ccc-ccccccccccc3
SALT=salt-TEST751-not-for-output
TOKEN=tok-TEST751-not-for-output

T=$(mktemp -d "${TMPDIR:-/tmp}/serving-version-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/tmp"
export TMPDIR="$T/tmp"
STUB_LOG=$T/wr.log
STUB_STATE=$T/serving
STUB_META=$T/secrets.meta
CONF=$T/wrangler.toml
: > "$CONF"
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
  if [ "\${STUB_NO_VERSION:-0}" = 1 ]; then
    cat <<EOF
Total Upload: 1.00 KiB / gzip: 0.50 KiB
Uploaded \${name} (0.10 sec)
Deployed \${name} triggers (0.05 sec)
  https://\${name}.example.workers.dev
EOF
    return 0
  fi
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

export PATH="$T/bin:$PATH"
export WR="$T/bin/wrangler"
export STUB_LOG STUB_STATE STUB_META
export NAME=pf-sv
export CONF
export CODE_ONLY=0
export TF=$T
export ROOT
SITE_ORIGIN=https://pf-sv.example.workers.dev
export SITE_ORIGIN

# shellcheck source=../deploy-url.sh
. "$ROOT/deploy/deploy-url.sh"
# shellcheck source=../pdf-invoice.sh
. "$ROOT/deploy/pdf-invoice.sh"

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
  rm -f "$STUB_STATE" "$STUB_META"
  rm -rf "$TMPDIR"/pf-secrets.* "$TMPDIR"/tmp.*
}

reported_id() {
  # The first version id the step printed (Serving Version ID if labelled, else Current).
  grep -E '^(Serving Version ID|Current Version ID):' "$1" | head -1 | awk '{print $NF}'
}

serving_id() { tr -d ' \n' < "$STUB_STATE"; }

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
reset_stub
run_main_two_step > "$T/main.out" 2> "$T/main.err"
m_printed=$(reported_id "$T/main.out")
m_serving=$(serving_id)
ok "the three stub versions differ" "$([ "$V_DEPLOY" != "$V_BULK" ] && [ "$V_BULK" != "$V_FILE" ] && [ "$V_DEPLOY" != "$V_FILE" ] && echo 1 || echo 0)"
ok "main two-step printed $m_printed, serving $m_serving: they differ (the #751 bug)" "$([ -n "$m_printed" ] && [ -n "$m_serving" ] && [ "$m_printed" != "$m_serving" ] && echo 1 || echo 0)"
ok "  printed is the code-only deploy, serving is the secret-bulk version" "$([ "$m_printed" = "$V_DEPLOY" ] && [ "$m_serving" = "$V_BULK" ] && echo 1 || echo 0)"

echo "2. deploy_code_and_secrets"
if [ ! -f "$ROOT/deploy/deploy-upload.sh" ]; then
  echo "  FAIL deploy/deploy-upload.sh is missing"
  fails=$((fails+1))
else
  # shellcheck source=../deploy-upload.sh
  . "$ROOT/deploy/deploy-upload.sh"
  reset_stub
  CODE_ONLY=0
  deploy_code_and_secrets > "$T/fn.out" 2> "$T/fn.err"; fn_rc=$?
  f_printed=$(reported_id "$T/fn.out")
  f_serving=$(serving_id)
  ok "deploy_code_and_secrets exits 0 (rc $fn_rc)" "$([ "$fn_rc" = 0 ] && echo 1 || echo 0)"
  ok "the reported id equals the version that serves (printed $f_printed, serving $f_serving)" "$([ -n "$f_printed" ] && [ "$f_printed" = "$f_serving" ] && echo 1 || echo 0)"
  ok "exactly one version id line, labelled Serving Version ID" "$([ "$(grep -cE 'Version ID:' "$T/fn.out")" = 1 ] && grep -q '^Serving Version ID:' "$T/fn.out" && echo 1 || echo 0)"
  ok "that serving id is the --secrets-file version ($V_FILE)" "$([ "$f_serving" = "$V_FILE" ] && echo 1 || echo 0)"
  ok "wrangler was called with --secrets-file, not secret bulk" "$(grep -q -- '--secrets-file' "$STUB_LOG" && ! grep -q 'secret bulk' "$STUB_LOG" && echo 1 || echo 0)"
  ok "the secrets file at deploy was mode 600 with WP_SALT and SPIKE_TOKEN" "$( [ -s "$STUB_META" ] && grep -q '^600 SPIKE_TOKEN,WP_SALT$' "$STUB_META" && echo 1 || echo 0)"
  ok "no leftover secrets dir under TMPDIR" "$(ls -d "$TMPDIR"/pf-secrets.* >/dev/null 2>&1 && echo 0 || echo 1)"
  ok "the salt and spike token are not in stdout, stderr, or the wrangler argv log" "$(
    if grep -Fqe "$SALT" "$T/fn.out" "$T/fn.err" "$STUB_LOG" || grep -Fqe "$TOKEN" "$T/fn.out" "$T/fn.err" "$STUB_LOG"; then echo 0; else echo 1; fi
  )"

  echo "2b. CODE_ONLY=1: no secrets file; the deploy version serves"
  reset_stub
  CODE_ONLY=1
  deploy_code_and_secrets > "$T/co.out" 2> "$T/co.err"; co_rc=$?
  c_printed=$(reported_id "$T/co.out")
  c_serving=$(serving_id)
  ok "CODE_ONLY exits 0 (rc $co_rc)" "$([ "$co_rc" = 0 ] && echo 1 || echo 0)"
  ok "CODE_ONLY: reported id equals serving (printed $c_printed, serving $c_serving)" "$([ "$c_printed" = "$c_serving" ] && [ "$c_serving" = "$V_DEPLOY" ] && echo 1 || echo 0)"
  ok "CODE_ONLY: exactly one Serving Version ID line" "$([ "$(grep -cE 'Version ID:' "$T/co.out")" = 1 ] && grep -q '^Serving Version ID:' "$T/co.out" && echo 1 || echo 0)"
  ok "CODE_ONLY wrangler argv has neither --secrets-file nor secret bulk" "$(grep -q -- '--secrets-file' "$STUB_LOG" || grep -q 'secret bulk' "$STUB_LOG" && echo 0 || echo 1)"

  echo "2c. wrangler prints no version id: the deploy fails"
  reset_stub
  CODE_ONLY=0
  STUB_NO_VERSION=1 deploy_code_and_secrets > "$T/nv.out" 2> "$T/nv.err"; nv_rc=$?
  ok "no Current Version ID: non-zero exit (rc $nv_rc)" "$([ "$nv_rc" != 0 ] && echo 1 || echo 0)"
  ok "  and it says the serving version is unknown" "$(grep -q 'serving version is unknown' "$T/nv.err" "$T/nv.out" && echo 1 || echo 0)"
  ok "  and it did not print a Serving Version ID" "$(grep -q '^Serving Version ID:' "$T/nv.out" && echo 0 || echo 1)"
fi

echo "3. deploy.sh wiring"
D="$ROOT/deploy/deploy.sh"
U="$ROOT/deploy/deploy-upload.sh"
ok "deploy.sh sources deploy-upload.sh" "$(grep -q 'deploy/deploy-upload.sh' "$D" && echo 1 || echo 0)"
ok "deploy.sh calls deploy_code_and_secrets before obs_redact and CODE_ONLY" "$(awk '/deploy_code_and_secrets/ {u=NR} /obs_redact "\$NAME"/ {r=NR} /^if \[ "\$CODE_ONLY" = 1 \]; then$/ && u {c=NR} END {print (u && r && c && u < r && r < c) ? 1 : 0}' "$D")"
ok "deploy.sh does not run secret bulk" "$(grep -q 'secret bulk' "$D" && echo 0 || echo 1)"
ok "deploy-upload.sh uses --secrets-file, not secret bulk" "$(grep -q -- '--secrets-file' "$U" && ! grep -q 'secret bulk' "$U" && echo 1 || echo 0)"

echo "$fails failing case(s)"
[ "$fails" = 0 ]
