#!/bin/bash
# site update uploads a same-build config change (#421).
# The old gate compared the build id only, so a PHP_INI or OBSERVABILITY change
# printed "nothing to do" and exited 0. The hash is the rendered user config
# plus the sorted secret key names. A secret value is not part of it.
#   deploy/wfp/tests/config-hash-test.sh
# Offline: a fake account, a fake S3, a stub terraform and a stub wrangler.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LIB="$HERE/../lib.sh"
SITE="$HERE/../site"
WFP=$(cd "$HERE/.." && pwd)
ROOT=$(cd "$WFP/../.." && pwd)
# shellcheck disable=SC1090
. "$LIB"
fails=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2] want [$3]"; fails=$((fails + 1)); fi; }
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }

# The old script has no update_upload_reasons. Show what its build-id gate does
# with each case, then stop. Running `site update` here would call build_dosql
# on the real app (APP is fixed until this change), so this is the check that
# can run on the old code.
if ! declare -F update_upload_reasons >/dev/null 2>&1 || ! declare -F config_hash >/dev/null 2>&1; then
  echo "OLD GATE: deploy/wfp/site decides from the build id alone:"
  grep -n 'nothing to do' "$SITE" || true
  old() { if [ "$1" = "$2" ] && [ "${3:-0}" != 1 ]; then echo "nothing to do"; else echo "upload"; fi; }
  echo "  same build + same config: $(old bld bld 0) (this case also skips on the old gate)"
  echo "  same build + changed PHP_INI: $(old bld bld 0) (want upload, reason: config changed)"
  echo "  same build + changed secret value: $(old bld bld 0) (this case also skips on the old gate; the value is not hashed)"
  echo "  same build + new secret key: $(old bld bld 0) (want upload)"
  echo "  no recorded hash: $(old bld bld 0) (want upload, reason: no recorded config hash)"
  echo "  FORCE_UPLOAD=1: $(old bld bld 1) (want upload, reason: forced; the old line says FORCE_UPLOAD=1, not reason: forced)"
  echo "FAIL update_upload_reasons or config_hash is not in lib.sh"
  exit 1
fi
ok "the build-id-only skip is gone" "$(grep -c 'if \[ "$new" = "$rollback" \] && \[ "${FORCE_UPLOAD:-0}" != 1 \]' "$SITE" | grep -qx 0 && echo 1 || echo 0)"

# The hash: rendered bytes plus sorted key names. Values never enter it, and never the output.
T=$(mktemp -d)
ACCT_PID=""
S3_PID=""
cleanup() {
  if [ -n "${ACCT_PID:-}" ]; then kill "$ACCT_PID" 2>/dev/null || true; wait "$ACCT_PID" 2>/dev/null || true; fi
  if [ -n "${S3_PID:-}" ]; then kill "$S3_PID" 2>/dev/null || true; wait "$S3_PID" 2>/dev/null || true; fi
  rm -rf "$T"
}
trap cleanup EXIT
printf 'rendered-v1\n' > "$T/cfg"
printf '%s\n' '{"WP_SALT":"salt-value-aaa","SPIKE_TOKEN":"spike-value-bbb"}' > "$T/sec"
h1=$(config_hash "$T/cfg" "$T/sec" 2>"$T/hash.err") || { echo "FAIL config_hash rc $?"; cat "$T/hash.err"; exit 1; }
printf '%s\n' '{"SPIKE_TOKEN":"spike-value-bbb","WP_SALT":"salt-value-aaa"}' > "$T/sec-order"
h_order=$(config_hash "$T/cfg" "$T/sec-order")
check "key order does not change the hash" "$h_order" "$h1"
printf '%s\n' '{"WP_SALT":"salt-value-CHANGED","SPIKE_TOKEN":"spike-value-bbb"}' > "$T/sec-val"
h_val=$(config_hash "$T/cfg" "$T/sec-val")
check "a changed secret value does not change the hash" "$h_val" "$h1"
printf '%s\n' '{"SPIKE_TOKEN":"spike-value-bbb","TURNSTILE_SECRET":"turnstile-value-ccc","WP_SALT":"salt-value-aaa"}' > "$T/sec-key"
h_key=$(config_hash "$T/cfg" "$T/sec-key")
ok "a new secret key changes the hash" "$([ "$h_key" != "$h1" ] && echo 1 || echo 0)"
printf 'rendered-v2\n' > "$T/cfg2"
h_cfg=$(config_hash "$T/cfg2" "$T/sec")
ok "a changed rendered config changes the hash" "$([ "$h_cfg" != "$h1" ] && echo 1 || echo 0)"
ok "the hash is 64 hex characters" "$(printf '%s' "$h1" | grep -qxE '[0-9a-f]{64}' && echo 1 || echo 0)"
blob=$(printf '%s' "$h1 $h_order $h_val $h_key $h_cfg"; cat "$T/hash.err" 2>/dev/null)
ok "the hasher output has no secret value" "$(printf '%s' "$blob" | grep -cE 'salt-value-aaa|salt-value-CHANGED|spike-value-bbb|turnstile-value-ccc' | grep -qx 0 && echo 1 || echo 0)"
# A bad secrets file fails without echoing the body.
printf 'not-json salt-value-aaa\n' > "$T/bad"
config_hash "$T/cfg" "$T/bad" >"$T/bad.out" 2>"$T/bad.err" || true
ok "a bad secrets file does not print its body" "$(cat "$T/bad.out" "$T/bad.err" | grep -c 'salt-value-aaa' | grep -qx 0 && echo 1 || echo 0)"

