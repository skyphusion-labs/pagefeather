#!/usr/bin/env bash
# deploy/deploy-url.sh (#754): which workers.dev URL a deploy landed on, and the origin check, against wrangler output
# that ALSO prints a workers.dev URL in its bindings (any var holding one; a tick URL did in #754's proof). Before #754's fix, deploy.sh took the FIRST
# workers.dev URL anywhere in the output, so a tick URL in the vars failed every deploy, after the upload and before the
# secrets, stranding the site. Also checks deploy.sh's order: the origin check runs after the secrets and the redaction.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
# shellcheck source=../deploy-url.sh
. "$ROOT/deploy/deploy-url.sh" 2>/dev/null || { echo "  FAIL deploy/deploy-url.sh is missing"; exit 1; }
DEP='Total Upload: 31337.00 KiB / gzip: 9001.00 KiB
Your Worker has access to the following bindings:
Binding                                                         Resource
env.PHP_RUNTIME (PhpRuntime)                                    Durable Object
env.START_BY_TICK_URL ("https://pf-tick.skyphusion.workers.dev/")  Environment Variable
env.SITE_ORIGIN ("https://pfc-sb714.skyphusion.workers.dev")    Environment Variable
Uploaded pfc-sb714 (12.34 sec)
Deployed pfc-sb714 triggers (0.56 sec)
  https://pfc-sb714.skyphusion.workers.dev
Current Version ID: 4f3e7dab-0000-0000-0000-000000000000'
U=$(deployed_workers_url pfc-sb714 <<<"$DEP")
ok "the trigger line wins over every workers.dev URL in the bindings (got '$U')" "$([ "$U" = https://pfc-sb714.skyphusion.workers.dev ] && echo 1 || echo 0)"
ok "the OLD rule (the first match) would have taken the tick URL: the case is real" "$([ "$(echo "$DEP" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)" = https://pf-tick.skyphusion.workers.dev ] && echo 1 || echo 0)"
U=$(deployed_workers_url other-site <<<"$DEP")
ok "another script name finds no trigger line (got '$U')" "$([ -z "$U" ] && echo 1 || echo 0)"
U=$(deployed_workers_url pfc-sb714 <<<'Uploaded pfc-sb714 (1 sec)
Deployed pfc-sb714 triggers (0.1 sec)
  schedule: */5 * * * *
Current Version ID: x')
ok "no workers.dev trigger (workers_dev off): empty (got '$U')" "$([ -z "$U" ] && echo 1 || echo 0)"
ok "origin_check: a workers.dev origin that matches passes" "$(origin_check https://pfc-sb714.skyphusion.workers.dev https://pfc-sb714.skyphusion.workers.dev 2>/dev/null && echo 1 || echo 0)"
ok "origin_check: a workers.dev origin that does not match fails" "$(origin_check https://pf-tick.skyphusion.workers.dev https://pfc-sb714.skyphusion.workers.dev 2>/dev/null && echo 0 || echo 1)"
ok "origin_check: a custom-domain origin is not a workers.dev check" "$(origin_check '' https://shop.example.com 2>/dev/null && echo 1 || echo 0)"
D="$ROOT/deploy/deploy.sh"
ok "deploy.sh takes the URL from deployed_workers_url, never the first match" "$(grep -q 'URL=$(deployed_workers_url "$NAME" <<<"$DEP")' "$D" && ! grep -q "grep -oE 'https://\[a-z0-9.-\]+\\\\.workers\\\\.dev' | head -1" "$D" && echo 1 || echo 0)"
s=$(grep -n 'secret bulk' "$D" | head -1 | cut -d: -f1); r=$(grep -n '^obs_redact "$NAME"' "$D" | head -1 | cut -d: -f1); c=$(grep -n 'origin_check "$URL" "$SITE_ORIGIN" || exit 1' "$D" | tail -1 | cut -d: -f1)
ok "deploy.sh runs the origin check AFTER the redaction and the secrets (redact $r, secrets $s, check $c)" "$([ -n "$s" ] && [ -n "$r" ] && [ -n "$c" ] && [ "$c" -gt "$s" ] && [ "$c" -gt "$r" ] && echo 1 || echo 0)"
echo "$fails failing case(s)"
[ "$fails" = 0 ]
