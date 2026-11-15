"""#582 S4 M2b: each lazy-body mechanism, broken on purpose, must turn its case of the suite red.

Usage: python3 -I engine/opcache/lazy/mutations.py <php-src tree, patched and built> [name ...]
For each mutation: edit one anchor (it must occur exactly once), rebuild with make, run run-native.sh, and require
every case in "red" to fail. The tree is restored and rebuilt at the end, also after an error. Prints one
"@event lazy-mutation {json}" line per mutation; exit 1 if any mutation stays green where it must go red.
"""
import json, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
M = [
    ("no-undef-args-ensure", "Zend/zend_execute.c",
     "if (UNEXPECTED(zend_pf_lazy_body_pending(op_array)) && zend_pf_lazy_body_ensure(op_array, true) == FAILURE) {\n\t\t\treturn FAILURE;",
     "if (0) {\n\t\t\treturn FAILURE;", ["plain"]),
    ("no-reflection-ensure", "ext/reflection/php_reflection.c",
     "if (UNEXPECTED(zend_pf_lazy_body_pending(op_array)) && zend_pf_lazy_body_ensure(op_array, true) == FAILURE) {\n\t\treturn NULL;",
     "if (0) {\n\t\treturn NULL;", ["refl"]),
    ("trait-check-compares-opcodes", "Zend/zend_inheritance.c",
     "(existing_fn->type == ZEND_USER_FUNCTION ? zend_pf_body_id(&existing_fn->op_array) : (const void*)existing_fn->op_array.opcodes) == zend_pf_body_id(&fn->op_array)",
     "existing_fn->op_array.opcodes == fn->op_array.opcodes", ["tcbad"]),
    ("no-adler-check", "ext/opcache/zend_file_cache.c",
     "ok = ok && zend_adler32(ADLER32_INIT, (unsigned char*)chunk, len) == e->adler;",
     "ok = ok && (zend_adler32(ADLER32_INIT, (unsigned char*)chunk, len) == e->adler || 1);", ["fail"]),
    ("failure-marks-loaded", "ext/opcache/zend_file_cache.c",
     "\tif (!ok) {\n\t\tfree(chunk);\n\t\tpf_lb_body_fail++;\n\t\treturn FAILURE;",
     "\tif (!ok) {\n\t\tfree(chunk);\n\t\tpf_lb_body_fail++;\n\t\td->loaded = true;\n\t\treturn FAILURE;", ["fail"]),
    ("continue-past-k", "ext/opcache/zend_file_cache.c",
     "EX(opline) = op_array->opcodes + k;", "EX(opline) = op_array->opcodes + k + 1;", ["plain"]),
    ("no-tail-crossing-check", "ext/opcache/zend_file_cache.c",
     "\t\tif (pf_xr.on) { \\\n", "\t\tif (0) { \\\n", ["xref"]),
]

def sh(cmd, cwd):
    return subprocess.run(cmd, cwd=cwd, shell=True, capture_output=True, text=True)

def touch_forward(p):
    # make compares mtimes, on some systems to the second: a mutant written in the same second as the last build
    # would look built already and the suite would test the OLD code. Push the edited file into the future.
    t = time.time() + 5
    os.utime(p, (t, t))

def build(src, edited):
    """Rebuild, and prove the edited file was compiled: its object file must be newer than before the build."""
    obj = os.path.splitext(os.path.join(src, edited))[0] + ".o"
    before = os.path.getmtime(obj) if os.path.exists(obj) else 0
    touch_forward(os.path.join(src, edited))
    r = sh("make -j%d > /dev/null 2>&1" % (os.cpu_count() or 2), src)
    if r.returncode != 0:
        return "the build failed"
    if not os.path.exists(obj) or os.path.getmtime(obj) <= before:
        return "make did not recompile " + edited + " (no newer " + os.path.relpath(obj, src) + ")"
    return None

def suite(src):
    r = sh("%s/run-native.sh %s/sapi/cli/php %s/modules/opcache.so" % (HERE, src, src), src)
    red = set()
    for line in r.stdout.splitlines():
        if line.startswith("@event lazy-case "):
            ev = json.loads(line[len("@event lazy-case "):])
            if not ev["ok"]:
                red.add(ev["case"])
    return r.returncode, red, r.stdout

def main(src, only):
    bad = 0
    for name, rel, old, new, want in M:
        if only and name not in only:
            continue
        p = os.path.join(src, rel)
        orig = open(p).read()
        if orig.count(old) != 1:
            print("@event lazy-mutation " + json.dumps({"name": name, "ok": False, "why": "anchor found %d times in %s" % (orig.count(old), rel)}))
            bad += 1
            continue
        try:
            open(p, "w").write(orig.replace(old, new))
            why = build(src, rel)
            if why:
                ev = {"name": name, "ok": False, "why": "mutant: " + why}
            else:
                rc, red, _ = suite(src)
                missing = [c for c in want if c not in red]
                ev = {"name": name, "ok": rc != 0 and not missing, "red": sorted(red), "want_red": want}
        finally:
            open(p, "w").write(orig)
        why = build(src, rel)  # the restored file must be compiled again before the next mutant
        if why:
            print("mutations: restoring %s: %s" % (rel, why))
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
