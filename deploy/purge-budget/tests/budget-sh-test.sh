#!/usr/bin/env bash
# #699 part B: deploy/purge-budget/budget.sh. A site binds the account purge budget only when it is present, says which
# way it went, and falls back to part A when its presence cannot be read (fail-open). The token never reaches output.
# The binding itself through the real audit: deploy/wfp/tests/bindings-render-test.py.
#   bash deploy/purge-budget/tests/budget-sh-test.sh
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
# yes_if <text> <glob>: 1 when the text matches the glob, else 0 (a function: bash 3.2 cannot parse a case in $( )).
# shellcheck disable=SC2254 # the pattern IS a glob, on purpose
yes_if() { case "$1" in $2) echo 1 ;; *) echo 0 ;; esac; }
T=$(mktemp -d "${TMPDIR:-/tmp}/budget-sh-test.XXXXXX"); trap 'kill "$SRV" 2>/dev/null; rm -rf "$T"' EXIT
TOKEN=planted-token-must-not-print

# A stand-in API: /accounts/acc/workers/scripts/pf-purge-budget/settings answers the code in $T/code, and only to the
# right bearer token (a wrong one is 403, which must read as unknown).
cat > "$T/api.py" <<'PY'
import http.server, sys
code_file, token = sys.argv[1], sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.headers.get("Authorization") != "Bearer " + token: self.send_response(403); self.end_headers(); return
        if self.path != "/client/v4/accounts/acc/workers/scripts/pf-purge-budget/settings": self.send_response(400); self.end_headers(); return
        self.send_response(int(open(code_file).read().strip())); self.end_headers(); self.wfile.write(b"{}")
s = http.server.HTTPServer(("127.0.0.1", 0), H)
print(s.server_port, flush=True)
s.serve_forever()
PY
echo 200 > "$T/code"
python3 -I "$T/api.py" "$T/code" "$TOKEN" > "$T/port" &
SRV=$!
disown "$SRV" 2>/dev/null || true # no job notice when the trap kills it, so the summary stays the last line
for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
API="http://127.0.0.1:$(cat "$T/port")/client/v4"
b() { # b <env...> -- <bash commands>: budget.sh in a clean environment
  local envs=()
  while [ "$1" != -- ]; do envs+=("$1"); shift; done; shift
  env -i PATH="$PATH" PURGE_BUDGET_API="$API" ${envs[@]+"${envs[@]}"} bash -c ". '$ROOT/deploy/purge-budget/budget.sh'; $*"
}

echo "1. purge_budget_present"
echo 200 > "$T/code"; ok "200: yes" "$([ "$(b CLOUDFLARE_API_TOKEN=$TOKEN ACCOUNT_ID=acc -- purge_budget_present)" = yes ] && echo 1 || echo 0)"
echo 404 > "$T/code"; ok "404: no" "$([ "$(b CLOUDFLARE_API_TOKEN=$TOKEN ACCOUNT_ID=acc -- purge_budget_present)" = no ] && echo 1 || echo 0)"
echo 500 > "$T/code"; ok "500: unknown" "$([ "$(b CLOUDFLARE_API_TOKEN=$TOKEN ACCOUNT_ID=acc -- purge_budget_present)" = unknown ] && echo 1 || echo 0)"
echo 200 > "$T/code"; ok "a wrong token (403): unknown" "$([ "$(b CLOUDFLARE_API_TOKEN=wrong ACCOUNT_ID=acc -- purge_budget_present)" = unknown ] && echo 1 || echo 0)"
ok "no token: unknown, and no call" "$([ "$(b ACCOUNT_ID=acc -- purge_budget_present)" = unknown ] && echo 1 || echo 0)"
ok "CLOUDFLARE_ACCOUNT_ID is read too" "$([ "$(b CLOUDFLARE_API_TOKEN=$TOKEN CLOUDFLARE_ACCOUNT_ID=acc -- purge_budget_present)" = yes ] && echo 1 || echo 0)"
o=$(b CLOUDFLARE_API_TOKEN=$TOKEN ACCOUNT_ID=acc -- 'purge_budget_present; purge_budget_decide one' 2>&1)
ok "the token never reaches the output" "$(( 1 - $(yes_if "$o" "*$TOKEN*") ))"

