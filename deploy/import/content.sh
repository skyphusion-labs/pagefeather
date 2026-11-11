#!/bin/bash
# Copy the theme and plugins of an existing site into the build (issue #31).
# spikes/b2-wordpress/build.sh calls this when IMPORT_CONTENT is set.
#
#   IMPORT_THEMES="child parent" IMPORT_PLUGINS="woocommerce hello.php" \
#     content.sh <source wp-content> <build wp-content>
#   IMPORT_MU_PLUGINS="shop-cart.php shop-cart.js" \
#     content.sh --mu <source wp-content> <build wp-content>
#
# IMPORT_THEMES: directory names under themes/. IMPORT_PLUGINS: directory or
# file names under plugins/ (the part before the first "/" of an entry in
# active_plugins). deploy/import.sh prints both from the dump.
#
# A plugin or theme of the same name in the build is replaced: the site runs
# its own version, which matches its database. The exception is
# sqlite-database-integration: the runtime needs the build's pinned copy.
# Not copied: drop-ins (wp-content/*.php such as db.php, object-cache.php and
# advanced-cache.php: the build has its own), mu-plugins unless named, and
# uploads (deploy/import/media.sh puts them in R2).
#
# --mu copies the mu-plugins named in IMPORT_MU_PLUGINS (file or directory
# names under mu-plugins/). A mu-plugin always runs, so none is copied unless
# it is named. The build calls --mu AFTER it copies its own mu-plugins, and a
# name the build already has is refused: a site's mu-plugin never replaces one
# of the framework's (r2-uploads.php, edge-cache.php and the rest).
# Refused: a name with "/" or "..", a missing name, and a symbolic link
# anywhere in a copied tree (zip follows links, so a link could put files
# from this computer into the site).
set -euo pipefail
# All output to stderr: deploy.sh keeps only the last stdout line of build.sh.
exec 1>&2
MU=0; [ "${1:-}" != --mu ] || { MU=1; shift; }
SRC=${1:?source wp-content} DST=${2:?build wp-content}
[ -d "$SRC" ] && [ -d "$DST" ] || { echo "content: no directory $SRC or $DST" >&2; exit 2; }
KEEP=sqlite-database-integration
copy() { # kind name
  local kind=$1 name=$2
  case "$name" in */*|..|.|'') echo "content: bad $kind name: '$name'" >&2; exit 1 ;; esac
  [ "$name" != "$KEEP" ] || { echo "content: $kind $name: the build copy stays"; return 0; }
  local from="$SRC/${kind}s/$name"
  [ -e "$from" ] || { echo "content: $kind $name is not in $SRC/${kind}s" >&2; exit 1; }
  if [ -n "$(find "$from" -type l | head -1)" ]; then
    echo "content: $kind $name has a symbolic link ($(find "$from" -type l | head -1)); refused" >&2; exit 1
  fi
  local to="$DST/${kind}s/$name" was=new
  [ ! -e "$to" ] || was=replaced
  rm -rf "${to:?}"
  cp -R "$from" "$to"
  echo "content: $kind $name ($was, $(du -sk "$to" | cut -f1) KiB)"
}
if [ "$MU" = 1 ]; then
  for m in ${IMPORT_MU_PLUGINS:-}; do
    case "$m" in */*|..|.|'') echo "content: bad mu-plugin name: '$m'" >&2; exit 1 ;; esac
    from="$SRC/mu-plugins/$m"
    [ -e "$from" ] || { echo "content: mu-plugin $m is not in $SRC/mu-plugins" >&2; exit 1; }
    if [ -n "$(find "$from" -type l | head -1)" ]; then
      echo "content: mu-plugin $m has a symbolic link ($(find "$from" -type l | head -1)); refused" >&2; exit 1
    fi
    [ ! -e "$DST/mu-plugins/$m" ] || { echo "content: mu-plugin $m: the build has its own of that name; refused" >&2; exit 1; }
    mkdir -p "$DST/mu-plugins"
    cp -R "$from" "$DST/mu-plugins/$m"
    echo "content: mu-plugin $m (new, $(du -sk "$DST/mu-plugins/$m" | cut -f1) KiB)"
  done
  exit 0
fi
for t in ${IMPORT_THEMES:-}; do copy theme "$t"; done
for p in ${IMPORT_PLUGINS:-}; do copy plugin "$p"; done
mu=$( [ -d "$SRC/mu-plugins" ] && cd "$SRC/mu-plugins" && find . -mindepth 1 -maxdepth 1 | sed 's|^\./||' | sort | tr '\n' ' ' || true)
[ -z "$mu" ] || echo "content: mu-plugins in the source, NOT copied unless named in IMPORT_MU_PLUGINS (check if the site needs them): $mu"
dropins=$(cd "$SRC" && find . -maxdepth 1 -type f -name '*.php' ! -name index.php | sed 's|^\./||' | tr '\n' ' ')
[ -z "$dropins" ] || echo "content: drop-ins in the source, NOT copied (the build has its own): $dropins"
