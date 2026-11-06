#!/bin/bash
# Import an existing WordPress site's database into a deploy/ site (issue #31).
#
#   URL=https://my-site.acct.workers.dev SPIKE_TOKEN=... DUMP=site.sql ./deploy/import.sh
#   URL=... NAME=my-site DUMP=site.sql ./deploy/import.sh   (SPIKE_TOKEN from Terraform)
#
# VARIANT: b-dosql only in this version (the database is the PHP object's
# SQLite). Other variants stop with an error; see deploy/import/README.md.
#
# DUMP is the output of "mysqldump --hex-blob" or "wp db export --hex-blob"
# of the source site. The source site is only read; nothing here connects to it.
#
# Steps: driver checkout -> dump to SQLite (wp_ prefix) -> site address to the
# new origin -> SQLite to a dbmove dump -> import into the object (replaces its
# database) -> export again and compare the rows of each table -> GET / and
# check the title. Work files go to WORK (default $TMPDIR/wp-import-<time>);
# they hold the site's data (user e-mail addresses, password hashes), so the
# script makes the directory mode 700 and tells you to remove it.
#
# Options: OLD_ORIGIN (default: the home option of the dump), DRY_RUN=1 (stop
# before the import; print what would change).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP="$ROOT/spikes/b2-wordpress"
IMP="$ROOT/deploy/import"
VARIANT=${VARIANT:-b-dosql}
: "${DUMP:?set DUMP to the mysqldump file}"
[ -r "$DUMP" ] || { echo "cannot read DUMP=$DUMP" >&2; exit 2; }
[ "$VARIANT" = b-dosql ] || { echo "VARIANT=$VARIANT: import supports b-dosql only (deploy/import/README.md)" >&2; exit 2; }

: "${URL:?set URL to the site address that deploy.sh printed}"
if [ -z "${SPIKE_TOKEN:-}" ] && [ -n "${NAME:-}" ]; then
  TF="$ROOT/deploy/terraform"
  terraform -chdir="$TF" workspace select "$NAME" >/dev/null
  SPIKE_TOKEN=$(terraform -chdir="$TF" output -raw spike_token)
fi
: "${SPIKE_TOKEN:?set SPIKE_TOKEN}"
export SPIKE_TOKEN
NEW_ORIGIN=$(python3 -c 'import sys,urllib.parse as u; p=u.urlsplit(sys.argv[1]); print(f"{p.scheme}://{p.netloc}")' "$URL")
URL=$NEW_ORIGIN

WORK=${WORK:-${TMPDIR:-/tmp}/wp-import-$(date -u +%Y%m%dT%H%M%SZ)}
mkdir -p "$WORK"; chmod 700 "$WORK"
echo "work files: $WORK"

# 1. The driver at the ref the build uses, so its _wp_sqlite_* tables match.
REF=$(sed -n 's/^SQLITE_DI_REF=//p' "$APP/build.sh")
DRV="$APP/build/cache/sqlite-database-integration"
[ -d "$DRV/.git" ] || git clone -q https://github.com/WordPress/sqlite-database-integration "$DRV"
[ "$(git -C "$DRV" rev-parse --short=7 HEAD)" = "${REF:0:7}" ] || git -C "$DRV" checkout -q "$REF"

# 2. Dump to SQLite.
php "$IMP/dump-to-sqlite.php" "$DRV" "$DUMP" "$WORK/site.sqlite" > "$WORK/report.json"
python3 - "$WORK/report.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
s = r["site"]
print(f"prefix {r['prefix']}" + (" -> wp_" if r["renamed"] else "") + f", {r['statements']} statements, {sum(r['rows'].values())} rows in {len(r['rows'])} tables")
print(f"home {s['home']}  siteurl {s['siteurl']}")
print(f"theme {s['stylesheet']} (parent {s['template']})")
print("active plugins: " + (", ".join(s["active_plugins"] or []) or "none"))
if r["without_prefix"]:
    print("tables without the prefix (kept): " + ", ".join(r["without_prefix"]))
PY

# 3. The site address. Home and siteurl must be one origin with no path.
OLD_ORIGIN=${OLD_ORIGIN:-$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["site"]["home"] or "")' "$WORK/report.json")}
SITEURL=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["site"]["siteurl"] or "")' "$WORK/report.json")
[ "${SITEURL%/}" = "${OLD_ORIGIN%/}" ] || { echo "siteurl ($SITEURL) is not home ($OLD_ORIGIN): WordPress in a subdirectory is not supported" >&2; exit 1; }
OLD_ORIGIN=${OLD_ORIGIN%/}
python3 "$IMP/search-replace.py" "$WORK/site.sqlite" "$OLD_ORIGIN" "$NEW_ORIGIN" ${DRY_RUN:+--dry-run} | tee "$WORK/replace.json"

# 4. The theme and plugins must be in the build: the import does not add them.
# This reads the local build (spikes/b2-wordpress/build), so build what you deployed.
python3 - "$WORK/report.json" "$APP/build/wordpress/wp-content" <<'PY'
import json, os, sys
r = json.load(open(sys.argv[1]))["site"]
wc = sys.argv[2]
missing = [f"theme {t}" for t in {r["template"], r["stylesheet"]} if t and not os.path.isdir(os.path.join(wc, "themes", t))]
missing += [f"plugin {p}" for p in (r["active_plugins"] or []) if not os.path.exists(os.path.join(wc, "plugins", p))]
if missing:
    print("NOT IN THE BUILD (the site will not look or work the same): " + ", ".join(missing))
    print("Add plugins with PLUGINS=... (tests/plugins/suite.txt) and deploy again, or import anyway with ALLOW_MISSING=1.")
    sys.exit(0 if os.environ.get("ALLOW_MISSING") == "1" else 1)
print("theme and active plugins: all in the build")
PY

[ -z "${DRY_RUN:-}" ] || { echo "DRY_RUN: stopped before the import"; exit 0; }

# 5. To a dbmove dump, then into the object. --replace drops the site's tables.
python3 "$IMP/dbmove-file.py" from-sqlite "$WORK/site.sqlite" "$WORK/site.jsonl"
python3 "$APP/dbmove.py" import "$URL" "$WORK/site.jsonl" --replace

# 6. Export again and compare the rows of each table.
python3 "$APP/dbmove.py" export "$URL" "$WORK/after.jsonl"
python3 "$IMP/dbmove-file.py" counts "$WORK/site.jsonl" > "$WORK/counts-in.json"
python3 "$IMP/dbmove-file.py" counts "$WORK/after.jsonl" > "$WORK/counts-out.json"
if diff "$WORK/counts-in.json" "$WORK/counts-out.json" >/dev/null; then
  echo "rows: every table matches ($(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["end"])' "$WORK/counts-in.json") rows)"
else
  echo "ROWS DIFFER:" >&2; diff "$WORK/counts-in.json" "$WORK/counts-out.json" >&2 || true; exit 1
fi

# 7. The home page, uncached: status and title.
code=$(curl -s -m 120 -o "$WORK/home.html" -w '%{http_code}' "$URL/?nocache=import$RANDOM")
title=$(python3 -c 'import re,sys,html; m=re.search(r"<title[^>]*>(.*?)</title>", open(sys.argv[1], encoding="utf-8", errors="replace").read(), re.S); print(html.unescape(m.group(1).strip()) if m else "")' "$WORK/home.html")
echo "GET / -> $code, title: $title"
[ "$code" = 200 ] || { echo "the home page is not 200" >&2; exit 1; }
echo "done. Log in with the source site's users. Remove $WORK when you are done: it holds the site's data."