echo "2. purge_budget_decide"
echo 200 > "$T/code"; o=$(b CLOUDFLARE_API_TOKEN=$TOKEN ACCOUNT_ID=acc -- 'purge_budget_decide "site one"; echo "BIND=$PURGE_BUDGET_BIND"' 2>&1)
ok "present: bound, and it says so" "$(yes_if "$o" '*bound to pf-purge-budget*BIND=1*')"
echo 404 > "$T/code"; o=$(b CLOUDFLARE_API_TOKEN=$TOKEN ACCOUNT_ID=acc -- 'purge_budget_decide "site one"; echo "BIND=$PURGE_BUDGET_BIND"' 2>&1)
ok "absent: part A, and it says so" "$(yes_if "$o" '*none on this account*BIND=0*')"
echo 500 > "$T/code"; o=$(b CLOUDFLARE_API_TOKEN=$TOKEN ACCOUNT_ID=acc -- 'purge_budget_decide "site one"; echo "BIND=$PURGE_BUDGET_BIND"' 2>&1)
ok "unreadable: fail-open to part A, loudly" "$(yes_if "$o" '*could NOT be read*BIND=0*')"
echo 200 > "$T/code"; o=$(b CLOUDFLARE_API_TOKEN=$TOKEN ACCOUNT_ID=acc PURGE_BUDGET_BIND=0 -- 'purge_budget_decide "site one"; echo "BIND=$PURGE_BUDGET_BIND"' 2>&1)
ok "the caller's PURGE_BUDGET_BIND=0 wins over a present budget" "$(yes_if "$o" '*set by the caller*BIND=0*')"

echo "3. the lines"
ok "unset: no lines" "$([ -z "$(b -- purge_budget_toml_lines)" ] && echo 1 || echo 0)"
ok "unset: no suffix" "$([ -z "$(b -- purge_budget_toml_suffix)" ] && echo 1 || echo 0)"
want=$'[[durable_objects.bindings]]\nname = "PURGE_BUDGET"\nclass_name = "PurgeBudget"\nscript_name = "pf-purge-budget"'
ok "bound: exactly the four lines" "$([ "$(b PURGE_BUDGET_BIND=1 -- purge_budget_toml_lines)" = "$want" ] && echo 1 || echo 0)"
ok "bound: the suffix is the same lines after a newline" "$([ "$(b PURGE_BUDGET_BIND=1 -- 'printf x; purge_budget_toml_suffix')" = "x"$'\n'"$want" ] && echo 1 || echo 0)"

echo "4. deploy.sh (render_conf, b-dosql)"
APP="$ROOT/spikes/b2-wordpress"
COMPAT=$(sed -n 's/^compatibility_date = "\(.*\)"/\1/p' "$APP/wrangler.toml" | head -1)
rc_() {
  # shellcheck disable=SC2016
  env -i PATH="$PATH" HOME="$T" ROOT="$ROOT" APP="$APP" COMPAT="$COMPAT" NAME=pf-render VARIANT=b-dosql LOCATION=wnam \
    SITE_ORIGIN=https://pf-render.example.workers.dev BUCKET=MEDIA_BUCKET AI=0 "$@" bash -c '
      set -e
      . "$ROOT/deploy/a-settings.sh"; . "$ROOT/deploy/observability.sh"; . "$ROOT/deploy/render-conf.sh"
      out() { echo "STUB_$1"; }
      cd "$APP" && render_conf' 2> "$T/rc.err"
}
plain=$(rc_); bound=$(rc_ PURGE_BUDGET_BIND=1)
ok "unbound: no budget binding" "$(( 1 - $(yes_if "$plain" '*PURGE_BUDGET*') ))"
ok "bound: the budget binding, after PHP_RUNTIME and before the migrations" "$(printf '%s\n' "$bound" | python3 -I -c 'import sys
t=sys.stdin.read(); a=t.find("name = \"PHP_RUNTIME\""); b=t.find("name = \"PURGE_BUDGET\""); m=t.find("[[migrations]]")
print(1 if 0 < a < b < m and "script_name = \"pf-purge-budget\"" in t[b:m] else 0)')"
ok "bound and unbound differ by exactly the four lines" "$([ "$(diff <(printf '%s\n' "$plain") <(printf '%s\n' "$bound") | grep -c '^>')" = 4 ] && echo 1 || echo 0)"

echo "$fails failing case(s)"
[ "$fails" = 0 ]
