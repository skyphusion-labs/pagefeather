#!/bin/bash
# Test of the phase B scheduled snapshot (#533, option A): a phase B site is served by the shared
# wp-dispatch through its Custom Domain, so it has no per-site dispatcher to carry the cron. It gets
# a CRON-ONLY copy wp-<site>: the same dispatcher script and bindings, with NO route and NO
# workers.dev, so it is never a front door. Offline (a stand-in api).
#   deploy/wfp/tests/phase-b-cron-test.sh [another lib.sh]
# Exits 0 only when every check holds. Needs bash, python3 (tomllib).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=${1:-$HERE/../lib.sh}
WFPD=$(cd "$HERE/.." && pwd)
# shellcheck disable=SC1090
. "$LIB"
PY=""
for p in "${PY_TOML:-}" python3 python3.14 python3.13 python3.12 python3.11; do
	[ -n "$p" ] && command -v "$p" >/dev/null 2>&1 && "$p" -c 'import tomllib' 2>/dev/null && { PY=$p; break; }
done
[ -n "$PY" ] || { echo "FAIL no python3 with tomllib (3.11 or later) on PATH"; exit 1; }
fails=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
unset SNAPSHOT_CRON SNAPSHOT_TIMEOUT_MS

# 1. The render: the cron-only copy is the phase A site copy with workers_dev = false, and no route.
render_site_dispatcher one kv123 > "$T/a.toml" || true
render_site_dispatcher one kv123 cron-only > "$T/b.toml" 2>/dev/null; rc=$?
ok "render_site_dispatcher <site> <kv> cron-only renders (exit 0)" "$([ "$rc" = 0 ] && [ -s "$T/b.toml" ] && echo 1 || echo 0)"
j=$("$PY" -c 'import json, sys, tomllib; c = tomllib.load(open(sys.argv[1], "rb")); print(json.dumps({k: c.get(k) for k in ("name", "workers_dev", "preview_urls", "route", "routes", "triggers", "vars")}, sort_keys=True))' "$T/b.toml" 2>/dev/null)
ok "the cron-only copy: workers_dev = false, preview_urls = false, no route or routes, the daily cron, SNAPSHOT_SCRIPT of its own site" "$(printf '%s' "$j" | "$PY" -c 'import json, sys
try:
    c = json.load(sys.stdin)
except ValueError:
    print(0); sys.exit()
print(1 if c["name"] == "wp-one" and c["workers_dev"] is False and c["preview_urls"] is False and c["route"] is None and c["routes"] is None
      and c["triggers"] == {"crons": ["17 7 * * *"]} and (c["vars"] or {}).get("SNAPSHOT_SCRIPT") == "site-one" else 0)')"
d=$(diff "$T/a.toml" "$T/b.toml" | grep '^[<>]' | grep -v '^> #')
ok "it differs from the phase A copy ONLY in the workers_dev line (and a comment)" "$([ "$(printf '%s\n' "$d" | grep -c .)" = 2 ] && printf '%s\n' "$d" | grep -qx '< workers_dev = true' && printf '%s\n' "$d" | grep -qx '> workers_dev = false' && echo 1 || echo 0)"
ok "a bad mode is refused, nothing printed" "$(out=$(render_site_dispatcher one kv123 public 2>/dev/null); rc=$?; [ "$rc" != 0 ] && [ -z "$out" ] && echo 1 || echo 0)"

# 2. cron_copy_check: the deployed copy reads back with workers.dev OFF and no Custom Domain on it.
CAPI=$T/capi; mkdir -p "$CAPI"
api() { local f; f="$CAPI/$(printf '%s' "$2" | tr '/?=&' '____')"; if [ -f "$f" ]; then cat "$f"; else printf '{"success":false}\n404'; fi; }
setc() { printf '%s\n%s' "$2" "${3:-200}" > "$CAPI/$(printf '%s' "$1" | tr '/?=&' '____')"; }
setc /workers/scripts/wp-one/subdomain '{"success":true,"result":{"enabled":false,"previews_enabled":false}}'
setc /workers/domains '{"success":true,"result":[{"hostname":"one.example.com","service":"wp-dispatch"}]}'
ok "cron_copy_check: workers.dev off and no domain on wp-one: PASS" "$(cron_copy_check wp-one >/dev/null 2>&1 && echo 1 || echo 0)"
setc /workers/scripts/wp-one/subdomain '{"success":true,"result":{"enabled":true,"previews_enabled":false}}'
ok "cron_copy_check: workers.dev ON is refused" "$(cron_copy_check wp-one >/dev/null 2>&1 && echo 0 || echo 1)"
setc /workers/scripts/wp-one/subdomain '{"success":true,"result":{"enabled":false,"previews_enabled":true}}'
ok "cron_copy_check: preview URLs ON is refused" "$(cron_copy_check wp-one >/dev/null 2>&1 && echo 0 || echo 1)"
setc /workers/scripts/wp-one/subdomain '{"success":true,"result":{"enabled":false,"previews_enabled":false}}'
setc /workers/domains '{"success":true,"result":[{"hostname":"one.example.com","service":"wp-one"}]}'
ok "cron_copy_check: a Custom Domain on wp-one is refused" "$(cron_copy_check wp-one >/dev/null 2>&1 && echo 0 || echo 1)"
setc /workers/domains '{"success":false}' 403
ok "cron_copy_check: a domain list it cannot read is refused (never read as none)" "$(cron_copy_check wp-one >/dev/null 2>&1 && echo 0 || echo 1)"
setc /workers/domains '{"success":true,"result":[]}'
setc /workers/scripts/wp-one/subdomain '{"success":false}' 404
ok "cron_copy_check: a subdomain setting it cannot read is refused" "$(cron_copy_check wp-one >/dev/null 2>&1 && echo 0 || echo 1)"

