#!/bin/bash
# Test of the phase B (#138) custom-domain wiring of deploy/wfp, offline.
#   deploy/wfp/tests/custom-domain-test.sh [another lib.sh]
# - custom_host and site_host: phase A (workers.dev) vs phase B (the Custom
#   Domain), and WFP_SUBDOMAIN.
# - render_shared_dispatcher: the ONE template, named wp-dispatch, binding the
#   site map and the namespace; the per-site render still works (phase A).
# - The site Terraform: the Custom Domain hostname and the site map key are the
#   same expression (var.hostname), so the route and the key cannot drift; the
#   domain attaches to var.dispatcher; the resource is count-gated.
# - terraform validate, when terraform is on PATH (CI has none, so skip there).
# Exits 0 only when every check holds. Needs bash, python3 (tomllib).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=${1:-$HERE/../lib.sh}
SITE_TF="$HERE/../terraform/site/main.tf"
# shellcheck disable=SC1090
. "$LIB"
PY=""
for p in "${PY_TOML:-}" python3 python3.14 python3.13 python3.12 python3.11; do
	[ -n "$p" ] && command -v "$p" >/dev/null 2>&1 && "$p" -c 'import tomllib' 2>/dev/null && { PY=$p; break; }
done
[ -n "$PY" ] || { echo "FAIL no python3 with tomllib (3.11 or later) on PATH"; exit 1; }
fails=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

# custom_host: default subdomain and an override.
eq "custom_host default subdomain" "$(custom_host blog)" "blog.wfp-test.skyphusion.org"
eq "custom_host honours WFP_SUBDOMAIN" "$(WFP_SUBDOMAIN=example.com custom_host blog)" "blog.example.com"

# site_host: phase A keeps the per-site workers.dev dispatcher; phase B is the
# Custom Domain. The flag is the only difference.
eq "site_host phase A (flag unset)" "$(site_host blog sub123)" "wp-blog.sub123.workers.dev"
eq "site_host phase A (flag 0)" "$(WFP_CUSTOM_DOMAIN=0 site_host blog sub123)" "wp-blog.sub123.workers.dev"
eq "site_host phase B (flag 1)" "$(WFP_CUSTOM_DOMAIN=1 site_host blog sub123)" "blog.wfp-test.skyphusion.org"

# site_wait_cap: phase A is short; a phase B first deploy covers the Advanced
# Certificate issuance window; SITE_WAIT overrides either (#138 live finding).
eq "site_wait_cap phase A" "$(site_wait_cap)" "300"
eq "site_wait_cap phase B first deploy" "$(WFP_CUSTOM_DOMAIN=1 site_wait_cap)" "1800"
eq "site_wait_cap SITE_WAIT overrides (phase B)" "$(WFP_CUSTOM_DOMAIN=1 SITE_WAIT=42 site_wait_cap)" "42"

# The shared dispatcher is the ONE template, named wp-dispatch, and still binds
# the site map and the namespace twice. SHARED_DISPATCHER is wp-dispatch.
eq "SHARED_DISPATCHER name" "$SHARED_DISPATCHER" "wp-dispatch"
render_shared_dispatcher kv123 > "$T/shared.toml"
name=$("$PY" -c 'import tomllib,sys; print(tomllib.load(open(sys.argv[1],"rb"))["name"])' "$T/shared.toml")
eq "shared dispatcher name is wp-dispatch" "$name" "wp-dispatch"
binds=$("$PY" -c '
import tomllib, sys
d = tomllib.load(open(sys.argv[1], "rb"))
kv = [n["binding"] for n in d.get("kv_namespaces", [])]
dn = [n["binding"] for n in d.get("dispatch_namespaces", [])]
print("SITES" in kv and dn.count("DISPATCHER") == 1 and dn.count("DISPATCHER_OUT") == 1)' "$T/shared.toml")
ok "shared dispatcher binds SITES, DISPATCHER, DISPATCHER_OUT" "$([ "$binds" = True ] && echo 1 || echo 0)"
noplace=$(grep -c '@SITE@\|@KV_ID@\|@NAMESPACE@\|@COMPAT@' "$T/shared.toml" || true)
ok "shared dispatcher leaves no placeholder" "$([ "$noplace" = 0 ] && echo 1 || echo 0)"

# The per-site dispatcher render still works (phase A is untouched).
render_dispatcher one kv123 > "$T/one.toml"
pa=$("$PY" -c 'import tomllib,sys; print(tomllib.load(open(sys.argv[1],"rb"))["name"])' "$T/one.toml")
eq "phase A per-site dispatcher still wp-<name>" "$pa" "wp-one"

# The Terraform: the Custom Domain hostname and the site map key are the SAME
# expression, so they cannot drift; the domain attaches to var.dispatcher and
# is count-gated by var.custom_domain.
ok "site map entry key is var.hostname" "$(grep -qE 'key_name[[:space:]]*=[[:space:]]*var\.hostname' "$SITE_TF" && echo 1 || echo 0)"
ok "custom domain hostname is var.hostname" "$(grep -qE 'hostname[[:space:]]*=[[:space:]]*var\.hostname' "$SITE_TF" && echo 1 || echo 0)"
ok "custom domain service is var.dispatcher" "$(grep -qE 'service[[:space:]]*=[[:space:]]*var\.dispatcher' "$SITE_TF" && echo 1 || echo 0)"
ok "custom domain is count-gated by var.custom_domain" "$(grep -qE 'count[[:space:]]*=[[:space:]]*var\.custom_domain[[:space:]]*\?[[:space:]]*1[[:space:]]*:[[:space:]]*0' "$SITE_TF" && echo 1 || echo 0)"
ok "custom_domain defaults false (phase A is the default)" "$("$PY" -c '
import re, sys
s = open(sys.argv[1]).read()
m = re.search(r"variable \"custom_domain\"\s*\{[^}]*default\s*=\s*(\w+)", s, re.S)
print(1 if m and m.group(1) == "false" else 0)' "$SITE_TF")"

# up.sh deploys the shared dispatcher in phase B, and down.sh removes it after
# the sites, so a phase B teardown leaves the account clean (no orphan dispatcher).
ok "up.sh deploys the shared dispatcher in phase B" "$(grep -q 'render_shared_dispatcher' "$HERE/../up.sh" && echo 1 || echo 0)"
ok "down.sh removes the shared dispatcher in phase B" "$(grep -qF 'wrangler delete --name "$SHARED_DISPATCHER"' "$HERE/../down.sh" && echo 1 || echo 0)"

# terraform validate, where terraform exists (CI runners have none, so skip).
if command -v terraform >/dev/null 2>&1; then
	if (cd "$HERE/../terraform/site" && terraform validate) >"$T/tf.log" 2>&1; then
		ok "terraform validate (site)" 1
	else
		ok "terraform validate (site)" 0; sed 's/^/    /' "$T/tf.log"
	fi
else
	echo "SKIP terraform validate (no terraform on PATH; run locally)"
fi

[ "$fails" = 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
