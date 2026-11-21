#!/bin/bash
# #1284: after the sample-store load replaces the database, the site's uploads are cleared
# and nothing else is. The pinned fixture ships no media files, so the upload object count
# must read back 0. Offline, against deploy/wfp/tests/fake-s3.py. No account and no live site.
#   tests/fixtures/tests/clear-uploads-test.sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd); FX=$(cd "$HERE/.." && pwd); ROOT=$(cd "$FX/../.." && pwd)
CLEAR=$FX/clear-uploads.sh
COUNT=$FX/attachment-count.py
LOADER=$FX/load-sample-store.sh
fails=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }

T=$(mktemp -d "${TMPDIR:-/tmp}/clear-uploads-test.XXXXXX")
pf=$T/port
python3 -I "$ROOT/deploy/wfp/tests/fake-s3.py" "$pf" >/dev/null 2>&1 &
spid=$!
trap 'kill "$spid" 2>/dev/null || true; wait "$spid" 2>/dev/null || true; rm -rf "$T"' EXIT
i=0
while [ "$i" -lt 50 ] && [ ! -s "$pf" ]; do i=$((i + 1)); sleep 0.05; done
[ -s "$pf" ] || { echo "FAIL fake-s3 did not start"; exit 1; }
EP="http://127.0.0.1:$(cat "$pf")"

mkdir -p "$T/bin"
cat > "$T/bin/curl" <<'EOF'
#!/bin/bash
printf '%s\n' "$*" >> "$CURL_LOG"
exec /usr/bin/curl "$@"
EOF
chmod +x "$T/bin/curl"
export PATH="$T/bin:$PATH" CURL_LOG=$T/curl.log
export R2_KEY_ID=test-key R2_SECRET=test-secret
: > "$CURL_LOG"

put() { python3 -I -c 'import sys, urllib.request; urllib.request.urlopen(urllib.request.Request(sys.argv[1], data=sys.argv[2].encode(), method="PUT"))' "$1" "$2"; }
keylist() { python3 -I -c 'import sys, urllib.request; sys.stdout.write(urllib.request.urlopen(sys.argv[1] + "/_keys").read().decode())' "$EP"; }

# Refusals. The destructive entry point must say no before any request.
refuse() {
  : > "$CURL_LOG"
  rc=0
  "$CLEAR" "$1" "$EP" "$2" "$3" >"$T/out" 2>"$T/err" || rc=$?
  check "$4" "$rc:$(cat "$T/err"):$(wc -c < "$CURL_LOG" | tr -d ' ')" "2:refused: $5:0"
  rc=0
}

if [ -x "$CLEAR" ]; then
  refuse alpha wp-wfp-beta-media uploads/ "refuses another site's bucket (beta's uploads prefix)" "another site's prefix"
  refuse alpha wp-wfp-alpha-media "wp-wfp-beta-media/uploads/" "refuses a prefix that names another site" "another site's prefix"
  refuse alpha wp-wfp-alpha-media "" "refuses an empty prefix" "empty prefix"
  refuse alpha wp-wfp-alpha-media "/" "refuses a root prefix" "root prefix"
  refuse alpha wp-wfp-alpha-media "." "refuses a dot prefix (the bucket root)" "root prefix"
  refuse alpha wp-wfp-alpha-media "_snapshots/" "refuses a prefix that is not uploads/" "not this site's uploads prefix"
  refuse alpha wp-wfp-alpha-media "uploads" "refuses uploads without the trailing slash" "not this site's uploads prefix"
else
  check "clear-uploads.sh exists and is executable" "missing" "present"
fi

