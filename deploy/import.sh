#!/bin/bash
# Import an existing WordPress site's database into a deploy/ site (issue #31).
#
#   URL=https://my-site.acct.workers.dev SPIKE_TOKEN=... DUMP=site.sql ./deploy/import.sh
#   URL=... NAME=my-site DUMP=site.sql ./deploy/import.sh   (SPIKE_TOKEN from Terraform)
#
# VARIANT: b-dosql (the database is the PHP object's SQLite) or c1 (SQLite in
# the container, Litestream to R2; two phases, see deploy/import/c1.sh).
# Other variants stop with an error; see deploy/import/README.md.
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
# CONTENT (optional) is a tar archive of the source's wp-content. With it, the
# script prints the deploy.sh line that builds the site's theme and active
# plugins in (IMPORT_CONTENT, IMPORT_THEMES, IMPORT_PLUGINS), and puts
# wp-content/uploads into the site's R2 media bucket (MEDIA=1 site; needs NAME,
# CLOUDFLARE_API_TOKEN and ACCOUNT_ID for the short-lived R2 key).
#
# Options: OLD_ORIGIN (default: the home option of the dump), DRY_RUN=1 (stop
# before the import; print what would change), SKIP_MEDIA=1 (do not send the
# uploads; the script says that the images are missing).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP="$ROOT/spikes/b2-wordpress"
IMP="$ROOT/deploy/import"
VARIANT=${VARIANT:-b-dosql}
: "${DUMP:?set DUMP to the mysqldump file}"
[ -r "$DUMP" ] || { echo "cannot read DUMP=$DUMP" >&2; exit 2; }
case "$VARIANT" in b-dosql|c1) ;; *) echo "VARIANT=$VARIANT: import supports b-dosql and c1 (deploy/import/README.md)" >&2; exit 2 ;; esac

: "${URL:?set URL to the site address that deploy.sh printed}"
# Terraform state of the site, as deploy.sh keeps it (DEPLOY_STATE; tf-backend.sh).
TF="$ROOT/deploy/terraform"
# shellcheck source=SCRIPTDIR/tf-backend.sh
. "$ROOT/deploy/tf-backend.sh"
TF_READY=""
tf_ready() { [ -n "$TF_READY" ] || { site_state "$TF" && TF_READY=1; }; }
tfi() { (cd "$TF" && terraform workspace select "$NAME" >/dev/null && terraform "$@"); }
if [ -z "${SPIKE_TOKEN:-}" ] && [ -n "${NAME:-}" ]; then
  tf_ready || exit 1
  SPIKE_TOKEN=$(tfi output -raw spike_token)
fi
: "${SPIKE_TOKEN:?set SPIKE_TOKEN}"
export SPIKE_TOKEN
NEW_ORIGIN=$(python3 -c 'import sys,urllib.parse as u; p=u.urlsplit(sys.argv[1]); print(f"{p.scheme}://{p.netloc}")' "$URL")
URL=$NEW_ORIGIN

WORK=${WORK:-${TMPDIR:-/tmp}/wp-import-$(date -u +%Y%m%dT%H%M%SZ)}
mkdir -p "$WORK"; chmod 700 "$WORK"
echo "work files: $WORK"
# c1, phase 2: the seed phase made the files in WORK; only the check runs.
if [ "$VARIANT" = c1 ] && [ -n "${VERIFY:-}" ]; then
  # shellcheck source=SCRIPTDIR/import/c1.sh
  . "$IMP/c1.sh"
  code=$(curl -s -m 120 -A wp-on-cf-import/1 -o /dev/null -w '%{http_code}' "$URL/?nocache=import$RANDOM")
  echo "GET / -> $code"; [ "$code" = 200 ] || { echo "the home page is not 200" >&2; exit 1; }
  exit 0
fi

# 1. The driver at the ref the build uses, so its _wp_sqlite_* tables match.
REF=$(sed -n 's/^SQLITE_DI_REF=//p' "$APP/build.sh")
if [ "$VARIANT" = c1 ]; then
  C1REF=$(sed -n 's/^SQLITE_DI_REF=//p' "$ROOT/spikes/c1-woo-container/build.sh")
  [ "$C1REF" = "$REF" ] || { echo "c1 pins SQLITE_DI_REF=$C1REF, b2 pins $REF: the seed must be made with c1's ref" >&2; exit 1; }
fi
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

# c1: the seed phase (deploy/import/c1.sh) exits here.
# shellcheck source=SCRIPTDIR/import/c1.sh
[ "$VARIANT" != c1 ] || . "$IMP/c1.sh"

# 4. The theme and plugins must be in the build: the import does not add them.
# This reads the local build (spikes/b2-wordpress/build), so build what you
# deployed. With CONTENT (a wp-content archive), the archive is extracted and
# the deploy.sh line that builds the theme and plugins in is printed.
SRC_CONTENT=""
if [ -n "${CONTENT:-}" ]; then
  python3 -I "$IMP/untar.py" "$CONTENT" "$WORK/content"
  SRC_CONTENT="$WORK/content/wp-content"