# kv_build.py reads config_hash the same way it reads build. A missing field is empty.
# The code line has no trailing newline after it (lib.sh api's -w '\n%{http_code}').
kb() { printf '%s' "$1"$'\n'"200" | python3 "$WFP/kv_build.py" "$2"; }
check "kv_build.py config_hash" "$(kb '{"build":"bld","config_hash":"abc"}' config_hash)" "abc"
check "kv_build.py config_hash missing" "$(kb '{"build":"bld"}' config_hash)" ""
check "kv_build.py still defaults to build" "$(printf '%s' '{"build":"bld","config_hash":"abc"}'$'\n''200' | python3 "$WFP/kv_build.py")" "bld"

# update_upload_reasons: the three upload reasons, plus a missing hash.
check "same build, same hash: no reason" "$(update_upload_reasons b b "$h1" "$h1")" ""
check "same build, different hash: config changed" "$(update_upload_reasons b b "$h_cfg" "$h1")" "config changed"
check "missing hash: no recorded config hash" "$(update_upload_reasons b b "$h1" "")" "no recorded config hash"
check "different build: build changed" "$(update_upload_reasons n o "$h1" "$h1")" "build changed"
check "FORCE_UPLOAD=1: forced" "$(FORCE_UPLOAD=1 update_upload_reasons b b "$h1" "$h1")" "forced"
check "FORCE and a new build: both reasons" "$(FORCE_UPLOAD=1 update_upload_reasons n o "$h1" "$h1")" "build changed, forced"

# The real `site update`, with the build, terraform, S3 and the upload stubbed.
# Nothing here talks to Cloudflare.
unset PHP_INI PHP_RECYCLE MEM_LEDGER OPCACHE_SPLIT TURNSTILE_SITEKEY TURNSTILE_SECRET \
  TURNSTILE_WOO TURNSTILE_LOGIN TURNSTILE_COMMENTS OBSERVABILITY MAIL_FROM MAIL_FROM_NAME HTTP_ALLOW_HOSTS \
  WFP_PHP_ENV PHP_LOCATION LAZY_CACHE_MB LAZY_ARENA LAZY_ARENA_MB LAZY_ARENA_COPY ARENA_VERIFY PURGE_TEST_OFF WP_VECTORIZE_SEARCH FORCE_UPLOAD PLUGINS IMPORT_CONTENT IMPORT_THEMES \
  IMPORT_PLUGINS IMPORT_MU_PLUGINS FORCE_FAIL COUNT_ROWS WFP_CUSTOM_DOMAIN REPLACE_INPUTS || true
