#!/bin/bash
# Test of the scheduled snapshot wiring of deploy/wfp (#533), offline: the site dispatcher render
# (cron, SNAPSHOT_SCRIPT, timeout), the secrets of both scripts, and the deploy paths that use them.
#   deploy/wfp/tests/snapshot-wiring-test.sh [another lib.sh]
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
toml() { "$PY" -c 'import json, sys, tomllib; c = tomllib.load(open(sys.argv[1], "rb")); print(json.dumps({"vars": c.get("vars"), "triggers": c.get("triggers"), "name": c["name"], "ns": c["dispatch_namespaces"], "kv": c["kv_namespaces"]}, sort_keys=True))' "$1"; }

render_site_dispatcher one kv123 > "$T/one.toml"
render_site_dispatcher two kv123 > "$T/two.toml"
render_dispatcher one kv123 > "$T/plain.toml"
d=$(diff "$T/one.toml" "$T/two.toml" | grep '^[<>]')
ok "two sites' copies differ in exactly the name and SNAPSHOT_SCRIPT, both from the site name" "$([ "$(printf '%s\n' "$d" | grep -c .)" = 4 ] && [ "$(printf '%s\n' "$d" | grep -cvE '^[<>] (name = "wp-(one|two)"|SNAPSHOT_SCRIPT = "site-(one|two)")$')" = 0 ] && echo 1 || echo 0)"
ok "the site copy is the plain template plus the snapshot block (the template part is unchanged)" "$([ "$(head -n "$(wc -l < "$T/plain.toml")" "$T/one.toml" | cmp - "$T/plain.toml" >/dev/null && echo y)" = y ] && echo 1 || echo 0)"
j=$(toml "$T/one.toml")
ok "it parses: SNAPSHOT_SCRIPT site-one, timeout 60000, the cron 17 7 * * *, the same bindings" "$(printf '%s' "$j" | "$PY" -c 'import json, sys
j = json.load(sys.stdin)
good = (j["vars"] == {"SNAPSHOT_SCRIPT": "site-one", "SNAPSHOT_TIMEOUT_MS": "60000"} and j["triggers"] == {"crons": ["17 7 * * *"]}
        and [n["binding"] for n in j["ns"]] == ["DISPATCHER", "DISPATCHER_OUT"] and j["kv"] == [{"binding": "SITES", "id": "kv123"}])
print(1 if good else 0)')"
ok "no secret value in the rendered config (only the NAME of the script)" "$(grep -ciE 'token|secret' "$T/one.toml" | grep -qx 0 && echo 1 || echo 0)"
pj=$(toml "$T/plain.toml")
ok "the plain copy (the stale-entry probe, the attacker probes) has no cron and no SNAPSHOT_ vars" "$(printf '%s' "$pj" | "$PY" -c 'import json, sys; j = json.load(sys.stdin); print(1 if j["vars"] is None and j["triggers"] is None else 0)')"
render_shared_dispatcher kv123 > "$T/shared.toml"
ok "the phase B shared dispatcher has no cron (phase A only)" "$(grep -qE '^\[triggers\]|SNAPSHOT_' "$T/shared.toml" && echo 0 || echo 1)"
SNAPSHOT_CRON=off render_site_dispatcher one kv123 > "$T/off.toml"
ok "SNAPSHOT_CRON=off: an empty cron list (it removes the cron)" "$(toml "$T/off.toml" | "$PY" -c 'import json, sys; print(1 if json.load(sys.stdin)["triggers"] == {"crons": []} else 0)')"
SNAPSHOT_CRON='5 3 * * 1-5' SNAPSHOT_TIMEOUT_MS=120000 render_site_dispatcher one kv123 > "$T/c.toml"
ok "SNAPSHOT_CRON and SNAPSHOT_TIMEOUT_MS are rendered as given" "$(toml "$T/c.toml" | "$PY" -c 'import json, sys; j = json.load(sys.stdin); print(1 if j["triggers"] == {"crons": ["5 3 * * 1-5"]} and j["vars"]["SNAPSHOT_TIMEOUT_MS"] == "120000" else 0)')"
for bad in 'bad' '* * * *' '1 2 3 4 5 6' '1 2 3 4 5"' '*/5 * * * * ; x'; do
	ok "SNAPSHOT_CRON='$bad' fails the render, and nothing is printed" "$(out=$(SNAPSHOT_CRON=$bad render_site_dispatcher one kv123 2>/dev/null); rc=$?; [ "$rc" != 0 ] && [ -z "$out" ] && echo 1 || echo 0)"
done
for bad in 0 840001 abc -1 1.5 '60000 '; do
	ok "SNAPSHOT_TIMEOUT_MS='$bad' fails the render" "$(SNAPSHOT_TIMEOUT_MS=$bad render_site_dispatcher one kv123 >/dev/null 2>&1 && echo 0 || echo 1)"
done

