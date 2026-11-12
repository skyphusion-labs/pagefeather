#!/bin/bash
# Load the WooCommerce sample store into one deploy/wfp site (Conrad's rule: every WordPress test
# loads it, never an empty site). REPLACES the site's whole database.
#
#   . deploy/wfp/reference.env && WFP_STATE=r2 SAMPLE_STORE=<file.sql.gz> \
#     tests/fixtures/load-sample-store.sh <site>
#
# SAMPLE_STORE is the fixture file (from R2 wp-test-fixtures, key SAMPLE_STORE_KEY in
# sample-store.env). Its sha256 must equal the pin, or nothing is loaded.
# Steps: check the pin -> gunzip into a mode-700 work dir -> deploy/wfp/site import (dump to
# SQLite, site address to this site, per-table count check) -> replace the admin password with
# this site's own Terraform admin_password (WordPress's $wp bcrypt form; the password and the
# token never go in argv) -> read back: a real admin login, the published products through the
# Store API (?rest_route=, which works under any permalink structure), the orders and users through /_dbcounts. Exit 1 on any mismatch.
# The site must be built with WooCommerce primed in its OPcache (WOO_ACTIVE=1, #313), or the
# store exceeds the isolate memory on every request.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
s=${1:?usage: load-sample-store.sh <site>}
# shellcheck disable=SC1091
. "$HERE/sample-store.env"
: "${SAMPLE_STORE:?set SAMPLE_STORE to the fixture file (R2 $SAMPLE_STORE_BUCKET/$SAMPLE_STORE_KEY)}"
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d" " -f1; }
got=$(sha "$SAMPLE_STORE")
[ "$got" = "$SAMPLE_STORE_SHA256" ] || { echo "sample store: sha256 $got is not the pin $SAMPLE_STORE_SHA256; nothing loaded" >&2; exit 1; }
echo "sample store: sha256 matches the pin ($SAMPLE_STORE_BYTES bytes expected, $(wc -c < "$SAMPLE_STORE" | tr -d " ") read)"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sample-store.XXXXXX"); chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
gzip -dc "$SAMPLE_STORE" > "$WORK/store.sql"
tail -c 200 "$WORK/store.sql" | grep -q "Dump completed" || { echo "sample store: the dump has no Dump completed footer; nothing loaded" >&2; exit 1; }
# The admin login, from the dump itself (ID 1).
LOGIN=$(python3 -I "$HERE/sample-store-admin.py" "$WORK/store.sql")
[ -n "$LOGIN" ] || { echo "sample store: no admin (ID 1) row in the dump" >&2; exit 1; }

# import.sh work files (the site data) go inside WORK, so the trap removes them too.
mkdir -m 700 "$WORK/import"
DUMP="$WORK/store.sql" WORK="$WORK/import" "$ROOT/deploy/wfp/site" import "$s"

# shellcheck disable=SC1091
. "$ROOT/deploy/wfp/lib.sh"
tfr site init -input=false >/dev/null; tfr site workspace select "$s" >/dev/null
HOST=$(tfr site output -raw hostname); O="https://$HOST"
tfr site output -raw spike_token > "$WORK/tok"; tfr site output -raw admin_password > "$WORK/pw"
tfr site workspace select default >/dev/null
hdr() { printf 'header = "x-spike-token: %s"\n' "$(cat "$WORK/tok")"; }

# The admin password: this site's own, in WordPress's native form (wp_check_password: "$wp" +
# bcrypt of base64(HMAC-SHA384(password, "wp-sha384"))). Password on stdin, hash in a file.
php -r '$p = rtrim(stream_get_contents(STDIN), "\n"); echo "\$wp" . password_hash(base64_encode(hash_hmac("sha384", $p, "wp-sha384", true)), PASSWORD_BCRYPT);' < "$WORK/pw" > "$WORK/hash"
python3 -I -c 'import json, sys; print(json.dumps({"sql": "UPDATE wp_users SET user_pass = ?, user_activation_key = ? WHERE ID = 1", "params": [open(sys.argv[1]).read(), ""]}))' "$WORK/hash" > "$WORK/pw.ndjson"
r=$(curl -s -m 120 -X POST -K <(hdr) -H 'content-type: application/x-ndjson' --data-binary "@$WORK/pw.ndjson" "$O/_dbimport?append=1")
case "$r" in *'"ok":true'*'"statements":1'*) echo "sample store: admin password replaced (user ID 1, $LOGIN)" ;; *) echo "sample store: the password update failed: ${r:0:200}" >&2; exit 1 ;; esac

fails=0; skipped=0
want() { if [ "$2" = "$3" ]; then echo "  ok   $1: $2"; else echo "  FAIL $1: got $2, want $3" >&2; fails=$((fails + 1)); fi; }
# shellcheck disable=SC1091
. "$HERE/sample-store-login.sh"
admin_login_check "$O" "$LOGIN" "$WORK/pw" "$WORK"
products=$(curl -s -o /dev/null -D - -m 120 "$O/?rest_route=/wc/store/v1/products&per_page=1&nocache=$RANDOM" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-wp-total"{print $2}')
want "published products (Store API x-wp-total)" "${products:-none}" "$SAMPLE_STORE_PRODUCTS"
curl -s -m 120 -K <(hdr) "$O/_dbcounts" > "$WORK/counts.json"
c() { python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["rows"].get(sys.argv[2], "none"))' "$WORK/counts.json" "$1"; }
want "orders (wp_wc_orders)" "$(c wp_wc_orders)" "$SAMPLE_STORE_ORDERS"
want "users (wp_users)" "$(c wp_users)" "$SAMPLE_STORE_USERS"
[ "$fails" = 0 ] || { echo "sample store: $fails check(s) failed on $s" >&2; exit 1; }
if [ "$skipped" = 0 ]; then echo "sample store: loaded into $s ($O), every check passed"
else echo "sample store: loaded into $s ($O), every check that ran passed; $skipped not checked (see skip lines above)"; fi