export WOO_ACTIVE=0 ALLOW_DIRTY=1 NO_SNAPSHOT=1 BUILD_WAIT=4 BUILD_POLL_S=0.2 BUILD_EVICT_AFTER=3
export ACCOUNT_ID=test-account CLOUDFLARE_API_TOKEN=test NAMESPACE=wp-wfp
export SALT=salt-value-aaa SPIKE=spike-value-bbb
APP="$T/app"
mkdir -p "$APP/build" "$APP/node_modules" "$APP/vendor" "$T/bin"
printf 'compatibility_date = "2026-07-01"\n' > "$APP/wrangler.toml"
ln -s "$ROOT/spikes/b2-wordpress/mail-from.mjs" "$APP/mail-from.mjs"
ln -s "$ROOT/spikes/b2-wordpress/http-allow.mjs" "$APP/http-allow.mjs"
: > "$APP/vendor/php_8_3.js"; : > "$APP/vendor/php_8_3.wasm"
: > "$APP/build/site.zip"; : > "$APP/build/opcache.zip"
printf 'export default "bld-same";\n' > "$APP/build/build-id.js"
cat > "$APP/build.sh" <<'SH'
#!/bin/bash
mkdir -p build vendor
printf 'export default "bld-same";\n' > build/build-id.js
: > build/site.zip; : > build/opcache.zip
: > vendor/php_8_3.js; : > vendor/php_8_3.wasm
echo built
SH
# prepare.sh runs on every build (#446). Without it every build here failed, and before #464 the
# update went on after the failed build, so this test passed on a build that never ran.
printf '#!/bin/bash\necho prepared\n' > "$APP/prepare.sh"; chmod +x "$APP/prepare.sh"
echo '#!/bin/bash' > "$APP/opcache.sh"
echo 'echo primed' >> "$APP/opcache.sh"
printf 'print("c00000001")\n' > "$APP/content-id.py"
chmod +x "$APP/build.sh" "$APP/opcache.sh"

STATE="$T/state.json"
cat > "$STATE" <<'JSON'
{"sites": {"shop": {"entry": "{\"script\":\"site-shop\",\"outbound\":true,\"build\":\"bld-same\"}"}}, "ns_list_shape": "top"}
JSON
python3 -I "$HERE/fake-account.py" "$T/port" "$STATE" >/dev/null 2>&1 & ACCT_PID=$!
cat > "$T/s3.py" <<'PY'
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
port_file = sys.argv[1]
store = {}
class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def _send(self, code, body=b""):
        self.send_response(code)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        p = self.path.split("?", 1)[0]
        if p in store:
            self._send(200, store[p])
        else:
            self._send(404, b"missing")
    def do_PUT(self):
        n = int(self.headers.get("content-length", "0") or "0")
        body = self.rfile.read(n) if n else b""
        store[self.path.split("?", 1)[0]] = body
        self._send(200, b"")
s = ThreadingHTTPServer(("127.0.0.1", 0), H)
open(port_file, "w").write(str(s.server_port))
s.serve_forever()
PY
python3 -I "$T/s3.py" "$T/s3port" >/dev/null 2>&1 & S3_PID=$!
for _ in $(seq 1 50); do [ -s "$T/port" ] && [ -s "$T/s3port" ] && break; sleep 0.1; done
[ -s "$T/port" ] && [ -s "$T/s3port" ] || { echo "FAIL the fake account or S3 did not start"; exit 1; }
export WFP_API="http://127.0.0.1:$(cat "$T/port")"
export WFP_S3_ENDPOINT="http://127.0.0.1:$(cat "$T/s3port")"
export WFP_S3_KEY_ID=test-s3-key WFP_S3_SECRET=test-s3-secret
export APP
REAL_CURL=$(PATH=/usr/bin:/bin command -v curl)
UPLOAD_LOG="$T/uploads"; APPLY_LOG="$T/applies"
: > "$UPLOAD_LOG"; : > "$APPLY_LOG"
export UPLOAD_LOG APPLY_LOG SALT SPIKE
cat > "$T/bin/curl" <<EOF
#!/bin/bash
args="\$*"
# Only the site origin. The KV path also contains the workers.dev hostname.
if [[ "\$args" != *https://*.workers.dev* ]]; then
  exec $REAL_CURL "\$@"
fi
if [[ "\$args" == *rest_route* ]]; then
  printf '404'
elif [[ "\$args" == */_build* ]]; then
  printf '%s\n' '{"build":"bld-same"}'
else
  printf '200'
fi
EOF
cat > "$T/bin/terraform" <<'SH'
#!/bin/bash
case "$1" in
  init|workspace|state) 
    if [ "$1" = workspace ] && [ "$2" = list ]; then printf '* default\n  shop\n'; fi
    exit 0 ;;
  output)
    if [ "$2" = "-json" ]; then
      SALT="$SALT" SPIKE="$SPIKE" python3 -I -c 'import json,os; print(json.dumps({"wp_salt":{"value":os.environ["SALT"]},"spike_token":{"value":os.environ["SPIKE"]},"hostname":{"value":"wp-shop.sub.workers.dev"},"r2_endpoint":{"value":os.environ["WFP_S3_ENDPOINT"]}}))'
    else
      case "$3" in
        kv_namespace_id) printf kv1 ;;
        hostname) printf '%s' "wp-shop.sub.workers.dev" ;;
        spike_token) printf '%s' "$SPIKE" ;;
        r2_endpoint) printf '%s' "$WFP_S3_ENDPOINT" ;;
        *) echo "stub terraform: unexpected output $*" >&2; exit 9 ;;
      esac
    fi ;;
  apply)
    printf '%s\n' "$*" >> "$APPLY_LOG"
    exit 0 ;;
  *) echo "stub terraform: unexpected $*" >&2; exit 9 ;;