# This site's uploads go. The rest of its bucket, and the other site, stay.
put "$EP/wp-wfp-alpha-media/uploads/2026/11/image-01.jpg" "old-1"
put "$EP/wp-wfp-alpha-media/uploads/2026/11/image-02.png" "old-2"
put "$EP/wp-wfp-alpha-media/_snapshots/alpha/keep.ndjson" "snap"
put "$EP/wp-wfp-alpha-media/_build/inputs.json" "build"
put "$EP/wp-wfp-beta-media/uploads/2026/11/keep.jpg" "beta"
: > "$CURL_LOG"
rc=0
"$CLEAR" alpha "$EP" wp-wfp-alpha-media uploads/ >"$T/clear.out" 2>"$T/clear.err" || rc=$?
check "clear exits 0" "$rc" 0
check "  it names the count before any delete" "$(grep -c '^uploads: will delete 2 object(s) under uploads/ in wp-wfp-alpha-media$' "$T/clear.out")" 1
check "  it lists image-01.jpg and image-02.png" "$(grep -c '^uploads/2026/11/image-0[12]\.\(jpg\|png\)$' "$T/clear.out")" 2
# The list is printed before the delete line, and the read-back is after.
order=$(python3 -I -c '
import sys
t = open(sys.argv[1]).read()
a, b, c = t.find("uploads/2026/11/image-01.jpg"), t.find("uploads: deleted 2"), t.find("uploads: read back 0")
print(1 if 0 <= a < b < c else 0)
' "$T/clear.out")
check "  list, then delete count, then read-back 0" "$order" 1
check "  read-back is 0" "$(grep -c '^uploads: read back 0$' "$T/clear.out")" 1
left=$(keylist)
check "  alpha uploads are gone" "$(printf '%s' "$left" | grep -c 'wp-wfp-alpha-media/uploads/')" 0
check "  alpha snapshots and build inputs stay" "$(printf '%s' "$left" | grep -c 'wp-wfp-alpha-media/_snapshots/alpha/keep.ndjson\|wp-wfp-alpha-media/_build/inputs.json')" 2
check "  beta uploads stay" "$(printf '%s' "$left" | grep -c 'wp-wfp-beta-media/uploads/2026/11/keep.jpg')" 1
dels=$(grep -- '-X DELETE' "$CURL_LOG" || true)
check "  every delete is an exact key under this site's uploads/" "$(printf '%s\n' "$dels" | grep -c .):$(printf '%s\n' "$dels" | grep -vc 'wp-wfp-alpha-media/uploads/2026/11/image-0')" "2:0"
check "  no delete carries a prefix wildcard" "$(printf '%s\n' "$dels" | grep -c 'prefix=' || true)" 0
check "  the clear does not call r2-empty.sh" "$(grep -vE '^[[:space:]]*#' "$CLEAR" | grep -c 'r2-empty' || true)" 0

# A later upload of image-01.jpg keeps that name: the old object is gone, so nothing forces a -1 suffix.
put "$EP/wp-wfp-alpha-media/uploads/2026/11/image-01.jpg" "new"
left=$(keylist)
check "follow-up image-01.jpg keeps its key" "$(printf '%s' "$left" | grep -c '/uploads/2026/11/image-01.jpg$')" 1
check "  no image-01-1.jpg was required" "$(printf '%s' "$left" | grep -c 'image-01-1.jpg')" 0

# More than one list page. Five keys, two per page. All five go. The snapshot stays.
for n in 1 2 3 4 5; do put "$EP/wp-wfp-page-media/uploads/2026/11/p$n.jpg" "p$n"; done
put "$EP/wp-wfp-page-media/_snapshots/page/keep.ndjson" "snap"
: > "$CURL_LOG"
rc=0
CLEAR_PAGE_KEYS=2 "$CLEAR" page "$EP" wp-wfp-page-media uploads/ >"$T/page.out" 2>"$T/page.err" || rc=$?
check "a paged list still clears every upload (exit 0, read back 0)" "$rc:$(grep -c '^uploads: read back 0$' "$T/page.out" || true):$(grep -c '^uploads: will delete 5 object(s)' "$T/page.out" || true)" "0:1:1"
left=$(keylist)
check "  the five page uploads are gone and the snapshot stays" "$(printf '%s' "$left" | grep -c 'wp-wfp-page-media/uploads/'):$(printf '%s' "$left" | grep -c 'wp-wfp-page-media/_snapshots/page/keep.ndjson')" "0:1"
check "  five exact deletes, none with a prefix query" "$(grep -c -- '-X DELETE' "$CURL_LOG"):$(grep -- '-X DELETE' "$CURL_LOG" | grep -c 'prefix=' || true)" "5:0"

# An empty uploads prefix is already consistent.
rc=0
"$CLEAR" empty "$EP" wp-wfp-empty-media uploads/ >"$T/empty.out" 2>"$T/empty.err" || rc=$?
check "an empty uploads prefix reads back 0" "$rc:$(grep -c '^uploads: will delete 0 object(s) under uploads/ in wp-wfp-empty-media$' "$T/empty.out" || true):$(grep -c '^uploads: read back 0$' "$T/empty.out" || true)" "0:1:1"

# Keys that could escape the prefix are refused by the vet, with no delete.
vet() { printf '%s\n' "$1" | python3 -I "$FX/uploads-prefix.py" vet; }
vrc=0
vet "uploads/../_build/inputs.json" >"$T/vet.out" 2>"$T/vet.err" || vrc=$?
check "a key with .. is refused" "$vrc:$(cat "$T/vet.err")" "2:refused: unsafe key"
vrc=0
vet "uploads/2026/11/image-01.jpg" >"$T/vet.ok" 2>"$T/vet.ok.err" || vrc=$?
check "a normal uploads key passes the vet" "$vrc:$(cat "$T/vet.ok")" "0:uploads/2026/11/image-01.jpg"

# Attachment rows in the dump. The object count wanted after a clear is 0, because this fixture ships no files.
cat > "$T/dump.sql" <<'SQL'
CREATE TABLE `wp_posts` (
  `ID` bigint unsigned NOT NULL,
  `post_content` longtext NOT NULL,
  `post_title` text NOT NULL,
  `post_type` varchar(20) NOT NULL DEFAULT 'post',
  `post_mime_type` varchar(100) NOT NULL DEFAULT '',
  PRIMARY KEY (`ID`)
) ENGINE=InnoDB;
INSERT INTO `wp_posts` VALUES (1,'a paragraph that says attachment, with a comma','Hello','post',''),(2,'<img src="https://old.example/wp-content/uploads/2026/11/image-01.jpg">','One','attachment','image/jpeg'),(3,'second file','Two','attachment','image/png');
SQL
got=$(python3 -I "$COUNT" "$T/dump.sql" 2>"$T/count.err" || true)
check "the dump's attachment count ignores the word attachment inside post content" "$got" 2
check "no media files means the upload object count must be 0" "$(python3 -I "$FX/uploads-prefix.py" wanted 0 2)" 0
check "shipped media files means the upload object count must equal the attachment rows" "$(python3 -I "$FX/uploads-prefix.py" wanted 1 2)" 2

# The loader calls the clear only after the pin check and the database replace.
order=$(python3 -I -c '
import sys
lines = open(sys.argv[1]).read().splitlines()
def find(fragment):
    for i, line in enumerate(lines):
        if fragment in line and not line.strip().startswith("#"):
            return i
    return -1
sha, imp, clr = find("nothing loaded"), find("import \"$s\""), find("clear-uploads.sh")
print("1" if sha >= 0 and imp > sha and clr > imp else "0")
' "$LOADER")
check "the loader clears only after the pin guard and the database import" "$order" 1
check "the loader says the fixture ships no media files" "$(grep -c 'ships no media files' "$LOADER")" 1

printf 'not the fixture' | gzip -c > "$T/bad.sql.gz"
cat > "$T/clear-rec" <<'EOF'
#!/bin/bash
echo CALLED >> "$CLEAR_LOG"
exit 0
EOF
chmod +x "$T/clear-rec"
: > "$T/called.log"
rc=0
CLEAR_LOG=$T/called.log CLEAR_UPLOADS=$T/clear-rec SAMPLE_STORE=$T/bad.sql.gz "$LOADER" alpha >"$T/bad.out" 2>&1 || rc=$?
check "a file that is not the pin loads nothing (exit 1)" "$rc:$(grep -c 'nothing loaded' "$T/bad.out" || true)" "1:1"
check "  and does not clear uploads" "$(wc -c < "$T/called.log" | tr -d ' ')" 0

echo "clear-uploads-test: $fails failing"
exit $((fails > 0))
