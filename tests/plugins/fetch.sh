#!/bin/bash
# Put pinned plugins or themes from wordpress.org into a WordPress directory.
#   fetch.sh <plugins-dir> [slug ...]           plugins (no slug: every plugin of the list)
#   fetch.sh --themes <themes-dir> [slug ...]   themes (#457; no slug: every theme of the list)
# The list: SUITE=<file> for plugins (default suite.txt; seo.txt is #279, gate2-build.txt #426),
# THEME_SUITE=<file> for themes (default themes.txt). A name without "/" is a file beside this
# script; a path is read as given. Line format: slug version sha256 [anything], "#" comments.
# Each zip is checked against its pinned SHA-256. Refused (non-zero exit, so the build stops):
#   - a slug that is not in the list (#457: it was skipped with exit 0, so a mistyped PLUGINS
#     slug shipped a build without that plugin and no message);
#   - a SHA-256 mismatch;
#   - a symbolic link in an unzipped tree (zip follows links; content.sh refuses them too);
#   - a child theme whose parent (Template: in style.css) is neither fetched in this run nor
#     already in the themes directory.
# FETCH_CACHE=<dir> moves the zip cache (tests); default spikes/b2-wordpress/build/cache.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
kind=plugin
[ "${1:-}" != --themes ] || { kind=theme; shift; }
dest=${1:?usage: fetch.sh [--themes] <dir> [slug ...]}; shift
if [ "$kind" = theme ]; then list=${THEME_SUITE:-themes.txt}; else list=${SUITE:-suite.txt}; fi
case $list in */*) ;; *) list=$here/$list ;; esac
[ -f "$list" ] || { echo "fetch: no list $list" >&2; exit 2; }
cache=${FETCH_CACHE:-$here/../../spikes/b2-wordpress/build/cache}/${kind}s
mkdir -p "$cache" "$dest"
want=" $* "
found=" "
while read -r slug ver sha _; do
  case $slug in \#*|'') continue ;; esac
  [ $# -eq 0 ] || [[ $want == *" $slug "* ]] || continue
  case $slug in */*|.|..) echo "fetch: bad $kind slug in $list: $slug" >&2; exit 1 ;; esac
  z=$cache/$slug-$ver.zip
  # Some plugins have no zip for their current version (no tag): duplicate-page
  # 4.5.9 answered 404 at <slug>.<ver>.zip and is at <slug>.zip (2026-11-05).
  # The SHA-256 check below refuses the fallback once the plugin moves on.
  [ -f "$z" ] || curl -sfL "https://downloads.wordpress.org/$kind/$slug.$ver.zip" -o "$z" \
    || curl -sfL "https://downloads.wordpress.org/$kind/$slug.zip" -o "$z"
  echo "$sha  $z" | shasum -a 256 -c - >/dev/null || { echo "fetch: $kind $slug $ver: the zip does not match the pinned SHA-256; refused" >&2; exit 1; }
  rm -rf "${dest:?}/$slug"
  unzip -q "$z" -d "$dest"
  [ -d "$dest/$slug" ] || { echo "fetch: $kind $slug: the zip has no $slug/ directory; refused" >&2; exit 1; }
  if [ -n "$(find "$dest/$slug" -type l | head -1)" ]; then
    echo "fetch: $kind $slug has a symbolic link ($(find "$dest/$slug" -type l | head -1)); refused" >&2
    rm -rf "${dest:?}/$slug"; exit 1
  fi
  found="$found$slug "
  echo "fetch: $kind $slug $ver ($(du -sk "$dest/$slug" | cut -f1) KiB)" >&2
done < "$list"
missing=""
for s in "$@"; do [[ $found == *" $s "* ]] || missing="$missing $s"; done
[ -z "$missing" ] || { echo "fetch: not pinned in $list:$missing; refused (pin each one: slug version sha256)" >&2; exit 1; }
if [ "$kind" = theme ]; then
  for s in $found; do
    # As WordPress reads a header (get_file_data): any of " \t/*#@" before the key, any case,
    # and a closing "*/" is not part of the value.
    parent=$(grep -iE '^[[:space:]/*#@]*Template:' "$dest/$s/style.css" 2>/dev/null | head -1 | sed -E 's/^[^:]*:[[:space:]]*//; s/[[:space:]]*(\*\/.*)?$//' | tr -d '\r' || true)
    [ -z "$parent" ] || [ -d "$dest/$parent" ] || { echo "fetch: theme $s is a child of $parent, which is not in this build; refused (add $parent to THEMES)" >&2; exit 1; }
  done
fi
