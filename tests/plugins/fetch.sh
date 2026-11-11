#!/bin/bash
# Put plugins from tests/plugins/suite.txt into a WordPress plugins directory.
# Usage: fetch.sh <plugins-dir> [slug ...]   (no slug: all of the suite)
# SUITE=<file> reads another list beside this script (default suite.txt; seo.txt is #279).
# Each zip is checked against the SHA-256 pinned in suite.txt.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
dest=$1; shift
cache=$here/../../spikes/b2-wordpress/build/cache/plugins
mkdir -p "$cache" "$dest"
want=" $* "
while read -r slug ver sha _; do
  case $slug in \#*|'') continue ;; esac
  [ $# -eq 0 ] || [[ $want == *" $slug "* ]] || continue
  z=$cache/$slug-$ver.zip
  # Some plugins have no zip for their current version (no tag): duplicate-page
  # 4.5.9 answered 404 at <slug>.<ver>.zip and is at <slug>.zip (2026-11-05).
  # The SHA-256 check below refuses the fallback once the plugin moves on.
  [ -f "$z" ] || curl -sfL "https://downloads.wordpress.org/plugin/$slug.$ver.zip" -o "$z" \
    || curl -sfL "https://downloads.wordpress.org/plugin/$slug.zip" -o "$z"
  echo "$sha  $z" | shasum -a 256 -c - >/dev/null
  rm -rf "${dest:?}/$slug"
  unzip -q "$z" -d "$dest"
done < "$here/${SUITE:-suite.txt}"
