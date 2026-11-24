#!/bin/bash
# Load the WooCommerce sample store into one site (Conrad's rule: every WordPress test
# loads it, never an empty site). REPLACES the site's whole database.
#
#   . deploy/wfp/reference.env && WFP_STATE=r2 SAMPLE_STORE=<file.sql.gz> \
#     tests/fixtures/load-sample-store.sh <site>
#
# SAMPLE_STORE is the fixture file (from R2 wp-test-fixtures, key SAMPLE_STORE_KEY in
# sample-store.env). Its sha256 must equal the pin, or nothing is loaded.
# The pin is 2,609 published products and 900 orders (SAMPLE_STORE_PRODUCTS /
# SAMPLE_STORE_ORDERS). That is the full catalog seed for prealpha Type A testing
# (ggc.sh as the approach A example).
#
# Steps: check the pin -> gunzip into a mode-700 work dir -> deploy/wfp/site import
# (b-dosql: dump to SQLite; kind a / VARIANT=a: Hyperdrive /_sqlimport) -> clear this
# site's uploads (the fixture is the dump only, so the bucket must not keep the
# previous store's files) -> replace the admin password with this site's own
# Terraform admin_password (WordPress's $wp bcrypt form; the password and the
# token never go in argv; b-dosql: /_dbimport; kind a: one narrow /_sqlimport
# UPDATE on the site users table) -> read back: upload objects are 0, a real
# admin login, the published products through the Store API (?rest_route=, which
# works under any permalink structure), the orders and users (b-dosql:
# /_dbcounts; kind a: /_sqlimport?counts=1). Exit 1 on any mismatch. A failed
# password replace stops the load; the dump admin password must not remain.
# The clear lists uploads/ in this site's own bucket (wp-wfp-<site>-media), prints the count,
# deletes each key, and reads the count back. It does not touch _snapshots/ or _build/, and it
# does not run unless the pin matched and the import replaced the database.
# An operator then uploads image-01.jpg (the WooCommerce conformance image, or any file of
# that name). WordPress must store it as image-01.jpg. A stored name image-01-1.jpg means an
# object of the original name was still in the bucket.
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
KIND=$(tfr site output -raw kind 2>/dev/null || echo b-dosql)
case "$KIND" in a|b-dosql) ;; *) KIND=b-dosql ;; esac
tfr site output -raw spike_token > "$WORK/tok"; tfr site output -raw admin_password > "$WORK/pw"
# The pin matched and the import replaced the database. The fixture ships no media
# files, so drop uploads/ in this site's own bucket. A wrong prefix is refused
# before any request (clear-uploads.sh).
EP=$(tfr site output -raw r2_endpoint)
B=$(media_bucket "$s")
ttl=${R2_TEMP_TTL:-21600}
cf=$WORK/r2.cred
r2_temp_mint "$B" "$ttl" "$cf" || { rm -f "$cf"; echo "sample store: no temporary credential for $B; uploads were not cleared" >&2; exit 1; }
R2_CRED_FILE=$cf R2_CRED_REFRESH="$(r2_temp_refresh_cmd "$B" "$ttl" "$cf")" \
  "${CLEAR_UPLOADS:-$HERE/clear-uploads.sh}" "$s" "$EP" "$B" "uploads/" \
  || { rm -f "$cf" "$cf.flock" "$cf.minted"; echo "sample store: uploads were not cleared on $s; the database was already replaced" >&2; exit 1; }
rm -f "$cf" "$cf.flock" "$cf.minted"
natt=$(python3 -I "$HERE/attachment-count.py" "$WORK/store.sql")
echo "sample store: dump attachment rows: $natt; the fixture ships no media files, so the upload object count must be 0"
tfr site workspace select default >/dev/null
hdr() { printf 'header = "x-spike-token: %s"\n' "$(cat "$WORK/tok")"; }

fails=0
want() { if [ "$2" = "$3" ]; then echo "  ok   $1: $2"; else echo "  FAIL $1: got $2, want $3" >&2; fails=$((fails + 1)); fi; }