fi
python3 - "$WORK/report.json" "$APP/build/wordpress/wp-content" "$SRC_CONTENT" <<'PY'
import json, os, shlex, sys
r = json.load(open(sys.argv[1]))["site"]
wc, src = sys.argv[2], sys.argv[3]
themes = sorted({t for t in (r["template"], r["stylesheet"]) if t})
plugins = r["active_plugins"] or []
names = sorted({p.split("/", 1)[0] for p in plugins})
missing = [f"theme {t}" for t in themes if not os.path.isdir(os.path.join(wc, "themes", t))]
missing += [f"plugin {p}" for p in plugins if not os.path.exists(os.path.join(wc, "plugins", p))]
if src:
    absent = [f"theme {t}" for t in themes if not os.path.isdir(os.path.join(src, "themes", t))]
    absent += [f"plugin {p}" for p in plugins if not os.path.exists(os.path.join(src, "plugins", p))]
    if absent:
        print("NOT IN THE ARCHIVE either: " + ", ".join(absent))
    # Only what the archive has: content.sh refuses a name it cannot find.
    t_in = [t for t in themes if os.path.isdir(os.path.join(src, "themes", t))]
    p_in = [n for n in names if n != "sqlite-database-integration" and os.path.exists(os.path.join(src, "plugins", n))]
    line = f"IMPORT_CONTENT={shlex.quote(src)} IMPORT_THEMES={shlex.quote(' '.join(t_in))} IMPORT_PLUGINS={shlex.quote(' '.join(p_in))}"
    print("to build the site's theme and plugins in, deploy with: " + line + " ./deploy/deploy.sh")
if missing:
    print("NOT IN THE BUILD (the site will not look or work the same): " + ", ".join(missing))
    print("Deploy again with the line above (CONTENT=...), or add plugins with PLUGINS=... (tests/plugins/suite.txt), or import anyway with ALLOW_MISSING=1.")
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

# 6b. Uploads, with CONTENT: into the media bucket through the S3 API, with a
# key that Terraform makes for this step and deletes after it (media-import.tf).
if [ -n "$SRC_CONTENT" ] && [ -d "$SRC_CONTENT/uploads" ] && [ -n "${SKIP_MEDIA:-}" ]; then
  echo "media: SKIP_MEDIA is set: the uploads are NOT in R2, so the site's images are missing"
elif [ -n "$SRC_CONTENT" ] && [ -d "$SRC_CONTENT/uploads" ]; then
  : "${NAME:?set NAME (the Terraform workspace of deploy.sh) to put the uploads in R2, or SKIP_MEDIA=1}"
  : "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}" "${ACCOUNT_ID:?set ACCOUNT_ID}"
  export CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID
  tf_ready || exit 1
  BUCKET=$(tfi output -raw media_bucket)
  [ -n "$BUCKET" ] || { echo "$NAME has no media bucket: deploy it with MEDIA=1" >&2; exit 1; }
  # The variables of the site: deploy.sh's file in the clone that deployed it,
  # or else the same values read from the state's outputs (a clone with
  # DEPLOY_STATE=r2). The applies target the import key only, so no other
  # resource of the site can change here.
  VARS="$TF/sites/$NAME.tfvars"
  if [ ! -f "$VARS" ]; then
    VARS="$WORK/site.tfvars"
    printf 'account_id = "%s"\nname = "%s"\nvariant = "%s"\nlocation = "%s"\nmedia = true\n' \
      "$(tfi output -raw account_id)" "$(tfi output -raw name)" "$(tfi output -raw variant)" "$(tfi output -raw location)" > "$VARS"
    echo "media: no sites/$NAME.tfvars in this clone; using the values in the state"
  fi
  key_apply() { tfi apply -input=false -auto-approve -var-file="$VARS" -target=cloudflare_account_token.media_import -var "media_import=$1" >/dev/null; }
  key_off() { key_apply false && echo "media: import key deleted"; }
  trap 'key_off || echo "media: DELETE THE KEY: cd deploy/terraform && terraform apply -var-file=$VARS -target=cloudflare_account_token.media_import -var media_import=false" >&2' EXIT
  key_apply true
  R2_KEY_ID=$(tfi output -raw media_import_access_key_id)
  R2_SECRET=$(tfi output -raw media_import_secret_access_key)
  export R2_KEY_ID R2_SECRET
  EP=$(tfi output -raw r2_endpoint)
  "$IMP/media.sh" "$EP" "$BUCKET" "$SRC_CONTENT"
  # The second run is the check: every file is there with its size.
  "$IMP/media.sh" "$EP" "$BUCKET" "$SRC_CONTENT" | tee "$WORK/media-check.txt"
  grep -q '^media: 0 sent, [0-9]* already there, 0 failed$' "$WORK/media-check.txt" || { echo "media: the check run sent files again" >&2; exit 1; }
  unset R2_KEY_ID R2_SECRET
  key_off; trap - EXIT
fi

# 7. The home page, uncached: status and title.
code=$(curl -s -m 120 -A wp-on-cf-import/1 -o "$WORK/home.html" -w '%{http_code}' "$URL/?nocache=import$RANDOM")
title=$(python3 -c 'import re,sys,html; m=re.search(r"<title[^>]*>(.*?)</title>", open(sys.argv[1], encoding="utf-8", errors="replace").read(), re.S); print(html.unescape(m.group(1).strip()) if m else "")' "$WORK/home.html")
echo "GET / -> $code, title: $title"
[ "$code" = 200 ] || { echo "the home page is not 200" >&2; exit 1; }
echo "done. Log in with the source site's users. Remove $WORK when you are done: it holds the site's data."
