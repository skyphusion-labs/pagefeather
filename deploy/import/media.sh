#!/bin/bash
# Put the uploads of an existing site into the site's R2 media bucket (issue #31).
#
#   R2_KEY_ID=... R2_SECRET=... media.sh <endpoint> <bucket> <wp-content dir>
#   media.sh --list <wp-content dir>        the files and keys, no network
#
# A file wp-content/uploads/<path> goes to the key uploads/<path>: the key that
# the Worker serves at /wp-content/uploads/<path> (index.js serveUpload) and
# that php/r2-uploads.php writes. The content type comes from the file name.
#
# Not sent: PHP files, .htaccess and other dot files (the Worker never runs or
# serves them), and a path whose key is longer than 1,024 bytes (R2's limit).
# --list counts them.
#
# Resumable: a key that exists with the same size is not sent again. The
# second run is the check: it must report 0 sent and 0 failed.
# JOBS (default 8) requests at a time. The key goes to curl in a config file on
# a pipe, not in the arguments, so it is not in ps. A new key can take some
# seconds to work: 401 and 403 are tried again for up to 90 s.
set -euo pipefail
# list <dir> [nul]: key, path, type, size. Tab and newline, or NUL after each field.
list() { python3 -I - "$1" "${2:-}" <<'PY'
import mimetypes, os, sys, urllib.parse
nul = sys.argv[2] == "nul"
root = os.path.join(sys.argv[1], "uploads")
skipped = {"php": 0, "dot": 0, "long": 0}
if os.path.isdir(root):
    for d, dirs, files in os.walk(root):
        dirs[:] = sorted(x for x in dirs if not x.startswith("."))
        for f in sorted(files):
            p = os.path.join(d, f)
            if not os.path.isfile(p) or os.path.islink(p):
                continue
            rel = os.path.relpath(p, root).replace(os.sep, "/")
            if f.startswith("."):
                skipped["dot"] += 1
                continue
            if f.lower().endswith((".php", ".phtml", ".phar")):
                skipped["php"] += 1
                continue
            key = "uploads/" + rel
            if len(key.encode()) > 1024:
                skipped["long"] += 1
                continue
            ctype = mimetypes.guess_type(f)[0] or "application/octet-stream"
            row = (urllib.parse.quote(key, safe="/"), p, ctype, str(os.path.getsize(p)))
            sys.stdout.write("".join(x + "\0" for x in row) if nul else "\t".join(row) + "\n")
print(f"# skipped php={skipped['php']} dot={skipped['dot']} long={skipped['long']}", file=sys.stderr)
PY
}
if [ "${1:-}" = --list ]; then list "${2:?wp-content dir}"; exit 0; fi

EP=${1:?endpoint} B=${2:?bucket} SRC=${3:?wp-content dir}
: "${R2_KEY_ID:?set R2_KEY_ID}" "${R2_SECRET:?set R2_SECRET}"
export R2_KEY_ID R2_SECRET EP B
W=$(mktemp -d "${TMPDIR:-/tmp}/wp-media.XXXXXX"); trap 'rm -rf "${W:?}"' EXIT
list "$SRC" nul > "$W/list" 2> "$W/skipped"
n=$(( $(tr -cd '\0' < "$W/list" | wc -c) / 4 ))
echo "media: $n files to check ($(tr -d '#' < "$W/skipped" | xargs))"

s3() { curl -sS -K <(printf 'user = "%s:%s"\n' "$R2_KEY_ID" "$R2_SECRET") --aws-sigv4 "aws:amz:auto:s3" "$@"; }
tries=0
while :; do
  code=$(s3 -o /dev/null -w '%{http_code}' "$EP/$B?list-type=2&max-keys=1")
  case "$code" in
    200) break ;;
    401|403) tries=$((tries + 1)); [ "$tries" -le 18 ] || { echo "media: $B refused ($code)" >&2; exit 1; }; sleep 5 ;;
    *) echo "media: $B list failed ($code)" >&2; exit 1 ;;
  esac
done

# One file: HEAD, then PUT if it is missing or has another size.
one() {
  local key=$1 path=$2 ctype=$3 size=$4 have code
  s3() { curl -sS -K <(printf 'user = "%s:%s"\n' "$R2_KEY_ID" "$R2_SECRET") --aws-sigv4 "aws:amz:auto:s3" "$@"; }
  have=$(s3 -I -o /dev/null -w '%{http_code} %header{content-length}' "$EP/$B/$key" || echo "000 -")
  if [ "$have" = "200 $size" ]; then echo skip; return; fi
  code=$(s3 -o /dev/null -w '%{http_code}' -X PUT -H "content-type: $ctype" -T "$path" "$EP/$B/$key" || echo 000)
  case "$code" in 200) echo sent ;; *) echo "fail $code $key" ;; esac
}
export -f one
xargs -0 -n 4 -P "${JOBS:-8}" bash -c 'one "$@"' _ < "$W/list" > "$W/out"
sent=$(grep -c '^sent' "$W/out" || true); skip=$(grep -c '^skip' "$W/out" || true); failed=$(grep -c '^fail' "$W/out" || true)
echo "media: $sent sent, $skip already there, $failed failed"
[ "$failed" = 0 ] || { grep '^fail' "$W/out" | head -10 >&2; exit 1; }
