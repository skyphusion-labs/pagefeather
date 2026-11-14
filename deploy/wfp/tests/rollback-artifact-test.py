#!/usr/bin/env python3
"""Test of deploy/wfp/rollback_artifact.py (#466) against a stand-in S3 (fake-s3.py): pack, put
with read-back, get, a missing artifact (exit 3), the #465 guard (an artifact that holds another
build is refused), unsafe trees refused, -dirty and odd ids refused, and prune.
No account. Run: python3 -I deploy/wfp/tests/rollback-artifact-test.py"""
import io, os, shutil, subprocess, sys, tarfile, tempfile, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RA = os.path.join(HERE, "..", "rollback_artifact.py")
T = tempfile.mkdtemp()
fails = 0


def check(name, ok):
    global fails
    print(("PASS " if ok else "FAIL ") + name)
    fails += 0 if ok else 1


pf = os.path.join(T, "port")
srv = subprocess.Popen([sys.executable, "-I", os.path.join(HERE, "fake-s3.py"), pf])
try:
    for _ in range(50):
        if os.path.exists(pf) and open(pf).read():
            break
        time.sleep(0.1)
    EP = "http://127.0.0.1:" + open(pf).read()
    env = dict(os.environ, WFP_S3_ENDPOINT=EP, WFP_S3_KEY_ID="test-key", WFP_S3_SECRET="test-secret", CLOUDFLARE_ACCOUNT_ID="test")

    def run(*a):
        return subprocess.run([sys.executable, "-I", RA, *a], env=env, capture_output=True, text=True)

    def keys():
        return urllib.request.urlopen(EP + "/_keys").read().decode().split()

    def app(bid, marker):
        d = tempfile.mkdtemp(dir=T)
        os.makedirs(os.path.join(d, "build", "public"))
        os.makedirs(os.path.join(d, "vendor"))
        open(os.path.join(d, "build", "build-id.js"), "w").write('export default "%s";\n' % bid)
        open(os.path.join(d, "build", "site.zip"), "wb").write(os.urandom(4096))
        open(os.path.join(d, "build", "public", "x.css"), "w").write("a{}")
        open(os.path.join(d, "vendor", "php_8_3.js"), "w").write("// loader " + marker)
        open(os.path.join(d, "index.js"), "w").write("// " + marker)
        open(os.path.join(d, "turnstile.mjs"), "w").write("// t")
        open(os.path.join(d, "package.json"), "w").write("{}")
        open(os.path.join(d, "README.md"), "w").write("not packed")
        os.makedirs(os.path.join(d, "node_modules", "x"))
        return d

    B = "wp-wfp-b-media"
    a1 = app("bbbbbbbbbbbb-wooprimed", "B live")
    tgz = os.path.join(T, "b.tar.gz")
    r = run("pack", a1, "bbbbbbbbbbbb-wooprimed", tgz)
    check("pack: exit 0", r.returncode == 0)
    names = tarfile.open(tgz).getnames()
    check("  it holds build/, vendor/ and the root sources", all(n in names for n in ("build/build-id.js", "build/site.zip", "build/public/x.css", "vendor/php_8_3.js", "index.js", "turnstile.mjs", "package.json")))
    check("  and not README.md or node_modules", "README.md" not in names and not any(n.startswith("node_modules") for n in names))
    r = run("pack", a1, "aaaaaaaaaaaa", os.path.join(T, "x.tar.gz"))
    check("pack refuses an id that build/ does not hold", r.returncode != 0 and "build/ holds bbbbbbbbbbbb-wooprimed" in r.stderr)
    a_dirty = app("cccccccccccc-dirty", "dirty")
    r = run("pack", a_dirty, "cccccccccccc-dirty", os.path.join(T, "x.tar.gz"))
    check("pack refuses a -dirty id", r.returncode != 0 and "dirty tree" in r.stderr)

    r = run("put", B, "bbbbbbbbbbbb-wooprimed", tgz)
    check("put: exit 0, read back", r.returncode == 0 and "read back" in r.stdout)
    check("  at _build/artifact/<id>.tar.gz", "/%s/_build/artifact/bbbbbbbbbbbb-wooprimed.tar.gz" % B in keys())
    r = run("put", B, "../x", tgz)
    check("put refuses an id with ..", r.returncode == 1 and not any("../x" in k for k in keys()))

    out = tempfile.mkdtemp(dir=T)
    r = run("get", B, "bbbbbbbbbbbb-wooprimed", out)
    check("get: exit 0", r.returncode == 0)
    check("  the tree is the live build's own code", open(os.path.join(out, "index.js")).read() == "// B live" and open(os.path.join(out, "vendor", "php_8_3.js")).read() == "// loader B live")
    r = run("get", B, "dddddddddddd", tempfile.mkdtemp(dir=T))
    check("get: no artifact: exit 3", r.returncode == 3)
    r = run("get", "wp-wfp-other-media", "bbbbbbbbbbbb-wooprimed", tempfile.mkdtemp(dir=T))
    check("get reads only the bucket it is given (another site's bucket has none: 3)", r.returncode == 3)

    # The #465 guard: an artifact stored under B's live id that holds site A's build is refused.
    a2 = app("aaaaaaaaaaaa-wooprimed", "A")
    atgz = os.path.join(T, "a.tar.gz")
    run("pack", a2, "aaaaaaaaaaaa-wooprimed", atgz)
    run("put", B, "aaaaaaaaaaaa-wooprimed", atgz)
    urllib.request.urlopen(urllib.request.Request(EP + "/%s/_build/artifact/eeeeeeeeeeee.tar.gz" % B, data=open(atgz, "rb").read(), method="PUT"))
    o = tempfile.mkdtemp(dir=T)
    r = run("get", B, "eeeeeeeeeeee", o)
    check("get refuses an artifact that holds another build (#465 guard)", r.returncode == 1 and "holds build aaaaaaaaaaaa-wooprimed, not eeeeeeeeeeee" in r.stderr)
    check("  and nothing of it reaches the out dir", os.listdir(o) == [])

    # Unsafe trees: a link, a path out, a name outside the allowed set.
    def bad(name, kind):
        b = io.BytesIO()
        with tarfile.open(fileobj=b, mode="w:gz") as t:
            i = tarfile.TarInfo("build/build-id.js"); data = b'export default "ffffffffffff";\n'; i.size = len(data); t.addfile(i, io.BytesIO(data))
            i = tarfile.TarInfo(name)
            if kind == "link":
                i.type = tarfile.SYMTYPE; i.linkname = "/etc/passwd"; t.addfile(i)
            else:
                i.size = 1; t.addfile(i, io.BytesIO(b"x"))
        urllib.request.urlopen(urllib.request.Request(EP + "/%s/_build/artifact/ffffffffffff.tar.gz" % B, data=b.getvalue(), method="PUT"))
        o = tempfile.mkdtemp(dir=T)
        return run("get", B, "ffffffffffff", o), o
    for name, kind, label in (("vendor/l", "link", "a symbolic link"), ("../escape.js", "file", "a path with .."), ("/abs.js", "file", "an absolute path"), ("node_modules/x.js", "file", "a name outside build/, vendor/, root sources"), ("build/../../x", "file", "build/ then ..")):
        r, o = bad(name, kind)
        check("get refuses %s" % label, r.returncode == 1 and "refused" in r.stderr and not os.path.exists(os.path.join(o, "build")))
    check("  nothing escaped the out dir", not os.path.exists(os.path.join(T, "escape.js")))
    r = run("get", B, "cccccccccccc-dirty", tempfile.mkdtemp(dir=T))
    check("get refuses a -dirty id", r.returncode == 1 and "dirty tree" in r.stderr)

    # Prune: keep the new build and the one before it; another bucket is never touched.
    run("put", "wp-wfp-other-media", "bbbbbbbbbbbb-wooprimed", tgz)
    r = run("prune", B, "aaaaaaaaaaaa-wooprimed", "bbbbbbbbbbbb-wooprimed")
    left = sorted(k for k in keys() if k.startswith("/%s/" % B))
    check("prune keeps the two named builds only", r.returncode == 0 and left == ["/%s/_build/artifact/aaaaaaaaaaaa-wooprimed.tar.gz" % B, "/%s/_build/artifact/bbbbbbbbbbbb-wooprimed.tar.gz" % B])
    check("  another site's bucket is untouched", "/wp-wfp-other-media/_build/artifact/bbbbbbbbbbbb-wooprimed.tar.gz" in keys())
    r = run("prune", B, "", "x-dirty")
    check("prune with no plain id to keep deletes nothing (exit 1)", r.returncode == 1 and len([k for k in keys() if k.startswith("/%s/" % B)]) == 2)
    # No __pycache__ next to snapshot.py (an untracked file makes the tree dirty, and site update
    # refuses a dirty tree, #377). Bytecode writing is switched ON first, so this check can fail.
    pc = os.path.join(HERE, "..", "__pycache__")
    shutil.rmtree(pc, ignore_errors=True)
    subprocess.run([sys.executable, "-I", "-c", "import runpy, sys; sys.dont_write_bytecode = False; sys.pycache_prefix = None; sys.argv = ['rollback_artifact.py', 'prune']; runpy.run_path(%r, run_name='__main__')" % RA], env=env, capture_output=True)
    check("rollback_artifact.py writes no __pycache__ next to snapshot.py", not os.path.exists(pc))
finally:
    srv.kill(); srv.wait()
    shutil.rmtree(T, ignore_errors=True)
print("%d failing check(s)" % fails)
sys.exit(1 if fails else 0)
