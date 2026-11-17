#!/bin/bash
# #805: the Durable Object's SQLite caps a LIKE pattern at 50 bytes (measured: 50 pass, 51 fail, "LIKE or GLOB pattern
# too complex"). A LIKE over the cap that is not '%literal%' failed, and WordPress answered an EMPTY result: a plausible
# wrong answer. The plugin-shaped case: get_users() with a 56-character search and NO '*' builds an exact
# `user_login LIKE 'login'`, and the user who exists came back found 0. d1-dialect rewrites it since #805.
#   tests/like-cap-e2e.sh   (in spikes/b2-wordpress, after prepare.sh; it runs build.sh itself, twice)
# It builds WITH the test fixture tests/fixtures/like-cap/mu-plugins/pf805-get-users.php (a mu-plugin that runs
# get_users() for a spike-token request), installs, and asks for the 56-character login three ways: exact (no '*'),
# prefix ('login*') and both sides ('*login*'). Each must find the user, with no database error. On exit it builds
# again WITHOUT the fixture, so the tree is left as a plain build. Not in CI's e2e loop: CI builds once, and the fixture
# must never be in that build. Run it by hand, and in #805's edge proof.
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8797} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT; ST=(-H "x-spike-token: ${SPIKE_TOKEN:-local-spike-token}"); PW=${ADMIN_PASSWORD:-local-spike-password}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/like-cap.XXXXXX"); export PERSIST_TO=$STATE
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE"; ./build.sh > /dev/null 2>&1' EXIT
IMPORT_CONTENT="$PWD/tests/fixtures/like-cap" IMPORT_MU_PLUGINS=pf805-get-users.php ./build.sh > /dev/null 2>&1 || { echo "like-cap: build with the fixture failed"; exit 1; }
DEV_LOCAL=1 ./run.sh _ping > /dev/null || { echo "like-cap: wrangler dev did not start"; tail -20 dev.log; exit 1; }
curl -sf "${ST[@]}" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "like-cap: /_install failed"; exit 1; }
LOGIN="pf805-$(python3 -c "print('x' * 50)")"
fails=0
for shape in exact prefix both; do
  out=$(curl -s "${ST[@]}" -G --data-urlencode "pf805_users=$LOGIN" --data-urlencode "shape=$shape" --data-urlencode "nocache=$RANDOM" "$B/")
  read -r found err < <(python3 -I -c 'import json,sys
try:
    d = json.loads(sys.stdin.read())
    e = d.get("error") or ""
    print(d.get("found"), "too-complex" if "too complex" in e else ("none" if not e.strip() else "other"))
except ValueError:
    print("x not-json")' <<<"$out")
  echo "like-cap: get_users() $shape search for the ${#LOGIN}-character login: found $found, database error: $err"
  [ "$found" = 1 ] && [ "$err" = none ] || fails=1
done
[ "$fails" = 0 ] || { echo "like-cap: FAIL: the user exists, and a search over the 50-byte cap did not find it"; exit 1; }
echo "like-cap: ok: exact, prefix and both-sides searches found the user"
