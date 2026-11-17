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
#   4. (#795) the same read fails by the PLATFORM's hand, not the reset (x-pf-fault-sql-kind: busy, the database busy):
#      never a plausible wrong answer. It answers the retryable failure (503, Retry-After, no-store, x-sql-failure),
#      and the real value is still there (the failed read rolls the frame back). Red: a 200, and the default persists.
#   5. (#795) a read-only request whose read fails by the platform's hand (nothing written): the same retryable 503.
#   6. (#795) a DETERMINISTIC statement error (kind other: the statement itself is wrong) is NOT a 5xx: it goes back to
#      WordPress through wpdb's error path, as MySQL's does, and WordPress answers (a retry would fail forever).
#   7. (#795, the lead's case) a plugin upgrade's table probe on an ORDINARY ADMIN request (a real "no such table" on
#      admin_init, as a deploy that ships a plugin's new version would run on its first admin request): the dashboard
#      answers exactly as it does without the probe. Red, by path: 503 with Retry-After on every retry (locked out).
set -u
cd "$(dirname "$0")/.." || exit 1
export DEV_ENV=${DEV_ENV:-dosql-local}
# shellcheck source=port.sh
. ./port.sh
PW=${ADMIN_PASSWORD:-local-spike-password}; TOK=${SPIKE_TOKEN:-local-spike-token}
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
// #794 and #795 test fixture, an e2e build only (tests/failed-read-rollback-e2e.sh).
// x-pf-upgrade-probe: a plugin upgrade's table probe on an ordinary admin request (a REAL "no such table", not injected).
if ( ! empty( $_SERVER['HTTP_X_PF_UPGRADE_PROBE'] ) ) {
	add_action( 'admin_init', function () { global $wpdb; $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}pf_upgrade_probe" ); } );
}
// x-pf-derived: a failed read followed by a default.
if ( empty( $_SERVER['HTTP_X_PF_DERIVED'] ) ) { return; }
add_action( 'init', function () {
	if ( 'set' === $_SERVER['HTTP_X_PF_DERIVED'] ) { update_option( 'pf_derived_test', 'the-real-value', false ); return; }
	if ( false === get_option( 'pf_derived_test' ) ) { add_option( 'pf_derived_test', 'the-default', '', false ); }
} );
PHP
IMPORT_CONTENT="$STATE/content" IMPORT_MU_PLUGINS="pf-derived-test.php" ./build.sh > "$STATE/build.log" 2>&1 || { echo "failed-read-rollback: build.sh failed"; tail -5 "$STATE/build.log"; exit 1; }
DEV_LOCAL=1 DEV_LOG_LEVEL=log DEV_VARS="PHP_RECYCLE:off FAULT_INJECT:sql-fail REQUEST_FRAMES:on" ./run.sh _ping > /dev/null || { echo "failed-read-rollback: wrangler dev did not start"; tail -20 dev.log; exit 1; }
server_port || exit 1
B=http://localhost:$PORT
curl -sf -H "x-spike-token: $TOK" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "failed-read-rollback: /_install failed"; exit 1; }
B=$B TOK=$TOK PW=$PW python3 -I - <<'PY'
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
get("/?pf=4", {"x-pf-derived": "set"})
st, h, _ = get("/?pf=5", {"x-pf-derived": "check", "x-oc-off": "1", "x-pf-fault": "sql-fail", "x-pf-fault-sql": "pf_derived_test", "x-pf-fault-sql-kind": "busy"})
hl = {k.lower(): v for k, v in h.items()}
v = option()
print("  4. the read fails (busy, a platform failure): %s, retry-after %s, x-sql-failure %s, cache-control %s; the option now %r" % (st, hl.get("retry-after"), hl.get("x-sql-failure"), hl.get("cache-control"), v))
check("4. a platform failed read answers the retryable failure, never a 200 (503, Retry-After, no-store)", st == 503 and hl.get("retry-after") and "no-store" in (hl.get("cache-control") or ""), "%s" % st)
check("4. and no value derived from it persists: the real value is intact (the frame rolled back)", v == "the-real-value", repr(v))
check("4. it says what failed (x-sql-failure) and does not claim an isolate reset", hl.get("x-sql-failure") == "1" and "x-isolate-reset" not in hl, "%s %s" % (hl.get("x-sql-failure"), hl.get("x-isolate-reset")))
st, h, _ = get("/?pf=6", {"x-oc-off": "1", "x-pf-fault": "sql-fail", "x-pf-fault-sql": "wp_options", "x-pf-fault-sql-kind": "busy"})
hl = {k.lower(): v for k, v in h.items()}
check("5. a read-only request whose read fails by the platform's hand (nothing written): the retryable 503", st == 503 and hl.get("retry-after"), "%s %s" % (st, hl.get("retry-after")))
st, h, _ = get("/?pf=7", {"x-oc-off": "1", "x-pf-fault": "sql-fail", "x-pf-fault-sql": "wp_options", "x-pf-fault-sql-kind": "other"})
hl = {k.lower(): v for k, v in h.items()}
logs = [json.loads(l[l.index("{"):]) for l in open("dev.log", errors="replace") if '"statement-failure"' in l and "{" in l] if os.path.exists("dev.log") else []
cls = [x.get("class") for x in logs]
check("6. a deterministic statement error is not a 5xx: WordPress answers it, as on MySQL", st < 500 and "x-sql-failure" not in hl, "%s" % st)
check("6. and every failed statement is logged by class (shape only): platform and deterministic both seen", "platform" in cls and "deterministic" in cls, str(sorted(set(cls))))
sys.path.insert(0, os.path.join(os.getcwd(), "tests")); os.environ.setdefault("SPIKE_TOKEN", TOK); os.environ.setdefault("ADMIN_PASSWORD", os.environ.get("PW", "local-spike-password"))
import break_lib as BL
o = BL.login()
plain = BL.req(o, "/wp-admin/", timeout=300)
probed = BL.req(o, "/wp-admin/", headers={"x-pf-upgrade-probe": "1"}, timeout=300)
ph = {k.lower(): v for k, v in (probed["h"] or {}).items()}
logs = [json.loads(l[l.index("{"):]) for l in open("dev.log", errors="replace") if '"statement-failure"' in l and "upgrade_probe" in l and "{" in l] if os.path.exists("dev.log") else []
print("  7. the dashboard: %s without the probe, %s with it (x-sql-failure %s); logged %s" % (plain["code"], probed["code"], ph.get("x-sql-failure"), [(x.get("class"), x.get("shapes")) for x in logs[-1:]]))
check("7. a plugin-upgrade table probe on an admin request answers as stock does (no 5xx, no lock-out)", probed["code"] == plain["code"] == 200 and "x-sql-failure" not in ph, "%s %s" % (plain["code"], probed["code"]))
check("7. its real 'no such table' was the deterministic class, and logged by shape", bool(logs) and logs[-1].get("class") == "deterministic", str([x.get("class") for x in logs]))
print("failed-read-rollback: %d failing" % len(fails))
sys.exit(1 if fails else 0)
PY
