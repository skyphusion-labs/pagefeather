#!/bin/bash
# deploy/zone owner guard (issue #282): apply.sh and destroy.sh read the cache
# phase before they PUT it, and refuse when another root's rules are there.
# A fake curl on PATH answers the entrypoint GET from a fixture and logs every
# call, so each case can assert that a refusal changed NOTHING. No network.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ZONE=$(cd "$HERE/.." && pwd)
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
mkdir -p "$W/bin"
cat > "$W/bin/curl" <<'FAKE'
#!/bin/bash
# Fake curl: -X METHOD ... URL. Logs "METHOD PATH", answers like the real API with
# the body, then "\n<code>" (the scripts pass -w '\n%{http_code}').
m=GET; url=
while [ $# -gt 0 ]; do
  case "$1" in
    -X) m=$2; shift 2 ;;
    -K|-H|-m|-w|--data) shift 2 ;;
    -s) shift ;;
    https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
path=${url#https://api.cloudflare.com/client/v4}
echo "$m $path" >> "$FAKE_LOG"
case "$m $path" in
  "GET /zones/"*"/rulesets/phases/http_request_cache_settings/entrypoint")
    cat "$FAKE_ENTRY_BODY"; printf '\n%s' "$FAKE_ENTRY_CODE" ;;
  "GET /accounts/"*"/workers/domains") printf '{"result":[]}\n200' ;;
  *) printf '{"success":true,"result":{}}\n200' ;;
esac
FAKE
chmod +x "$W/bin/curl"

fails=0
ok() { if [ "$2" = 1 ]; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
rules() { # rules <description>...: an entrypoint body with those rule descriptions
  python3 -I -c 'import json,sys; print(json.dumps({"success":True,"result":{"id":"x","rules":[{"id":"r%d"%i,"description":d} for i,d in enumerate(sys.argv[1:])]}}))' "$@"
}
ours() { python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["rules"][int(sys.argv[2])]["description"])' "$ZONE/$1" "$2"; }

run() { # run <script> <entry code> <entry body> [env...]: exit code in $rc, calls in $W/log
  local script=$1 code=$2 body=$3; shift 3
  : > "$W/log"; printf '%s' "$body" > "$W/entry"
  env -i PATH="$W/bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin" HOME="$W" \
    FAKE_LOG="$W/log" FAKE_ENTRY_BODY="$W/entry" FAKE_ENTRY_CODE="$code" \
    CLOUDFLARE_API_TOKEN=t ACCOUNT_ID=a ZONE_ID=z HOSTNAME=shop.example.com WORKER_SERVICE=w "$@" \
    bash "$ZONE/$script" > "$W/out" 2>&1
  rc=$?
}
puts() { grep -c '^PUT /zones/z/rulesets/phases/http_request_cache_settings/entrypoint' "$W/log" || true; }
changes() { grep -cE '^(PUT|DELETE|POST|PATCH) ' "$W/log" || true; }

GGC='Bypass cache for storefront HTML and any other non-static path'

run apply.sh 404 '{"success":false}'
ok "apply: no entrypoint yet -> the cache ruleset is PUT" "$([ "$rc" = 0 ] && [ "$(puts)" = 1 ] && echo 1)"

run apply.sh 200 "$(rules)"
ok "apply: an empty phase -> PUT" "$([ "$rc" = 0 ] && [ "$(puts)" = 1 ] && echo 1)"

run apply.sh 200 "$(rules "$(ours cache-ruleset.json 0)" "$(ours cache-ruleset.json 1)")"
ok "apply: only this package's rules -> PUT (a re-run converges)" "$([ "$rc" = 0 ] && [ "$(puts)" = 1 ] && echo 1)"

run apply.sh 200 "$(rules "$(ours cache-ruleset.multitenant.json 0)" "$(ours cache-ruleset.multitenant.json 1)")" MODE=multitenant CACHE_EXPR='(ends_with(http.host, ".example.com"))'
ok "apply multitenant: only this package's rules -> PUT" "$([ "$rc" = 0 ] && [ "$(puts)" = 1 ] && echo 1)"

run apply.sh 200 "$(rules "$GGC")"
ok "apply: another root's rule -> exit 3, and NOTHING changed (no domain, no PUT)" "$([ "$rc" = 3 ] && [ "$(changes)" = 0 ] && echo 1)"
ok "apply: the refusal names the rule it found" "$(grep -qF "$GGC" "$W/out" && echo 1)"

run apply.sh 200 "$(rules "$(ours cache-ruleset.json 0)" "$GGC")"
ok "apply: ours mixed with a foreign rule -> exit 3, nothing changed" "$([ "$rc" = 3 ] && [ "$(changes)" = 0 ] && echo 1)"

run apply.sh 200 "$(rules "$GGC")" FORCE=1
ok "apply: FORCE=1 overrides, and says so" "$([ "$rc" = 0 ] && [ "$(puts)" = 1 ] && grep -q 'FORCE=1, overwriting' "$W/out" && echo 1)"

run apply.sh 500 '{"success":false}'
ok "apply: the owner cannot be read (500) -> exit 1, nothing changed" "$([ "$rc" = 1 ] && [ "$(changes)" = 0 ] && echo 1)"

run apply.sh 200 'not json'
ok "apply: an unreadable answer -> exit 1, nothing changed" "$([ "$rc" = 1 ] && [ "$(changes)" = 0 ] && echo 1)"

run destroy.sh 200 "$(rules "$GGC")"
ok "destroy: another root's rule -> exit 3, nothing changed (no domain delete, no clear)" "$([ "$rc" = 3 ] && [ "$(changes)" = 0 ] && echo 1)"

run destroy.sh 200 "$(rules "$(ours cache-ruleset.json 0)" "$(ours cache-ruleset.json 1)")"
ok "destroy: only this package's rules -> the phase is cleared" "$([ "$rc" = 0 ] && [ "$(puts)" = 1 ] && echo 1)"

# CONTROL: the log sees a PUT when there is one, so "0 changes" above is a real zero.
ok "CONTROL: the fake logs the apply PUT it answered" "$(run apply.sh 404 '{}'; grep -q '^PUT /zones/z/rulesets' "$W/log" && echo 1)"

echo "$fails failing case(s)"
[ "$fails" = 0 ]