esac
SH
cat > "$T/wr" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >> "$UPLOAD_LOG"
# Do not read the secrets file. An upload log must not gain a secret value.
exit 0
SH
chmod +x "$T/bin/curl" "$T/bin/terraform" "$T/wr"
export PATH="$T/bin:$PATH" WR="$T/wr"

lines() { wc -l < "$1" | tr -d ' '; }
set_entry() { # set_entry <build> <hash or empty>
  python3 -I -c '
import json, sys
p, build, h = sys.argv[1], sys.argv[2], sys.argv[3]
s = json.load(open(p))
e = {"script": "site-shop", "outbound": True, "build": build}
if h:
    e["config_hash"] = h
s["sites"]["shop"]["entry"] = json.dumps(e, separators=(",", ":"))
with open(p, "w") as f:
    json.dump(s, f)
' "$STATE" "$1" "${2:-}"
}
last_hash() { sed -n 's/.*config_hash=\([0-9a-f]\{64\}\).*/\1/p' "$APPLY_LOG" | tail -1; }
no_secret() {
  local blob
  blob=$(printf '%s' "$OUT"; cat "$UPLOAD_LOG" "$APPLY_LOG")
  if printf '%s' "$blob" | grep -qE 'salt-value-aaa|salt-value-CHANGED|spike-value-bbb|turnstile-value-ccc'; then
    echo 0
  else
    echo 1
  fi
}
run_update() {
  OUT=$("$SITE" update shop 2>&1)
  RC=$?
}

# Direct read of a missing hash, the same call site update makes.
read_entry() { WFP_API="$WFP_API" CLOUDFLARE_API_TOKEN=test KV_ID=kv1 SUB=sub bash -c '. "'"$LIB"'"; entry_build shop; entry_config_hash shop'; }
got_entry=$(read_entry)
check "entry_build reads the recorded build" "$(printf '%s\n' "$got_entry" | sed -n 1p)" "bld-same"
check "entry_config_hash: a site with no hash reads empty" "$(printf '%s\n' "$got_entry" | sed -n 2p)" ""

# 1. No recorded hash: upload once, and say so.
u0=$(lines "$UPLOAD_LOG"); a0=$(lines "$APPLY_LOG")
run_update
u1=$(lines "$UPLOAD_LOG"); a1=$(lines "$APPLY_LOG")
ok "no recorded hash: exit 0" "$([ "$RC" = 0 ] && echo 1 || echo 0)"
ok "no recorded hash: reason stated" "$(printf '%s' "$OUT" | grep -Fqx 'site shop: upload build bld-same (was bld-same); reason: no recorded config hash' && echo 1 || echo 0)"
ok "no recorded hash: uploaded once" "$([ "$u1" = $((u0 + 1)) ] && echo 1 || echo 0)"
ok "no recorded hash: the apply records a config hash" "$([ "$a1" = $((a0 + 1)) ] && last_hash | grep -qxE '[0-9a-f]{64}' && echo 1 || echo 0)"
ok "no recorded hash: no secret in the output" "$(no_secret)"
H0=$(last_hash)
[ "$RC" = 0 ] || { echo "$OUT" | sed 's/^/   /'; }

# 2. Same build, same config: nothing to do, no upload.
set_entry bld-same "$H0"
unset PHP_INI TURNSTILE_SECRET FORCE_UPLOAD
export SALT=salt-value-aaa
u0=$(lines "$UPLOAD_LOG"); a0=$(lines "$APPLY_LOG")
run_update
u1=$(lines "$UPLOAD_LOG"); a1=$(lines "$APPLY_LOG")
ok "same config: exit 0" "$([ "$RC" = 0 ] && echo 1 || echo 0)"
ok "same config: nothing to do" "$(printf '%s' "$OUT" | grep -Fqx 'site shop: already at build bld-same; nothing to do' && echo 1 || echo 0)"
ok "same config: no upload and no apply" "$([ "$u1" = "$u0" ] && [ "$a1" = "$a0" ] && echo 1 || echo 0)"
ok "same config: no secret in the output" "$(no_secret)"
[ "$RC" = 0 ] || { echo "$OUT" | sed 's/^/   /'; }

