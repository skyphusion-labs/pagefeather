"""After the load: per table, the export report's row count = SELECT COUNT(*) on the target, and the
highest integer primary key equal to the report's last rowid where the table has one integer PK.
  count-check.py <report.json> <mysql defaults file> <database>
Exit 1 on any difference. Prints names and numbers only."""
import json, subprocess, sys
rep, cnf, db = sys.argv[1:4]
r = json.load(open(rep))
MYSQL = "/opt/homebrew/opt/mysql-client/bin/mysql"
def q(sql):
    p = subprocess.run([MYSQL, "--defaults-extra-file=" + cnf, "--ssl-mode=REQUIRED", "-N", "-B", db, "-e", sql], capture_output=True, text=True)
    if p.returncode != 0:
        sys.exit("mysql failed: " + p.stderr.strip()[:300])
    return p.stdout.strip()
bad, warn = [], []
for t, g in sorted(r["tables"].items()):
    n = int(q("SELECT COUNT(*) FROM `%s`" % t))
    pk = q("SELECT k.COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA=k.TABLE_SCHEMA AND c.TABLE_NAME=k.TABLE_NAME AND c.COLUMN_NAME=k.COLUMN_NAME WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME='%s' AND k.CONSTRAINT_NAME='PRIMARY' AND c.DATA_TYPE LIKE '%%int'" % t).split()
    mx = int(q("SELECT COALESCE(MAX(`%s`),0) FROM `%s`" % (pk[0], t)) or 0) if len(pk) == 1 else None
    if n != g["rows"]:
        bad.append({"table": t, "export_rows": g["rows"], "target_rows": n})
    elif mx is not None and g["rows"] and mx != g["last"]:
        warn.append({"table": t, "export_last_rowid": g["last"], "target_max_pk": mx})
print("tables %d, rows %d in the export; row counts differ in %d" % (len(r["tables"]), r["rows"], len(bad)), json.dumps(bad)[:1200])
print("max PK differs from the source last rowid in %d (a warning: SQLite rowid need not equal the PK)" % len(warn), json.dumps(warn)[:800])
for t, s in (("orders", "SELECT COUNT(*) FROM wp_wc_orders"), ("max order id", "SELECT COALESCE(MAX(id),0) FROM wp_wc_orders"), ("products", "SELECT COUNT(*) FROM wp_posts WHERE post_type='product' AND post_status='publish'"), ("published posts", "SELECT COUNT(*) FROM wp_posts WHERE post_type='post' AND post_status='publish'"), ("published pages", "SELECT COUNT(*) FROM wp_posts WHERE post_type='page' AND post_status='publish'")):
    print("target", t, q(s))
sys.exit(1 if bad else 0)
