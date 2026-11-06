#!/usr/bin/env python3
"""Gate for SQL transactions through $wpdb (issue #60).

Usage: B=<site> ADMIN_PASSWORD=... [ECHO=<echo base>] python3 tests/tx/tx_check.py
The site's build must hold tests/tx/test-tx-route.php as an mu-plugin (test-only;
the gate script copies it into the built tree). ECHO (an httpbin-like server,
tests/http/echo.py locally) is for the fetch case; without it, that case is skipped.

Checks (PASS or FAIL; exit 1 on any FAIL):
  inside        the transaction sees its own insert
  rollback      insert then ROLLBACK: the row is gone
  commit        insert then COMMIT: the row is there
  die           insert then a PHP fatal error: the row is gone (rolled back at the
                end of the request, as MySQL does when a connection closes)
  savepoint     ROLLBACK TO SAVEPOINT undoes only what came after the savepoint
  update        an UPDATE and a DELETE are undone: the old value and the row are back
  cache         an update_option() in a rolled-back transaction leaves get_option()
                on the old value in the next request (no stale object cache)
  fetch         an outbound HTTP request inside a transaction (ECHO): no deadlock,
                and the rollback still undoes the insert
  concurrency   (ECHO) a second request writes while the first waits on a fetch inside
                its transaction: the first rolls back, the write of the second stays
  nested-begin  START TRANSACTION inside a transaction commits the first (MySQL)
  ddl           CREATE TABLE inside a transaction commits it first (MySQL)
"""
import json, os, sys, time, uuid
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "spikes", "b2-wordpress", "tests"))
import break_lib as L

ECHO = os.environ.get("ECHO", "").rstrip("/")
bad = 0
admin = L.login()
page = (L.req(admin, "/wp-admin/post-new.php")["body"] or b"").decode("utf-8", "replace")
nonce = (page.split('createNonceMiddleware( "')[1:] or [""])[0].split('"')[0]
H = {"X-WP-Nonce": nonce, "Content-Type": "application/json"}


def check(name, ok, detail=""):
    global bad
    print(("PASS " if ok else "FAIL ") + name + (" | " + str(detail)[:300] if detail else ""), flush=True)
    bad += 0 if ok else 1


def run(mode, marker, **extra):
    t = time.time()
    r = L.req(admin, "/?rest_route=/skyphusion-test/v1/tx", data=json.dumps(dict(mode=mode, marker=marker, **extra)).encode(), headers=H, method="POST", timeout=90)
    try:
        js = json.loads(r["body"] or b"null")
    except ValueError:
        js = (r["body"] or b"")[:200]
    return r["code"], js, time.time() - t


def state(marker):
    r = L.req(admin, "/?rest_route=/skyphusion-test/v1/tx&marker=" + marker, headers=H)
    return json.loads(r["body"] or b"{}")


def clean(marker):
    L.req(admin, "/?rest_route=/skyphusion-test/v1/tx&marker=" + marker, headers=H, method="DELETE")


def case(mode, judge, **extra):
    m = uuid.uuid4().hex[:12]
    code, js, took = run(mode, m, **extra)
    st = state(m)
    judge(code, js, st, took)
    clean(m)


case("rollback", lambda c, js, st, t: (check("inside: the transaction sees its own insert", isinstance(js, dict) and js.get("seen_inside") == 1, js),
                                        check("rollback: the row is gone", c == 200 and st.get("rows") == 0, {"route": c, "state": st})))
case("commit", lambda c, js, st, t: check("commit: the row is there", c == 200 and st.get("rows") == 1, {"route": c, "state": st}))
case("die", lambda c, js, st, t: check("die: a fatal error with the transaction open rolls it back", c == 500 and st.get("rows") == 0, {"route": c, "state": st}))
case("savepoint", lambda c, js, st, t: check("savepoint: only the part after the savepoint is undone", c == 200 and st.get("rows_a") == 1 and st.get("rows_b") == 0, {"route": c, "state": st}))
case("update", lambda c, js, st, t: check("update: UPDATE and DELETE are undone", c == 200 and isinstance(js, dict) and js.get("inside_value") == "changed" and st.get("db_value") == "orig" and st.get("rows_d") == 1, {"route": c, "inside": js.get("inside_value") if isinstance(js, dict) else js, "state": st}))
case("cache", lambda c, js, st, t: check("cache: get_option() is back on the old value after the rollback", c == 200 and isinstance(js, dict) and js.get("inside_option") == "changed" and st.get("db_value") == "orig" and st.get("option_value") == "orig", {"route": c, "inside": js.get("inside_option") if isinstance(js, dict) else js, "state": st}))
if ECHO:
    case("fetch", lambda c, js, st, t: check("fetch: an outbound request inside a transaction, then the rollback", c == 200 and isinstance(js, dict) and js.get("fetch_status") == 200 and st.get("rows") == 0 and t < 10, {"route": c, "fetch": js.get("fetch_status") if isinstance(js, dict) else js, "state": st, "seconds": round(t, 2)}), url=ECHO + "/anything")
else:
    print("SKIP fetch | no ECHO", flush=True)
if ECHO:
    # Request A: a transaction that waits 3 s on an outbound fetch, then rolls back.
    # Request B, 0.7 s later: a plain write. The PHP lock is held across the await
    # in A, so B runs after A ends: the write of B is not in the undo log of A and stays.
    import threading
    m = uuid.uuid4().hex[:12]
    res = {}

    def a():
        res["a"] = run("fetch", m, url=ECHO + "/delay/3") + (time.time(),)

    def b():
        time.sleep(0.7)
        res["b"] = run("insert_b", m) + (time.time(),)

    ta, tb = threading.Thread(target=a), threading.Thread(target=b)
    ta.start(); tb.start(); ta.join(); tb.join()
    st = state(m)
    a_js = res["a"][1]
    check("concurrency: a write made while another request holds a transaction survives its rollback",
          st.get("rows") == 0 and st.get("rows_b") == 1 and res["b"][3] >= res["a"][3],
          {"state": st, "b_end_minus_a_end_s": round(res["b"][3] - res["a"][3], 2), "a_fetch": a_js.get("fetch_status") if isinstance(a_js, dict) else a_js})
    clean(m)
case("nested_begin", lambda c, js, st, t: check("nested-begin: a second START TRANSACTION commits the first", c == 200 and st.get("rows_a") == 1 and st.get("rows_b") == 0, {"route": c, "state": st}))
case("ddl", lambda c, js, st, t: check("ddl: CREATE TABLE commits the transaction first", c == 200 and st.get("rows") == 1, {"route": c, "state": st}))

print("FAILS %d" % bad)
sys.exit(1 if bad else 0)