# 3. Same build, changed PHP_INI: upload, reason config changed.
set_entry bld-same "$H0"
export PHP_INI='{"opcache.memory_consumption":"48"}'
u0=$(lines "$UPLOAD_LOG"); a0=$(lines "$APPLY_LOG")
run_update
u1=$(lines "$UPLOAD_LOG"); a1=$(lines "$APPLY_LOG")
ok "PHP_INI change: exit 0" "$([ "$RC" = 0 ] && echo 1 || echo 0)"
ok "PHP_INI change: reason config changed" "$(printf '%s' "$OUT" | grep -Fqx 'site shop: upload build bld-same (was bld-same); reason: config changed' && echo 1 || echo 0)"
ok "PHP_INI change: uploaded" "$([ "$u1" = $((u0 + 1)) ] && [ "$a1" = $((a0 + 1)) ] && echo 1 || echo 0)"
ok "PHP_INI change: no secret in the output" "$(no_secret)"
H1=$(last_hash)
ok "PHP_INI change: the recorded hash differs from the previous one" "$([ -n "$H1" ] && [ "$H1" != "$H0" ] && echo 1 || echo 0)"
[ "$RC" = 0 ] || { echo "$OUT" | sed 's/^/   /'; }

# 4. Same build, same PHP_INI, secret VALUE only: no upload.
set_entry bld-same "$H1"
export SALT=salt-value-CHANGED
u0=$(lines "$UPLOAD_LOG"); a0=$(lines "$APPLY_LOG")
run_update
u1=$(lines "$UPLOAD_LOG"); a1=$(lines "$APPLY_LOG")
ok "secret value only: nothing to do" "$(printf '%s' "$OUT" | grep -Fqx 'site shop: already at build bld-same; nothing to do' && echo 1 || echo 0)"
ok "secret value only: no upload" "$([ "$RC" = 0 ] && [ "$u1" = "$u0" ] && [ "$a1" = "$a0" ] && echo 1 || echo 0)"
ok "secret value only: no secret in the output" "$(no_secret)"
[ "$RC" = 0 ] || { echo "$OUT" | sed 's/^/   /'; }

# 5. Same build, a new secret key: upload.
set_entry bld-same "$H1"
export TURNSTILE_SECRET=turnstile-value-ccc
u0=$(lines "$UPLOAD_LOG")
run_update
u1=$(lines "$UPLOAD_LOG")
ok "new secret key: reason config changed" "$(printf '%s' "$OUT" | grep -Fqx 'site shop: upload build bld-same (was bld-same); reason: config changed' && echo 1 || echo 0)"
ok "new secret key: uploaded" "$([ "$RC" = 0 ] && [ "$u1" = $((u0 + 1)) ] && echo 1 || echo 0)"
ok "new secret key: no secret in the output" "$(no_secret)"
H2=$(last_hash)
ok "new secret key: the hash differs from the value-only hash" "$([ -n "$H2" ] && [ "$H2" != "$H1" ] && echo 1 || echo 0)"
[ "$RC" = 0 ] || { echo "$OUT" | sed 's/^/   /'; }

# 6. FORCE_UPLOAD=1 with the same build and the same config: upload, reason forced.
set_entry bld-same "$H2"
export FORCE_UPLOAD=1
u0=$(lines "$UPLOAD_LOG")
run_update
u1=$(lines "$UPLOAD_LOG")
ok "FORCE_UPLOAD=1: reason forced" "$(printf '%s' "$OUT" | grep -Fqx 'site shop: upload build bld-same (was bld-same); reason: forced' && echo 1 || echo 0)"
ok "FORCE_UPLOAD=1: uploaded" "$([ "$RC" = 0 ] && [ "$u1" = $((u0 + 1)) ] && echo 1 || echo 0)"
ok "FORCE_UPLOAD=1: no secret in the output" "$(no_secret)"
[ "$RC" = 0 ] || { echo "$OUT" | sed 's/^/   /'; }

echo "$fails failing check(s)"
exit "$fails"
