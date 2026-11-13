#!/usr/bin/env python3
"""Offline test of tests/wfp/admin-mem.py summary (#434): synthetic rows, no network."""
import importlib.util, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("admin_mem", os.path.join(HERE, "admin-mem.py"))
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)
MIB = 1048576
fails = 0


def check(name, cond):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name)
    fails += 0 if cond else 1


def tr(marks, files=None):
    return {"v": 1, "m": [[n, 0, 0, int(w * MIB), 100] for n, w in marks], "files": files or {"woo": 900, "woo_admin": 300},
            "alloptions": [400, 250000], "locale": "en_US"}


rows = []
for i in range(3):
    rows.append({"page": "dashboard", "off": "none", "code": 200, "wasm": "119", "rtServed": 1,
                 "trace": tr([("mu", 30), ("plugins_loaded", 70), ("admin_init_end", 99), ("shutdown", 119)])})
    rows.append({"page": "dashboard", "off": "wcadmin", "code": 200, "wasm": "99", "rtServed": 1,
                 "trace": tr([("mu", 30), ("plugins_loaded", 62), ("admin_init_end", 85), ("shutdown", 99)], {"woo": 900, "woo_admin": 20})})
rows.append({"page": "dashboard", "off": "none", "code": 500, "wasm": None, "reset": "memory", "writeLoss": "1", "trace": None})
s = M.summary(rows)
d = s["dashboard"]
check("the end heap median ignores a reset row with no reading", d["none"]["endMiB"] == 119.0)
check("a switched-off component's saving is the median difference", d["wcadmin"]["savesMiB"] == 20.0)
check("the growth between checkpoints is attributed", d["none"]["growthMiB"]["mu>plugins_loaded"] == 40.0 and d["none"]["growthMiB"]["admin_init_end>shutdown"] == 20.0)
check("resets, write-loss and fresh runtimes are counted", d["none"]["resets"] == 1 and d["none"]["writeLoss"] == 1 and d["none"]["fresh"] == 3 and d["none"]["ok"] == 3)
check("the file groups show the switch took effect", d["wcadmin"]["files"]["woo_admin"] == 20 and d["none"]["files"]["woo_admin"] == 300)
check("a row is headers and trace only (no body key)", "body" not in M.row_of("x", "p", "none", 0, {"code": 200, "s": 1, "body": b"secret", "h": {"x-wasm-mib": "99"}}))
print("cases_failed=%d" % fails)
sys.exit(1 if fails else 0)
