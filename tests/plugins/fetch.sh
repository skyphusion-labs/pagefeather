#!/bin/bash
# Put plugins from tests/plugins/suite.txt into a WordPress plugins directory.
# Usage: fetch.sh <plugins-dir> [slug ...]   (no slug: all of the suite)
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
  [ -f "$z" ] || curl -sfL "https://downloads.wordpress.org/plugin/$slug.$ver.zip" -o "$z"
  echo "$sha  $z" | shasum -a 256 -c - >/dev/null
  rm -rf "${dest:?}/$slug"
  unzip -q "$z" -d "$dest"
done < "$here/suite.txt"