# The secrets: the user Worker gets SNAPSHOT_TOKEN once the workspace has it; the dispatcher copy
# gets ONLY it.
tf_old='{"wp_salt":{"value":"salt-1"},"spike_token":{"value":"tok-1"}}'
tf_new='{"wp_salt":{"value":"salt-1"},"spike_token":{"value":"tok-1"},"snapshot_token":{"value":"snap-1"}}'
printf '%s' "$tf_new" | env -u TURNSTILE_SECRET bash -c ". \"$LIB\"; site_secrets_json \"$T/u.json\"" > "$T/u.out"
ok "site_secrets_json with a snapshot_token: WP_SALT, SPIKE_TOKEN and SNAPSHOT_TOKEN" "$(python3 -I -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])) == {"WP_SALT":"salt-1","SPIKE_TOKEN":"tok-1","SNAPSHOT_TOKEN":"snap-1"} else 1)' "$T/u.json" && echo 1 || echo 0)"
printf '%s' "$tf_old" | env -u TURNSTILE_SECRET bash -c ". \"$LIB\"; site_secrets_json \"$T/u0.json\""
ok "site_secrets_json before the workspace has one: no SNAPSHOT_TOKEN (an update applies it first)" "$(python3 -I -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])) == {"WP_SALT":"salt-1","SPIKE_TOKEN":"tok-1"} else 1)' "$T/u0.json" && echo 1 || echo 0)"
printf '%s' "$tf_new" | bash -c ". \"$LIB\"; dispatcher_secrets_json \"$T/d.json\"" > "$T/d.out"
ok "dispatcher_secrets_json: exactly SNAPSHOT_TOKEN (never the salt or the spike token)" "$(python3 -I -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])) == {"SNAPSHOT_TOKEN":"snap-1"} else 1)' "$T/d.json" && echo 1 || echo 0)"
mode=$(stat -c '%a' "$T/d.json" 2>/dev/null || stat -f '%Lp' "$T/d.json")
ok "the dispatcher secrets file is mode 600 (got $mode), and nothing was printed" "$([ "$mode" = 600 ] && [ ! -s "$T/d.out" ] && [ ! -s "$T/u.out" ] && echo 1 || echo 0)"
printf '%s' "$tf_old" | bash -c ". \"$LIB\"; dispatcher_secrets_json \"$T/d0.json\"" >/dev/null 2>&1; rc=$?
ok "dispatcher_secrets_json with no snapshot_token: fails, writes no file" "$([ "$rc" != 0 ] && [ ! -e "$T/d0.json" ] && echo 1 || echo 0)"

# ns_secret_names reads names only, and fails on a body it cannot read.
got=$(api() { printf '%s\n200' '{"success":true,"result":[{"name":"WP_SALT","type":"secret_text"},{"name":"SNAPSHOT_TOKEN","type":"secret_text"}]}'; }; ns_secret_names site-one)
ok "ns_secret_names: the names, one a line" "$([ "$got" = $'WP_SALT\nSNAPSHOT_TOKEN' ] && echo 1 || echo 0)"
(api() { printf '%s\n403' '{"success":false,"errors":[{"code":10000}]}'; }; ns_secret_names site-one >/dev/null 2>&1); rc=$?
ok "ns_secret_names on a refusal: fails (never an empty list that reads as no secret)" "$([ "$rc" != 0 ] && echo 1 || echo 0)"

# #533/#540: a site named auto would put its rollback snapshots (_snapshots/<site>/) under the
# expiring _snapshots/auto/. It is refused by valid_site and by the terraform name validation.
ok "valid_site refuses auto; it takes autos and auto1 (only the exact name collides)" "$(! valid_site auto && valid_site autos && valid_site auto1 && echo 1 || echo 0)"
ok "terraform/site refuses the name auto" "$(grep -q 'contains(\["probe", "auto"\], var.name)' "$WFPD/terraform/site/main.tf" && echo 1 || echo 0)"

# The deploy paths.
ok "site.sh up deploys the SITE copy (render_site_dispatcher) with the dispatcher secrets" "$(grep -q 'render_site_dispatcher "$s" "$KV_ID" > "$GEN/$D.toml"' "$WFPD/site.sh" && grep -q 'dispatcher_secrets_json "$W/disp-secrets.json"' "$WFPD/site.sh" && grep -q -- '--secrets-file "$W/disp-secrets.json"' "$WFPD/site.sh" && echo 1 || echo 0)"
ok "site.sh up no longer deploys a site with the plain copy" "$(grep -q 'render_dispatcher "$s"' "$WFPD/site.sh" && echo 0 || echo 1)"
ok "cross.sh (the attacker probes) keeps the plain copy: no cron" "$(grep -q 'render_dispatcher "$name"' "$WFPD/cross.sh" && ! grep -q render_site_dispatcher "$WFPD/cross.sh" && echo 1 || echo 0)"
ok "site schedule renders phase B cron-only, and refuses a workspace with no token and a user Worker without SNAPSHOT_TOKEN" "$(sed -n '/^schedule_one()/,/^}/p' "$WFPD/site" > "$T/sched.sh"; grep -q 'REC_CD" = true' "$T/sched.sh" && grep -q 'output -raw snapshot_token' "$T/sched.sh" && grep -q 'grep -qx SNAPSHOT_TOKEN' "$T/sched.sh" && grep -q '"$got" = "$want"' "$T/sched.sh" && echo 1 || echo 0)"
ok "site update applies the workspace once when it has no snapshot token, before the secrets are read" "$(u=$(sed -n '/^update_one_inner()/,/^}/p' "$WFPD/site"); a=$(printf '%s\n' "$u" | grep -n 'if ! tfr site output -raw snapshot_token' | cut -d: -f1); b=$(printf '%s\n' "$u" | grep -n 'site_secrets_json "$W/sec.json"' | head -1 | cut -d: -f1); [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ] && echo 1 || echo 0)"
ok "terraform: snapshot_token is a random_password and a sensitive output" "$(m="$WFPD/terraform/site/main.tf"; grep -q 'resource "random_password" "snapshot_token"' "$m" && sed -n '/^output "snapshot_token"/,/^}/p' "$m" | grep -q 'sensitive = true' && echo 1 || echo 0)"
echo "$fails failing check(s)"
exit $fails
