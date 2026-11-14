#!/bin/bash
# Put the uploads of an existing site into the site's R2 media bucket (issue #31).
#
#   R2_KEY_ID=... R2_SECRET=... media.sh <endpoint> <bucket> <wp-content dir>
#   R2_CRED_FILE=<file> [R2_CRED_REFRESH=<command>] media.sh <endpoint> <bucket> <wp-content dir>
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
# Per file (issue #124): only a HEAD of 404 (or 200 with another size) means
# "send it". A HEAD that is refused or fails (401, 403, a curl error, 5xx) is
# tried again for R2_RETRY_S (90) s, then the file FAILS with the code: it
# never counts as missing, or the check run would send files it could not
# see. A PUT of 401 or 403 is tried again in the same way. With R2_CRED_REFRESH, the first refusal
# of a streak also mints a fresh credential (a temporary credential expires, deploy/wfp #273).
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
# The key (#273): R2_KEY_ID and R2_SECRET (with R2_SESSION_TOKEN for a temporary credential), or
# R2_CRED_FILE, a file of those three lines that R2_CRED_REFRESH rewrites with a fresh credential.
# Every request reads the file again, so a refresh reaches every request after it. The session
# token goes into the curl config on a pipe, as the key does, never into the arguments.
# shellcheck disable=SC1090 # the file r2_temp.py writes: three shell-quoted assignments
r2_cfg() { ( if [ -n "${R2_CRED_FILE:-}" ]; then . "$R2_CRED_FILE"; fi
  printf 'user = "%s:%s"\n' "$R2_KEY_ID" "$R2_SECRET"
  if [ -n "${R2_SESSION_TOKEN:-}" ]; then printf 'header = "x-amz-security-token: %s"\n' "$R2_SESSION_TOKEN"; fi ); }
r2_key_set() { if [ -n "${R2_CRED_FILE:-}" ]; then [ -r "$R2_CRED_FILE" ]; else [ -n "${R2_KEY_ID:-}" ] && [ -n "${R2_SECRET:-}" ]; fi; }
# r2_refresh: on a refusal, mint a fresh credential with R2_CRED_REFRESH (a temporary one may have
# expired). One at a time, and not again within R2_REFRESH_MIN_S (20) s of the last one, so parallel
# requests that are all refused mint once. No R2_CRED_REFRESH: nothing.
# #545: the lock is a kernel lock (fcntl.flock on <file>.flock, held by one python3 for the whole
# check and mint). The old mkdir lock did NOT exclude on the CI runner (measured, run 43582183877:
# 105 overlaps in 159 entries; flock 0 in 320), and two jobs minted at once (run 43581599616). A refusal WAITS for a mint in progress,
# then sees it. "The last one" is the later of the credential file's mtime (a mint writes it) and
# the mtime of <file>.minted, which is written inside the lock BEFORE the mint runs, so a mint that fails still
# counts and every job does not retry it at once. The caller removes <file>.flock and .minted.
r2_refresh() {
  [ -n "${R2_CRED_REFRESH:-}" ] && [ -n "${R2_CRED_FILE:-}" ] || return 0
  python3 -I -c 'import fcntl, os, subprocess, sys, time
f, min_s, cmd = sys.argv[1], float(sys.argv[2]), sys.argv[3]
fd = os.open(f + ".flock", os.O_RDWR | os.O_CREAT, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
last = 0.0
for p in (f, f + ".minted"):
    try:
        last = max(last, os.path.getmtime(p))
    except OSError:
        pass
if time.time() - last < min_s:
    sys.exit(0)
tmp = "%s.minted.%d" % (f, os.getpid())
with open(tmp, "w") as m:
    m.write("a mint started here; its mtime is the time\n")
os.replace(tmp, f + ".minted")
print("r2: refused at %s: minting a fresh credential" % time.strftime("%H:%M:%SZ", time.gmtime()), file=sys.stderr, flush=True)
rc = subprocess.call(["bash", "-c", cmd], stdout=sys.stderr)
if rc:
    print("r2: the fresh credential was NOT minted", file=sys.stderr)
sys.exit(0)' "$R2_CRED_FILE" "${R2_REFRESH_MIN_S:-20}" "$R2_CRED_REFRESH" >&2 || echo "r2: the credential refresh did not run" >&2
}
r2_key_set || { echo "set R2_KEY_ID and R2_SECRET, or R2_CRED_FILE" >&2; exit 2; }
export R2_KEY_ID="${R2_KEY_ID:-}" R2_SECRET="${R2_SECRET:-}" R2_SESSION_TOKEN="${R2_SESSION_TOKEN:-}" R2_CRED_FILE="${R2_CRED_FILE:-}" R2_CRED_REFRESH="${R2_CRED_REFRESH:-}" EP B
export -f r2_cfg r2_refresh
W=$(mktemp -d "${TMPDIR:-/tmp}/wp-media.XXXXXX"); trap 'rm -rf "${W:?}"' EXIT
list "$SRC" nul > "$W/list" 2> "$W/skipped"
n=$(( $(tr -cd '\0' < "$W/list" | wc -c) / 4 ))
echo "media: $n files to check ($(tr -d '#' < "$W/skipped" | xargs))"

s3() { curl -sS -K <(r2_cfg) --aws-sigv4 "aws:amz:auto:s3" "$@"; }
tries=0
while :; do
  code=$(s3 -o /dev/null -w '%{http_code}' "$EP/$B?list-type=2&max-keys=1")
  case "$code" in
    200) break ;;
    401|403) tries=$((tries + 1)); [ "$tries" -le 18 ] || { echo "media: $B refused ($code)" >&2; exit 1; }; [ "$tries" = 1 ] && r2_refresh; sleep 5 ;;
    *) echo "media: $B list failed ($code)" >&2; exit 1 ;;
  esac