# The admin password: this site's own, in WordPress's native form (wp_check_password: "$wp" +
# bcrypt of base64(HMAC-SHA384(password, "wp-sha384"))). Password on stdin, hash in a file.
php -r '$p = rtrim(stream_get_contents(STDIN), "\n"); echo "\$wp" . password_hash(base64_encode(hash_hmac("sha384", $p, "wp-sha384", true)), PASSWORD_BCRYPT);' < "$WORK/pw" > "$WORK/hash"
if [ "$KIND" = a ]; then
  PREFIX=$(curl -s -m 60 -K <(hdr) "$O/_sqlimport?info=1" | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("prefix") or "")')
  [ -n "$PREFIX" ] || { echo "sample store: kind a site did not report its table prefix (/_sqlimport?info=1); dump admin password left; stopping" >&2; exit 1; }
  python3 -I -c "
import json, re, sys
prefix, path = sys.argv[1], sys.argv[2]
if not re.fullmatch(r'[A-Za-z0-9_]{1,40}', prefix):
    raise SystemExit('sample store: bad table prefix from /_sqlimport?info=1; dump admin password left; stopping')
h = open(path).read()
if '\\\\' in h or '\\x00' in h:
    raise SystemExit('sample store: password hash has a backslash or NUL; dump admin password left; stopping')
lit = h.replace(chr(39), chr(39) * 2)
sql = 'UPDATE \`%susers\` SET \`user_pass\` = \'%s\', \`user_activation_key\` = \'\' WHERE \`ID\` = 1' % (prefix, lit)
print(json.dumps({'sql': sql}))
" "$PREFIX" "$WORK/hash" > "$WORK/pw.ndjson"
  r=$(curl -s -m 120 -X POST -K <(hdr) -H 'content-type: application/x-ndjson' --data-binary "@$WORK/pw.ndjson" "$O/_sqlimport")
  case "$r" in *'"ok":true'*'"statements":1'*) echo "sample store: admin password replaced (kind a /_sqlimport, user ID 1, $LOGIN)" ;; *) echo "sample store: kind a password update failed (dump admin password may remain): ${r:0:200}" >&2; exit 1 ;; esac
else
  python3 -I -c 'import json, sys; print(json.dumps({"sql": "UPDATE wp_users SET user_pass = ?, user_activation_key = ? WHERE ID = 1", "params": [open(sys.argv[1]).read(), ""]}))' "$WORK/hash" > "$WORK/pw.ndjson"
  r=$(curl -s -m 120 -X POST -K <(hdr) -H 'content-type: application/x-ndjson' --data-binary "@$WORK/pw.ndjson" "$O/_dbimport?append=1")
  case "$r" in *'"ok":true'*'"statements":1'*) echo "sample store: admin password replaced (user ID 1, $LOGIN)" ;; *) echo "sample store: the password update failed: ${r:0:200}" >&2; exit 1 ;; esac
fi
# shellcheck disable=SC1091
. "$HERE/sample-store-login.sh"
admin_login_check "$O" "$LOGIN" "$WORK/pw" "$WORK"

products=$(curl -s -o /dev/null -D - -m 120 "$O/?rest_route=/wc/store/v1/products&per_page=1&nocache=$RANDOM" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-wp-total"{print $2}')
want "published products (Store API x-wp-total)" "${products:-none}" "$SAMPLE_STORE_PRODUCTS"

if [ "$KIND" = a ]; then
  curl -s -m 120 -K <(hdr) "$O/_sqlimport?counts=1" > "$WORK/counts.json"
  : "${PREFIX:?}"
  c() { python3 -I -c 'import json, sys; t=json.load(open(sys.argv[1])).get("tables") or {}; print((t.get(sys.argv[2]) or {}).get("rows", "none"))' "$WORK/counts.json" "$1"; }
  want "orders (${PREFIX}wc_orders)" "$(c "${PREFIX}wc_orders")" "$SAMPLE_STORE_ORDERS"
  want "users (${PREFIX}users)" "$(c "${PREFIX}users")" "$SAMPLE_STORE_USERS"
else
  curl -s -m 120 -K <(hdr) "$O/_dbcounts" > "$WORK/counts.json"
  c() { python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["rows"].get(sys.argv[2], "none"))' "$WORK/counts.json" "$1"; }
  want "orders (wp_wc_orders)" "$(c wp_wc_orders)" "$SAMPLE_STORE_ORDERS"
  want "users (wp_users)" "$(c wp_users)" "$SAMPLE_STORE_USERS"
fi
[ "$fails" = 0 ] || { echo "sample store: $fails check(s) failed on $s" >&2; exit 1; }
echo "sample store: loaded into $s ($O), every check passed"
