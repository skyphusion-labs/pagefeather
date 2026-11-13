#!/bin/bash
# Load the Theme Unit Test fixture into one plain deploy/wfp site (Gate 2 tier 1, #422). REPLACES
# the site's whole database and adds the fixture's media to its bucket.
#
#   . deploy/wfp/reference.env && WFP_STATE=r2 THEME_UNIT_SQLITE=<file.sqlite.gz> \
#     THEME_UNIT_CONTENT=<file.wp-content.tar.gz> tests/fixtures/load-theme-unit.sh <site>
#
# The two files come from the private fixtures bucket (tests/fixtures/theme-unit.env). Both must
# match their SHA-256 pins, or nothing is loaded. Then: deploy/wfp/site import (SQLITE= and
# CONTENT=), replace the admin password with this site's own Terraform admin_password (the
# password and the token never go on a command line), and read back the five pinned counts:
# posts and pages in every status but trash and auto-draft, media, comments and users.
# Modelled on load-sample-store.sh.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
s=${1:?usage: load-theme-unit.sh <site>}
# shellcheck disable=SC1091
. "$HERE/theme-unit.env"
: "${THEME_UNIT_SQLITE:?set THEME_UNIT_SQLITE to the fixture database (R2 $THEME_UNIT_BUCKET/$THEME_UNIT_SQLITE_KEY)}"
: "${THEME_UNIT_CONTENT:?set THEME_UNIT_CONTENT to the fixture media (R2 $THEME_UNIT_BUCKET/$THEME_UNIT_CONTENT_KEY)}"
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d" " -f1; }
for pair in "THEME_UNIT_SQLITE:$THEME_UNIT_SQLITE_SHA256" "THEME_UNIT_CONTENT:$THEME_UNIT_CONTENT_SHA256"; do
  var=${pair%%:*}; pin=${pair#*:}; f=${!var}
  got=$(sha "$f")
  [ "$got" = "$pin" ] || { echo "theme unit: $var sha256 $got is not the pin $pin; nothing loaded" >&2; exit 1; }
done
echo "theme unit: both files match their pins"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/theme-unit.XXXXXX"); chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
gzip -dc "$THEME_UNIT_SQLITE" > "$WORK/theme-unit.sqlite"
# The admin login is user ID 1 of the fixture (admin).
LOGIN=admin

mkdir -m 700 "$WORK/import"
SQLITE="$WORK/theme-unit.sqlite" CONTENT="$THEME_UNIT_CONTENT" WORK="$WORK/import" "$ROOT/deploy/wfp/site" import "$s"

# shellcheck disable=SC1091
. "$ROOT/deploy/wfp/lib.sh"
tfr site init -input=false >/dev/null; tfr site workspace select "$s" >/dev/null
HOST=$(tfr site output -raw hostname); O="https://$HOST"
tfr site output -raw spike_token > "$WORK/tok"; tfr site output -raw admin_password > "$WORK/pw"
tfr site workspace select default >/dev/null
hdr() { printf 'header = "x-spike-token: %s"\n' "$(cat "$WORK/tok")"; }

# The admin password: this site's own, in WordPress's native form (as load-sample-store.sh does).
php -r '$p = rtrim(stream_get_contents(STDIN), "\n"); echo "\$wp" . password_hash(base64_encode(hash_hmac("sha384", $p, "wp-sha384", true)), PASSWORD_BCRYPT);' < "$WORK/pw" > "$WORK/hash"
python3 -I -c 'import json, sys; print(json.dumps({"sql": "UPDATE wp_users SET user_pass = ?, user_activation_key = ? WHERE ID = 1", "params": [open(sys.argv[1]).read(), ""]}))' "$WORK/hash" > "$WORK/pw.ndjson"
r=$(curl -s -m 120 -X POST -K <(hdr) -H 'content-type: application/x-ndjson' --data-binary "@$WORK/pw.ndjson" "$O/_dbimport?append=1")
case "$r" in *'"ok":true'*'"statements":1'*) echo "theme unit: admin password replaced (user ID 1, $LOGIN)" ;; *) echo "theme unit: the password update failed: ${r:0:200}" >&2; exit 1 ;; esac

fails=0; skipped=0
want() { if [ "$2" = "$3" ]; then echo "  ok   $1: $2"; else echo "  FAIL $1: got $2, want $3" >&2; fails=$((fails + 1)); fi; }
# shellcheck disable=SC1091
. "$HERE/sample-store-login.sh"
admin_login_check "$O" "$LOGIN" "$WORK/pw" "$WORK"
# Posts, pages and media through REST as the admin (the gate's test token if the site shows one).
token=""; [ "$(login_gate "$WORK/login.page")" = test ] && token=$TS_DUMMY_TOKEN
python3 -I "$HERE/theme-unit-counts.py" "$O" "$LOGIN" "$WORK/pw" "$token" > "$WORK/rest-counts.json"
rc() { python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], "none"))' "$WORK/rest-counts.json" "$1"; }
want "posts (every status but trash and auto-draft)" "$(rc posts)" "$THEME_UNIT_POSTS"
want "pages (every status but trash and auto-draft)" "$(rc pages)" "$THEME_UNIT_PAGES"
want "media" "$(rc media)" "$THEME_UNIT_ATTACHMENTS"
curl -s -m 120 -K <(hdr) "$O/_dbcounts" > "$WORK/counts.json"
c() { python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["rows"].get(sys.argv[2], "none"))' "$WORK/counts.json" "$1"; }
want "comments (wp_comments)" "$(c wp_comments)" "$THEME_UNIT_COMMENTS"
want "users (wp_users)" "$(c wp_users)" "$THEME_UNIT_USERS"
[ "$fails" = 0 ] || { echo "theme unit: $fails check(s) failed on $s" >&2; exit 1; }
if [ "$skipped" = 0 ]; then echo "theme unit: loaded into $s ($O), every check passed"
else echo "theme unit: loaded into $s ($O), every check that ran passed; $skipped not checked (see skip lines above)"; fi