done

# One file: HEAD, then PUT if it is missing (404) or has another size.
one() {
  local key=$1 path=$2 ctype=$3 size=$4 have hc code t0=$SECONDS refreshed=""
  s3() { curl -sS -K <(r2_cfg) --aws-sigv4 "aws:amz:auto:s3" "$@"; }
  while :; do
    have=$(s3 -I -o /dev/null -w '%{http_code} %header{content-length}' "$EP/$B/$key" 2>/dev/null) || have="000 -"
    hc=${have%% *}
    case "$hc" in
      200) [ "$have" = "200 $size" ] && { echo skip; return; }; break ;;
      404) break ;;
      *) [ $((SECONDS - t0)) -lt "${R2_RETRY_S:-90}" ] || { echo "fail head $hc $key"; return; }
         case "$hc" in 401|403) [ -n "$refreshed" ] || { r2_refresh; refreshed=1; } ;; esac; sleep "${R2_RETRY_STEP:-3}" ;;
    esac
  done
  t0=$SECONDS
  while :; do
    code=$(s3 -o /dev/null -w '%{http_code}' -X PUT -H "content-type: $ctype" -T "$path" "$EP/$B/$key" 2>/dev/null) || code=000
    case "$code" in
      200) echo sent; return ;;
      401|403) [ $((SECONDS - t0)) -lt "${R2_RETRY_S:-90}" ] || { echo "fail put $code $key"; return; }
         [ -n "$refreshed" ] || { r2_refresh; refreshed=1; }; sleep "${R2_RETRY_STEP:-3}" ;;
      # #545: no answer (000: curl could not connect or got no reply), 429 and 5xx are transient, as
      # the HEAD above already treats them. A PUT of the same key and body is safe to send again.
      # Before, a PUT that got 000 failed at once, and a run under load dropped files.
      000|429|500|502|503|504) [ $((SECONDS - t0)) -lt "${R2_RETRY_S:-90}" ] || { echo "fail put $code $key"; return; }
         sleep "${R2_RETRY_STEP:-3}" ;;
      *) echo "fail put $code $key"; return ;;
    esac
  done
}
export -f one
xargs -0 -n 4 -P "${JOBS:-8}" bash -c 'one "$@"' _ < "$W/list" > "$W/out"
sent=$(grep -c '^sent' "$W/out" || true); skip=$(grep -c '^skip' "$W/out" || true); failed=$(grep -c '^fail' "$W/out" || true)
echo "media: $sent sent, $skip already there, $failed failed"
[ "$failed" = 0 ] || { grep '^fail' "$W/out" | head -10 >&2; exit 1; }
