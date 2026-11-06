#!/bin/bash
# Why does opcache.sh fail for ENGINE=a with WOO=0 PLUGINS=...? (issue #50)
# Does exactly what deploy/deploy.sh does to prime OPcache for variant a (a
# temporary local MariaDB, wrangler dev with DEV_ENV=a-local), but keeps every
# output: the home page body and its links BEFORE e2e.sh runs, then
# opcache.sh's full output (deploy.sh shows only its last line).
#
#   ./tests/a2/opcache-diag.sh "contact-form-7 classic-editor"   # WOO=0, as plugin-suite.sh
#   WOO=1 ./tests/a2/opcache-diag.sh ""                          # the control: the restore build
#
# Needs Docker. Uses PORT (default 8811, not 8797/8798) and the container
# a2-opcache-diag (removed at the end). Output: build/opcache-diag/.
set -uo pipefail
cd "$(dirname "$0")/../../spikes/b2-wordpress" || exit 1
export PLUGINS=${1:-}
export WOO=${WOO:-0}
export PORT=${PORT:-8811}
O=build/opcache-diag
C=a2-opcache-diag
echo "== build: ENGINE=a WOO=$WOO PLUGINS=$PLUGINS"
# build.sh removes build/wordpress, build/public and build/site.zip, not build/opcache-diag.
mkdir -p "$O"
ENGINE=a ./build.sh > "$O/build.log" 2>&1 || { tail -20 "$O/build.log"; exit 1; }
tail -1 "$O/build.log"
LP=$(openssl rand -hex 16)
docker rm -f "$C" >/dev/null 2>&1 || true
trap 'docker rm -f "$C" >/dev/null 2>&1 || true; pkill -f "wrangler dev --port $PORT" 2>/dev/null || true' EXIT
docker run -d --name "$C" -p 127.0.0.1:3399:3306 -e MARIADB_ROOT_PASSWORD="$LP" -e MARIADB_DATABASE=wordpress -e MARIADB_USER=wp -e MARIADB_PASSWORD="$LP" mariadb:11.4 >/dev/null
for _ in $(seq 1 30); do docker exec "$C" mariadb -uwp -p"$LP" -e 'select 1' wordpress >/dev/null 2>&1 && break; sleep 2; done
export WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="mysql://wp:$LP@127.0.0.1:3399/wordpress"
export DEV_ENV=a-local
B=http://localhost:$PORT

echo "== the home page before e2e.sh (as opcache.sh lines 11 and 12 make it)"
./run.sh _ping > "$O/run.txt" 2>&1; cat "$O/run.txt"
curl -s -X POST "$B/_install" > "$O/install.json"; echo "install: $(head -c 200 "$O/install.json")"
curl -s -D "$O/home.headers" -o "$O/home.html" "$B/"
echo "GET / : $(head -1 "$O/home.headers" | tr -d '\r')  $(wc -c < "$O/home.html") bytes"
echo "links in it (href and src), first 15:"
grep -o -E '(href|src)="[^"]*"' "$O/home.html" | sort | uniq -c | sort -rn | head -15
echo "does it contain \"$B/\"? $(grep -c "$B/" "$O/home.html") lines (e2e.sh line 27 needs at least 1)"
echo "home and siteurl in the database:"
docker exec "$C" mariadb -uwp -p"$LP" wordpress -e "SELECT option_name, option_value FROM wp_options WHERE option_name IN ('home','siteurl','active_plugins','template','stylesheet')" 2>&1
pkill -f "wrangler dev --port $PORT" 2>/dev/null || true
cp dev.log "$O/dev-before.log" 2>/dev/null || true

echo "== opcache.sh, full output (a fresh database, as in deploy.sh)"
docker exec "$C" mariadb -uroot -p"$LP" -e "DROP DATABASE wordpress; CREATE DATABASE wordpress CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; GRANT ALL ON wordpress.* TO 'wp'@'%';" 2>&1
./opcache.sh > "$O/opcache.out" 2>&1; rc=$?
cat "$O/opcache.out"
echo "opcache.sh exit $rc"
cp build/opcache-e2e.log "$O/" 2>/dev/null || true
cp dev.log "$O/dev-opcache.log" 2>/dev/null || true
echo "files: $(ls "$O" | tr '\n' ' ')"
