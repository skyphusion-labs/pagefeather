# shellcheck shell=bash
# Sourced by deploy/import.sh for VARIANT=a (MySQL or MariaDB through
# Hyperdrive; a2 is variant a on PlanetScale), issue #31. Not run on its own.
#
# After import.sh step 2 (the dump in SQLite gives the prefix and the site
# facts): read the server (version, max_allowed_packet), make the statements
# (mysql-prepare.py), send them to /_sqlimport (sqlimport.py), compare the rows
# of each table, then GET /. replace=1 DROPS EVERY TABLE OF THE SITE'S OWN PREFIX FIRST (#487): a run that
# stops leaves the site empty or partial, and the script says where it stopped.
# Uses: ROOT IMP APP WORK URL DUMP OLD_ORIGIN NEW_ORIGIN from import.sh.

a_prepare() {
python3 "$IMP/sqlimport.py" info "$URL" > "$WORK/server.json" || { cat "$WORK/server.json" >&2; echo "a: /_sqlimport?info=1 failed (is this a variant a site, deployed with this code?)" >&2; exit 1; }
FLAVOUR=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["flavour"])' "$WORK/server.json")
PACKET=$(python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get("max_allowed_packet"); print(v or "")' "$WORK/server.json")
[ -n "$PACKET" ] || { echo "a: the server did not report max_allowed_packet ($(cat "$WORK/server.json")): not importing with a guessed size" >&2; exit 1; }
# A statement must fit the packet (with room for the protocol) and one part of
# the request (1.5 MB, sqlimport.py; the Worker refuses a body over 2 MB).
MAXST=$(( PACKET - 1024 ))
[ "$MAXST" -le 1400000 ] || MAXST=1400000
echo "a: $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$WORK/server.json") ($FLAVOUR), max_allowed_packet $PACKET, statements up to $MAXST bytes, server sql_mode $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("sql_mode") or "(not readable)")' "$WORK/server.json")"
PREFIX=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["prefix"])' "$WORK/report.json")
# The TARGET site's own table prefix (#487), from the site: a site whose code predates it does not
# report one, and the import stops rather than guess wp_ (on a shared database wp_ reaches other stores).
TO_PREFIX=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("prefix") or "")' "$WORK/server.json")
[ -n "$TO_PREFIX" ] || { echo "a: the site did not report its table prefix (/_sqlimport?info=1): deploy its code from current main first (#487); nothing was imported" >&2; exit 1; }
echo "a: the dump's prefix $PREFIX becomes the site's $TO_PREFIX"
python3 "$IMP/mysql-prepare.py" "$DUMP" "$WORK/mysql.jsonl" --prefix "$PREFIX" --to-prefix "$TO_PREFIX" --flavour "$FLAVOUR" --max-statement "$MAXST" --old "$OLD_ORIGIN" --new "$NEW_ORIGIN" > "$WORK/mysql.json"
python3 - "$WORK/mysql.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
print(f"a: {r['statements']} statements, {sum(r['rows'].values())} rows; address changed in {r['changed']['address']} values; keys renamed: {r['changed']['user_roles']} user_roles, {r['changed']['usermeta_keys']} user meta")
if r["skipped_tables"]:
    print("a: NOT IMPORTED, tables without the prefix: " + ", ".join(sorted(r["skipped_tables"])))
if r["not_imported"]:
    print("a: NOT IMPORTED (triggers, routines, events): " + "; ".join(r["not_imported"]))
PY
}

a_load() {
python3 "$IMP/sqlimport.py" load "$URL" "$WORK/mysql.jsonl" --replace
python3 "$IMP/sqlimport.py" counts "$URL" > "$WORK/counts.json"
python3 - "$WORK/mysql.json" "$WORK/counts.json" "$WORK/mysql.jsonl" <<'PY'
import json, re, sys
want = json.load(open(sys.argv[1]))["rows"]
got = json.load(open(sys.argv[2]))["tables"]
made = {re.match(r"CREATE TABLE `([^`]+)`", json.loads(l)["sql"]).group(1) for l in open(sys.argv[3]) if json.loads(l)["sql"].startswith("CREATE TABLE")}
diff = {t: (want.get(t, 0), got.get(t, {}).get("rows")) for t in made if want.get(t, 0) != got.get(t, {}).get("rows")}
if diff:
    sys.exit(f"a: ROWS DIFFER (dump, database): {diff}")
print(f"rows: every table matches ({sum(want.values())} rows in {len(made)} tables)")
PY
}
