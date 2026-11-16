#!/usr/bin/env python3
"""deploy/wfp/options-diff.py (#794): offline, on synthetic snapshots in the format db-snapshot.mjs writes (dumpTo's
NDJSON, gzipped). Checked once by hand on two real /_dbexport dumps of a local site (the PR body).
Run: python3 -I deploy/wfp/tests/options-diff-test.py"""
import gzip
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "..", "options-diff.py")
fails = []


def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name + (("  (" + detail + ")") if detail else ""))
    if not cond:
        fails.append(name)


def snap(path, rows, table="wp_options", end=True, error=None, extra=()):
    cols = ["option_id", "option_name", "option_value", "autoload"]
    lines = [{"sql": "CREATE TABLE `%s` (`option_id` INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT)" % table}]
    for r in rows:
        lines.append({"sql": "INSERT INTO `%s` (%s) VALUES (?, ?, ?, ?)" % (table, ", ".join("`%s`" % c for c in cols)), "params": list(r)})
    lines.extend(extra)
    if error:
        lines.append({"error": error})
    elif end:
        lines.append({"end": True, "rows": len(rows)})
    with gzip.open(path, "wt") as f:
        for o in lines:
            f.write(json.dumps(o) + "\n")
    return path


def run(*args):
    p = subprocess.run([sys.executable, "-I", TOOL, *args], capture_output=True, text=True)
    return p.returncode, p.stdout, p.stderr


d = tempfile.mkdtemp(prefix="options-diff-test.")
OLD = [
    (1, "siteurl", "https://a", "yes"),
    (2, "plugin_setting", "the-real-value", "no"),
    (3, "stripe_api_key", "sk_live_SECRETOLD", "no"),
    (4, "gateway_settings", 'a:1:{s:13:"client_secret";s:9:"SECRETOLD";}', "off"),
    (5, "gone_option", "bye", "no"),
    (6, "_transient_x", "1", "no"),
    (7, "same_option", "same", "no"),
    (8, "replaced_row", "same-value", "no"),
    (9, "flip_autoload", "v", "no"),
    (10, "blogname", "Old name", "on"),
]
NEW = [
    (1, "siteurl", "https://a", "yes"),
    (2, "plugin_setting", "the-default", "no"),
    (3, "stripe_api_key", "sk_live_SECRETNEW", "no"),
    (4, "gateway_settings", 'a:1:{s:13:"client_secret";s:9:"SECRETNEW";}', "off"),
    (6, "_transient_x", "2", "no"),
    (7, "same_option", "same", "no"),
    (99, "replaced_row", "same-value", "no"),
    (9, "flip_autoload", "v", "auto-off"),
    (10, "blogname", "New name", "on"),
    (11, "new_option", "fresh\nline", "no"),
]
a = snap(os.path.join(d, "20261101T000000Z.ndjson.gz"), OLD)
b = snap(os.path.join(d, "20261116T000000Z.ndjson.gz"), NEW)

rc, out, err = run(a, b)
check("rc 0 on a diff", rc == 0, str(rc) + err)
check("a real value replaced by a default is listed, old and new", "plugin_setting" in out and "the-real-value" in out and "the-default" in out)
check("a secret-like NAME is listed by name, its value withheld", "stripe_api_key  (secret-like: value withheld)" in out)
check("a secret-like VALUE (a client_secret inside settings) is withheld too", "gateway_settings  (secret-like: value withheld)" in out)
check("no secret value is printed, in any mode", all("SECRET" not in run(a, b, *f)[1] and "sk_live" not in run(a, b, *f)[1] for f in ([], ["--all"], ["--json"], ["--all", "--json"])))
check("added and removed are listed", "ADDED" in out and "new_option" in out and "REMOVED" in out and "gone_option" in out)
check("a value with a newline is escaped, one line", "fresh\\nline" in out)
check("an unchanged option is not listed", "same_option" not in out)
check("a row replaced with the same value is flagged (id changed)", "replaced_row [id changed: the row was replaced]" in out)
check("an autoload-only change is listed separately", "AUTOLOAD ONLY" in out and "flip_autoload  no -> auto-off" in out)
check("transients are counted, not listed", "transients changed 1" in out and "_transient_x" not in out)
check("autoloaded options are left out by default (non-autoloaded only)", "blogname" not in out)
rc, out_all, _ = run(a, b, "--all")
check("--all adds the autoloaded ones", rc == 0 and "blogname" in out_all and "New name" in out_all)
rc, js, _ = run(a, b, "--json")
r = json.loads(js)
check("--json: the same counts", rc == 0 and len(r["changed"]) == 4 and len(r["added"]) == 1 and len(r["removed"]) == 1, str([len(r[k]) for k in ("changed", "added", "removed")]))
check("--json: secret-like records carry no old or new", all("old" not in x and "new" not in x for x in r["changed"] if x["withheld"]))

c = snap(os.path.join(d, "20261108T000000Z.ndjson.gz"), OLD)
rc, out_dir, _ = run(d)
check("a directory: the oldest and the newest by name", rc == 0 and "20261101T000000Z.ndjson.gz -> 20261116T000000Z.ndjson.gz" in out_dir, out_dir.split("\n")[0])

e = tempfile.mkdtemp(prefix="options-diff-test-bad.")
p1 = snap(os.path.join(e, "p1.ndjson.gz"), [(1, "x", "y", "no")], table="wpq_options")
p2 = snap(os.path.join(e, "p2.ndjson.gz"), [(1, "x", "z", "no")], table="wpq_options")
rc, out_p, _ = run(p1, p2)
check("another table prefix is found by its columns", rc == 0 and "changed 1" in out_p, out_p.split("\n")[1] if "\n" in out_p else out_p)
bad = {
    "truncated (no end line)": snap(os.path.join(e, "t.ndjson.gz"), OLD, end=False),
    "a dump that ended in an error": snap(os.path.join(e, "x.ndjson.gz"), OLD, error="Durable Object storage reset"),
    "no options rows": snap(os.path.join(e, "n.ndjson.gz"), [], table="wp_posts"),
    "two options tables without --table": snap(os.path.join(e, "m.ndjson.gz"), OLD, extra=[{"sql": "INSERT INTO `wp_2_options` (`option_id`, `option_name`, `option_value`, `autoload`) VALUES (?, ?, ?, ?)", "params": [1, "a", "b", "no"]}]),
}
for name, path in bad.items():
    rc, _, err = run(path, b)
    check("refused, exit 2: " + name, rc == 2 and "options-diff:" in err, "%s %s" % (rc, err.strip()[:90]))
nj = os.path.join(e, "notjson.ndjson.gz")
with gzip.open(nj, "wt") as f:
    f.write("not json\n")
rc, _, err = run(nj, b)
check("refused, exit 2: not a snapshot", rc == 2, str(rc))
rc, out_t, _ = run(bad["two options tables without --table"], snap(os.path.join(e, "m2.ndjson.gz"), NEW, extra=[{"sql": "INSERT INTO `wp_2_options` (`option_id`, `option_name`, `option_value`, `autoload`) VALUES (?, ?, ?, ?)", "params": [1, "a", "c", "no"]}]), "--table", "wp_2_options")
check("--table picks one options table", rc == 0 and "changed 1, added 0, removed 0" in out_t, out_t.split("\n")[1] if "\n" in out_t else out_t)
rc, _, _ = run(a)
check("one file and no directory is a usage error, exit 2", rc == 2, str(rc))

shutil.rmtree(d, ignore_errors=True)
shutil.rmtree(e, ignore_errors=True)
print("options-diff-test: %d failing" % len(fails))
sys.exit(1 if fails else 0)
