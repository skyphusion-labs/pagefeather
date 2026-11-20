#!/bin/bash
# #1039: a media upload rolled back by its request frame must not keep its R2 files. On WordPress in local workerd
# (dosql-local, REQUEST_FRAMES on), through the sql-fail seam (fault-inject.mjs; the throwaway/local measurement rule):
#   1. POST /wp/v2/media whose attachment INSERT fails like a memory reset answers the rolled-back 500, and its file
#      is GONE (404), with no attachment (red before #1039: the file stayed, 200).
#   2. The next upload of the same name gets that name, not name-1 (red before: pf1039-1.png).
#   3. A plain upload keeps its file (nothing is deleted for a request that finished).
#   tests/frame-r2-orphan-e2e.sh   (in spikes/b2-wordpress, after prepare.sh and build.sh; CI: opcache-build.yml's e2e loop)
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8792} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT; ST=(-H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}"); PW=${ADMIN_PASSWORD:-local-spike-password}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/r2-orphan.XXXXXX"); export PERSIST_TO=$STATE/db
# Builds with its own fixture (IMPORT_CONTENT): build/ is saved first and put back EXACTLY on exit, as
# stranded-frame-e2e.sh does (a later CI step works on the primed build an earlier step made).
[ -d build ] || { echo "r2-orphan: no build/ (run build.sh first)"; exit 1; }
cp -a build "$STATE/build.saved" || { echo "r2-orphan: could not save build/"; exit 1; }
trap './run.sh --stop > /dev/null 2>&1; rm -rf build && mv "$STATE/build.saved" build || echo "r2-orphan: build/ was NOT restored"; rm -rf "$STATE"' EXIT
IMPORT_CONTENT="$PWD/tests/fixtures/r2-orphan" IMPORT_MU_PLUGINS=pf1039-app-password.php ./build.sh > /dev/null 2>&1 || { echo "r2-orphan: build with the fixture failed"; exit 1; }
DEV_LOCAL=1 DEV_VARS="FAULT_INJECT:sql-fail REQUEST_FRAMES:on" ./run.sh _ping > /dev/null || { echo "r2-orphan: wrangler dev did not start"; tail -20 dev.log; exit 1; }
curl -sf -m 300 "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "r2-orphan: /_install failed"; exit 1; }
APW=$(curl -s -m 120 "${ST[@]}" "$B/?pf1039=app-password" | python3 -I -c 'import json,sys; print(json.loads(sys.stdin.read())["password"] or "")')
[ -n "$APW" ] || { echo "r2-orphan: no application password"; exit 1; }
python3 -I -c 'import struct,zlib,sys
w,h=400,300; raw=b"".join(b"\x00"+b"\xff\x00\x00"*w for _ in range(h))
c=lambda t,d: struct.pack(">I",len(d))+t+d+struct.pack(">I",zlib.crc32(t+d)&0xffffffff)
sys.stdout.buffer.write(b"\x89PNG\r\n\x1a\n"+c(b"IHDR",struct.pack(">IIBBBBB",w,h,8,2,0,0,0))+c(b"IDAT",zlib.compress(raw))+c(b"IEND",b""))' > "$STATE/img.png"
fails=0
up() { # up <name> [curl args]: prints "status write-loss source_url"
  local n=$1; shift
  local code; code=$(curl -s -m 300 -u "admin:$APW" "${ST[@]}" "$@" -D "$STATE/h" -o "$STATE/b" -w '%{http_code}' -X POST -H "Content-Type: image/png" -H "Content-Disposition: attachment; filename=$n" --data-binary @"$STATE/img.png" "$B/?rest_route=/wp/v2/media")
  local wl; wl=$(awk -F': ' 'tolower($1)=="x-write-loss"{gsub(/\r/,"",$2);print $2}' "$STATE/h")
  local src; src=$(python3 -I -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("source_url") or "-")
except Exception: print("-")' "$STATE/b")
  echo "$code ${wl:--} $src"
}
Y=$(date -u +%Y); M=$(date -u +%m)
read -r c w s < <(up pf1039.png -H 'x-pf-fault: sql-fail' -H 'x-pf-fault-sql: INTO `wp_posts`')
echo "r2-orphan: faulted upload: status $c, x-write-loss $w"
[ "$c" = 500 ] && [ "$w" = rolled-back ] || { echo "r2-orphan: FAIL the faulted upload is not the rolled-back 500"; fails=1; }
f=$(curl -s -m 60 -o /dev/null -w '%{http_code}' "$B/wp-content/uploads/$Y/$M/pf1039.png")
echo "r2-orphan: its file after the rollback: $f"
[ "$f" = 404 ] || { echo "r2-orphan: FAIL the rolled-back upload kept its file"; fails=1; }
read -r c w s < <(up pf1039.png)
echo "r2-orphan: next upload: status $c, $s"
[ "$c" = 201 ] && [ "${s##*/}" = pf1039.png ] || { echo "r2-orphan: FAIL the next upload did not get the name back"; fails=1; }
f=$(curl -s -m 60 -o /dev/null -w '%{http_code}' "$B/wp-content/uploads/$Y/$M/pf1039.png")
echo "r2-orphan: the finished upload keeps its file: $f"
[ "$f" = 200 ] || { echo "r2-orphan: FAIL a finished upload lost its file"; fails=1; }
[ "$fails" = 0 ] || { echo "r2-orphan: FAIL"; exit 1; }
echo "r2-orphan: ok: a rolled-back upload leaves no file and no name behind; a finished one keeps its file"
