#!/bin/bash
# #794: a value derived from a failed read and written to the database must not persist. A test-only mu-plugin (this
# build only, through IMPORT_CONTENT) does the common pattern: if get_option() is false, add_option() a default.
# After a failed read, WordPress caches the option as missing (notoptions), so add_option() skips its own check and
# its INSERT ... ON DUPLICATE KEY UPDATE overwrites the REAL value with the default.
#   1. the real value is stored (non-autoloaded, so its read is a statement of its own);
#   2. control: the pattern with no failure leaves the real value;
#   3. the read fails at the memory ceiling (the #766 seam, reset kind; the object cache off for the request, so the
#      read reaches the database): the answer is the visible failure, and the real value is still there. Red: the
#      default persists. When nothing was kept at a commit point, the answer says so: x-write-loss: rolled-back.
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8797} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT; PW=${ADMIN_PASSWORD:-local-spike-password}; TOK=${SPIKE_TOKEN:-local-spike-token}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/failed-read-rollback.XXXXXX"); export PERSIST_TO=$STATE/db
# This test builds with its own mu-plugin (IMPORT_CONTENT). It saves the whole build/ tree first and puts it back
# EXACTLY on exit: a later step (opcache-build's remote packs) works on the primed build an earlier step made
# (build.sh and opcache.sh), which a plain rebuild cannot reproduce.
[ -d build ] || { echo "failed-read-rollback: no build/ (run build.sh first)"; exit 1; }
cp -a build "$STATE/build.saved" || { echo "failed-read-rollback: could not save build/"; exit 1; }
trap './run.sh --stop > /dev/null 2>&1; rm -rf build && mv "$STATE/build.saved" build || echo "failed-read-rollback: build/ was NOT restored"; rm -rf "$STATE"' EXIT
mkdir -p "$STATE/content/mu-plugins"
cat > "$STATE/content/mu-plugins/pf-derived-test.php" <<'PHP'
<?php
// #794 test fixture, an e2e build only: a failed read followed by a default (tests/failed-read-rollback-e2e.sh).
if ( empty( $_SERVER['HTTP_X_PF_DERIVED'] ) ) { return; }
add_action( 'init', function () {
	if ( 'set' === $_SERVER['HTTP_X_PF_DERIVED'] ) { update_option( 'pf_derived_test', 'the-real-value', false ); return; }
	if ( false === get_option( 'pf_derived_test' ) ) { add_option( 'pf_derived_test', 'the-default', '', false ); }
} );
PHP
IMPORT_CONTENT="$STATE/content" IMPORT_MU_PLUGINS="pf-derived-test.php" ./build.sh > "$STATE/build.log" 2>&1 || { echo "failed-read-rollback: build.sh failed"; tail -5 "$STATE/build.log"; exit 1; }
DEV_LOCAL=1 DEV_LOG_LEVEL=log DEV_VARS="PHP_RECYCLE:off FAULT_INJECT:sql-fail REQUEST_FRAMES:on" ./run.sh _ping > /dev/null || { echo "failed-read-rollback: wrangler dev did not start"; tail -20 dev.log; exit 1; }
curl -sf -H "x-spike-token: $TOK" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "failed-read-rollback: /_install failed"; exit 1; }
B=$B TOK=$TOK python3 -I - <<'PY'
import json, os, sys, urllib.request, urllib.error
B, TOK = os.environ["B"], os.environ["TOK"]
def get(path, h):
    r = urllib.request.Request(B + path, headers={"x-spike-token": TOK, **h})
    try:
        with urllib.request.urlopen(r, timeout=300) as x: return x.status, dict(x.headers), x.read()
    except urllib.error.HTTPError as e: return e.code, dict(e.headers), e.read()
def option():
    after = None
    while True:
        st, _, b = get("/_mysqlexport?table=wp_options&limit=500" + ("&after=%s" % after if after else ""), {})
        d = json.loads(b); cols = d.get("columns") or []; rows = d.get("rows") or []
        for r in rows:
            m = dict(zip(cols, r))
            if m.get("option_name") == "pf_derived_test": return m.get("option_value")
        after = d.get("next") or d.get("after")
        if not rows or not after: return None
fails = []
def check(name, cond, detail=""):
    print(("  ok   " if cond else "  FAIL ") + name + (("  (" + detail + ")") if detail else "")); cond or fails.append(name)
get("/?pf=1", {"x-pf-derived": "set"})
check("1. the real value is stored", option() == "the-real-value", repr(option()))
st, _, _ = get("/?pf=2", {"x-pf-derived": "check", "x-oc-off": "1"})
check("2. control: the pattern with no failure keeps the real value", st == 200 and option() == "the-real-value", "%s %r" % (st, option()))
st, h, _ = get("/?pf=3", {"x-pf-derived": "check", "x-oc-off": "1", "x-pf-fault": "sql-fail", "x-pf-fault-sql": "pf_derived_test"})
wl = {k.lower(): v for k, v in h.items()}.get("x-write-loss")
v = option()
print("  3. the read fails (reset kind): %s, x-write-loss %s; the option now %r" % (st, wl, v))
check("3. the answer is the visible failure (a 500)", st == 500)
check("3. a value derived from the failed read did not persist: the real value is intact", v == "the-real-value", repr(v))
check("3. nothing was kept at a commit point, so the answer says so: x-write-loss: rolled-back", wl == "rolled-back", repr(wl))
print("failed-read-rollback: %d failing" % len(fails))
sys.exit(1 if fails else 0)
PY
