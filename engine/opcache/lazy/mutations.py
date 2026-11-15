"""#582 S4 M2b: each lazy-body mechanism, broken on purpose, must turn its case of the suite red.

Usage: python3 -I engine/opcache/lazy/mutations.py <php-src tree, patched and built> [name ...]
For each mutation: apply its edits (each anchor must occur exactly once), rebuild with make (proving each edited
file was compiled again), run run-native.sh, and require every case in "red" to fail. "prime" stands for the
priming step itself (run-native.sh refuses to go on when OPcache cannot compile a fixture). The tree is restored
and rebuilt after each mutation. Prints one "@event lazy-mutation {json}" line per mutation; exit 1 if any
mutation stays green where it must go red.
"""
import json, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
FC, PE, PC = "ext/opcache/zend_file_cache.c", "ext/opcache/zend_persist.c", "ext/opcache/zend_persist_calc.c"
M = [
    ("no-undef-args-ensure", [("Zend/zend_execute.c",
      "if (UNEXPECTED(zend_pf_lazy_body_pending(op_array)) && zend_pf_lazy_body_ensure(op_array, true) == FAILURE) {\n\t\t\treturn FAILURE;",
      "if (0) {\n\t\t\treturn FAILURE;")], ["plain"]),
    ("no-reflection-ensure", [("ext/reflection/php_reflection.c",
      "if (UNEXPECTED(zend_pf_lazy_body_pending(op_array)) && zend_pf_lazy_body_ensure(op_array, true) == FAILURE) {\n\t\treturn NULL;",
      "if (0) {\n\t\treturn NULL;")], ["refl"]),
    ("trait-check-compares-opcodes", [("Zend/zend_inheritance.c",
      "(existing_fn->type == ZEND_USER_FUNCTION ? zend_pf_body_id(&existing_fn->op_array) : (const void*)existing_fn->op_array.opcodes) == zend_pf_body_id(&fn->op_array)",
      "existing_fn->op_array.opcodes == fn->op_array.opcodes")], ["tcbad"]),
    ("no-adler-check", [(FC, "ok = ok && zend_adler32(ADLER32_INIT, (unsigned char*)chunk, len) == e->adler;",
      "ok = ok && (zend_adler32(ADLER32_INIT, (unsigned char*)chunk, len) == e->adler || 1);")], ["fail"]),
    ("failure-marks-loaded", [(FC, "\tif (!ok) {\n\t\tfree(chunk);\n\t\tpf_lb_body_fail++;\n\t\treturn FAILURE;",
      "\tif (!ok) {\n\t\tfree(chunk);\n\t\tpf_lb_body_fail++;\n\t\td->loaded = true;\n\t\treturn FAILURE;")], ["fail"]),
    ("continue-past-k", [(FC, "EX(opline) = op_array->opcodes + k;", "EX(opline) = op_array->opcodes + k + 1;")], ["plain"]),
    # stage 3: no array or string is marked shared, so calc and persist agree on the stage 2 placement: the
    # crossings come back, the store counts them, and those files load whole
    ("no-shared-marks", [(PC, "\t\tzend_hash_index_add_empty_element(pf_lb_shared, key);\n", "\t\t(void)key;\n")], ["xref", "xstr"]),
    # ... and with the store's crossing check gone too, such a file loads lazily with a head that points at nothing
    ("no-shared-marks-and-no-crossing-check", [(PC, "\t\tzend_hash_index_add_empty_element(pf_lb_shared, key);\n", "\t\t(void)key;\n"),
      (FC, "\t\tif (pf_xr.on) { \\\n", "\t\tif (0) { \\\n")], ["xref"]),
    # persist leaves a shared array in the body while calc counted it in the head: persist overruns its block, and
    # upstream's own size check refuses the compile (loud, at priming)
    ("shared-array-stays-in-the-body", [(PE,
      "} else if (pf_lb_in_body && pf_lb_shared && zend_hash_index_exists(pf_lb_shared,",
      "} else if (0 && pf_lb_in_body && pf_lb_shared && zend_hash_index_exists(pf_lb_shared,")], ["prime"]),
    ("head-list-not-unserialized", [(FC,
      "\tif (script->pf_head_arr) { /* pagefeather lazy bodies (#582 M2b stage 3): the arrays moved to the head, before the tables */\n\t\tUNSERIALIZE_PTR",
      "\tif (0) { /* pagefeather lazy bodies (#582 M2b stage 3): the arrays moved to the head, before the tables */\n\t\tUNSERIALIZE_PTR")], ["xref"]),
]

def sh(cmd, cwd):
    return subprocess.run(cmd, cwd=cwd, shell=True, capture_output=True, text=True)

def build(src, edited):
    """Rebuild, and prove each edited file was compiled: its object file must be newer than before the build.
    make compares mtimes, on some systems to the second, so the edited files are pushed into the future first."""
    objs = {rel: os.path.splitext(os.path.join(src, rel))[0] + ".o" for rel in edited}
    before = {rel: (os.path.getmtime(o) if os.path.exists(o) else 0) for rel, o in objs.items()}
    t = time.time() + 5
    for rel in edited:
        os.utime(os.path.join(src, rel), (t, t))
    r = sh("make -j%d > /dev/null 2>&1" % (os.cpu_count() or 2), src)
    if r.returncode != 0:
        return "the build failed"
    for rel, o in objs.items():
        if not os.path.exists(o) or os.path.getmtime(o) <= before[rel]:
            return "make did not recompile " + rel
    return None

def suite(src):
    r = sh("%s/run-native.sh %s/sapi/cli/php %s/modules/opcache.so" % (HERE, src, src), src)
    red = set()
    for line in r.stdout.splitlines():
        if line.startswith("@event lazy-case "):
            ev = json.loads(line[len("@event lazy-case "):])
            if not ev["ok"]:
                red.add(ev["case"])
        if line.startswith("prime: could not compile") or line.startswith("prime: only"):
            red.add("prime")
    return r.returncode, red, r.stdout

def main(src, only):
    bad = 0
    for name, edits, want in M:
        if only and name not in only:
            continue
        origs, ev = {}, None
        for rel, old, new in edits:
            p = os.path.join(src, rel)
            s = origs.get(rel) if rel in origs else open(p).read()
            origs.setdefault(rel, s)
            cur = open(p).read()
            if cur.count(old) != 1:
                ev = {"name": name, "ok": False, "why": "anchor found %d times in %s" % (cur.count(old), rel)}
                break
            open(p, "w").write(cur.replace(old, new))
        try:
            if ev is None:
                why = build(src, list(origs))
                if why:
                    ev = {"name": name, "ok": False, "why": "mutant: " + why}
                else:
                    rc, red, _ = suite(src)
                    missing = [c for c in want if c not in red]
                    ev = {"name": name, "ok": rc != 0 and not missing, "red": sorted(red), "want_red": want}
        finally:
            for rel, s in origs.items():
                open(os.path.join(src, rel), "w").write(s)
        why = build(src, list(origs))  # the restored files must be compiled again before the next mutant
        if why:
            print("mutations: restoring %s: %s" % (list(origs), why))
            return 1
        print("@event lazy-mutation " + json.dumps(ev))
        bad += 0 if ev["ok"] else 1
    rc, red, out = suite(src)
    print("mutations: restored tree suite rc=%d red=%s" % (rc, sorted(red)))
    if rc != 0:
        bad += 1
    print("mutations: %s" % ("every mutant went red where it must" if not bad else "%d FAILED" % bad))
    return 1 if bad else 0

if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1], set(sys.argv[2:])))