# 3. The phase B footprint has the cron-only copy as a part.
setc /workers/domains '{"success":true,"result":[{"hostname":"one.wfp-test.skyphusion.org","service":"wp-dispatch"}]}'
setc /workers/scripts/wp-one '{"success":true}'
ns_script_state() { echo present; }; search_index_state() { echo gone; }
KV_ID=kv1 SUB=sub
setc /storage/kv/namespaces/kv1/values/one.wfp-test.skyphusion.org '{}'
setc /r2/buckets/wp-wfp-one-media '{}'
fp=$(WFP_CUSTOM_DOMAIN=1 site_footprint one)
ok "phase B footprint names the cron-only copy (cron yes) beside the domain" "$(printf '%s\n' "$fp" | grep -qx 'cron yes' && printf '%s\n' "$fp" | grep -qx 'domain yes' && echo 1 || echo 0)"
ok "  and a full phase B site with it is present" "$(footprint_present "$fp" && echo 1 || echo 0)"
rm -f "$CAPI/_workers_scripts_wp-one"
fp=$(WFP_CUSTOM_DOMAIN=1 site_footprint one)
ok "  a phase B site WITHOUT it is not present (site add must make it)" "$(printf '%s\n' "$fp" | grep -qx 'cron no' && ! footprint_present "$fp" && echo 1 || echo 0)"
ok "  and 'cron no' counts as absent (site remove must leave none)" "$(footprint_absent "$(printf 'cron no\ndomain no\nscript gone\nentry no\nbucket no')" && ! footprint_absent "$(printf 'cron yes\ndomain no\nscript gone\nentry no\nbucket no')" && echo 1 || echo 0)"
unset -f api ns_script_state search_index_state

# 4. The wiring.
up=$(sed -n '/^if \[ "\$cmd" = up \]; then/,/^elif \[ "\$cmd" = down \]; then/p' "$WFPD/site.sh")
b=$(printf '%s\n' "$up" | sed -n '/WFP_CUSTOM_DOMAIN:-0}" = 1 \]; then/,/^  else/p')
ok "site.sh up, phase B: deploys the cron-only copy with its secrets, then cron_copy_check" "$(printf '%s\n' "$b" | grep -q 'render_site_dispatcher "$s" "$KV_ID" cron-only' && printf '%s\n' "$b" | grep -q 'dispatcher_secrets_json' && printf '%s\n' "$b" | grep -q 'cron_copy_check "$D"' && echo 1 || echo 0)"
dn=$(sed -n '/^elif \[ "\$cmd" = down \]; then/,/log "site \$s: user Worker \$U"/p' "$WFPD/site.sh")
ok "site.sh down, phase B: deletes the cron-only copy and reads it back gone (404), a site with none passes" "$(printf '%s\n' "$dn" | grep -q 'gone "cron-only copy $D"' && printf '%s\n' "$dn" | grep -q 'no cron-only copy' && echo 1 || echo 0)"
sch=$(sed -n '/^schedule_one()/,/^}/p' "$WFPD/site")
ok "site schedule: phase B is no longer refused; it renders cron-only and runs cron_copy_check" "$(! printf '%s\n' "$sch" | grep -q 'phase B has no per-site cron' && printf '%s\n' "$sch" | grep -q 'cron-only' && printf '%s\n' "$sch" | grep -q 'cron_copy_check "$D"' && echo 1 || echo 0)"
ok "README: the 250-cron account limit is noted for the per-site crons" "$(grep -q '250' "$WFPD/README.md" && grep -qi 'cron-only' "$WFPD/README.md" && echo 1 || echo 0)"
echo "$fails failing check(s)"
exit $fails
