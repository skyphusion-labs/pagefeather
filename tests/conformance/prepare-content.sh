#!/bin/bash
# Build the extra content of a conformance throwaway site (#759) from the pinned upstream repos.
#
#   prepare-content.sh <out-dir> <suite> [suite ...]     suites: wp wc gb
#
# It writes <out-dir>/wp-content (with the throwaway marker mu-plugin) and <out-dir>/PINS, then prints ONE line on stdout: the
# variables for spikes/b2-wordpress/build.sh (IMPORT_CONTENT and the rest). Never for a real
# site: the WooCommerce cleanup plugin deletes the whole store, and both upstream suites delete
# all posts.
#
#   wp  the WordPress suite (wordpress-develop tests/e2e): the theme twentytwentyone.
#   wc  the WooCommerce suite (plugins/woocommerce/tests/e2e): the themes twentytwentythree, storefront, twentytwenty,
#       twentytwentytwo, twentytwentyfour and the test themes of tests/e2e/themes/blocks (as .wp-env.e2e.json mounts
#       them, #937; with gb, Gutenberg's emptytheme is kept), the
#       plugins woocommerce-e2e-test-helper, woocommerce-cleanup, and
#       wc-email-template-sync-test-helper (from WC_SHA; the upstream external setup takes them
#       from trunk, which is not pinned), and wp-mail-logging.
#   gb  the Gutenberg suite (test/e2e): twentytwentyone, twentytwentythree, twentytwentyfour, the
#       test plugins (one plugin directory, gutenberg-test-plugins, as upstream mounts it), the
#       test themes emptytheme and gutenberg-test-themes, and the e2e mu-plugins.
#
# Each repo is fetched at its full commit sha (pins.env) with a sparse checkout: git checks every
# object, so the content is the pinned content. Refused (non-zero exit): an <out-dir> that exists,
# an unknown suite, a checkout whose HEAD is not the pin, a missing upstream path, and a symbolic
# link in any copied tree (content.sh refuses them too). WC_REPO, GB_REPO and the shas can be set
# in the environment (the test points them at stub repos).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# The environment wins over pins.env, so a test can point at a stub repo.
env_wc_repo=${WC_REPO:-} env_wc_sha=${WC_SHA:-} env_gb_repo=${GB_REPO:-} env_gb_sha=${GB_SHA:-}
. "$here/pins.env"
WC_REPO=${env_wc_repo:-$WC_REPO} WC_SHA=${env_wc_sha:-$WC_SHA}
GB_REPO=${env_gb_repo:-$GB_REPO} GB_SHA=${env_gb_sha:-$GB_SHA}
out=${1:?usage: prepare-content.sh <out-dir> <suite> [suite ...]}; shift
[ $# -gt 0 ] || { echo "prepare: name at least one suite (wp wc gb)" >&2; exit 2; }
[ ! -e "$out" ] || { echo "prepare: $out exists; refused (use a new directory)" >&2; exit 2; }
want_wp=0 want_wc=0 want_gb=0
for s in "$@"; do
  case "$s" in wp) want_wp=1 ;; wc) want_wc=1 ;; gb) want_gb=1 ;;
    *) echo "prepare: unknown suite '$s' (wp wc gb)" >&2; exit 2 ;; esac
done
mkdir -p "$out/wp-content/plugins" "$out/wp-content/themes" "$out/wp-content/mu-plugins" "$out/src"
out=$(cd "$out" && pwd)
: > "$out/PINS"

# fetch <name> <repo> <sha> <path ...>: a sparse, shallow checkout of <sha> in $out/src/<name>.
fetch() {
  local name=$1 repo=$2 sha=$3; shift 3
  local d="$out/src/$name"
  case "$sha" in *[!0-9a-f]*|'') echo "prepare: $name: the pin '$sha' is not a full sha" >&2; exit 1 ;; esac
  [ ${#sha} = 40 ] || { echo "prepare: $name: the pin '$sha' is not a full sha" >&2; exit 1; }
  git init -q "$d"
  git -C "$d" remote add origin "$repo"
  git -C "$d" sparse-checkout set --no-cone "$@" >/dev/null
  git -C "$d" fetch -q --depth 1 --filter=blob:none origin "$sha"
  git -C "$d" checkout -q FETCH_HEAD
  local head; head=$(git -C "$d" rev-parse HEAD)
  [ "$head" = "$sha" ] || { echo "prepare: $name: HEAD is $head, not the pin $sha; refused" >&2; exit 1; }
  echo "$name $repo $sha" >> "$out/PINS"
}
# take <name> <path in repo> <kind dir> <dest name>: copy one upstream tree or file into wp-content.
take() {
  local name=$1 path=$2 kind=$3 dest=$4
  local from="$out/src/$name/$path"
  [ -e "$from" ] || { echo "prepare: $name has no $path at the pin; refused" >&2; exit 1; }
  if [ -n "$(find "$from" -type l | head -1)" ]; then
    echo "prepare: $name $path has a symbolic link; refused" >&2; exit 1
  fi
  cp -R "$from" "$out/wp-content/$kind/$dest"
  # The tree (or blob) id: the exact upstream content, for the record.
  echo "  $kind/$dest = $name:$path $(git -C "$out/src/$name" rev-parse "HEAD:$path")" >> "$out/PINS"
}

themes="" plugins="" imp_themes="" imp_plugins="" imp_mu=""
# add <variable> <word>: append the word once.
add() { local cur=${!1}; case " $cur " in *" $2 "*) return 0 ;; esac; printf -v "$1" '%s' "${cur:+$cur }$2"; }
# The throwaway marker (php/pf-conformance-throwaway.php), for every suite: runner.py refuses a
# site without it, because the suites delete all content.
cp "$here/php/pf-conformance-throwaway.php" "$out/wp-content/mu-plugins/"
add imp_mu pf-conformance-throwaway.php
# The gap tests (php/pf-conformance-gaps.php, gaps.py), for every suite: our stand-in for upstream specs that
# write files on the runner's disk. It acts only on its own trigger, and only beside the marker above.
cp "$here/php/pf-conformance-gaps.php" "$out/wp-content/mu-plugins/"
add imp_mu pf-conformance-gaps.php
[ "$want_wp" = 0 ] || add themes twentytwentyone
if [ "$want_wc" = 1 ]; then
  add themes twentytwentythree
  add plugins wp-mail-logging
  tp=plugins/woocommerce/tests/e2e/test-plugins
  # The themes the WooCommerce e2e environment mounts (.wp-env.e2e.json at WC_SHA, #937): three from wordpress.org
  # (themes.txt) plus twentytwentyfour, and the test themes from tests/e2e/themes/blocks.
  add themes storefront; add themes twentytwenty; add themes twentytwentytwo; add themes twentytwentyfour
  tt=plugins/woocommerce/tests/e2e/themes/blocks
  fetch woocommerce "$WC_REPO" "$WC_SHA" "/$tp/woocommerce-e2e-test-helper/" "/$tp/woocommerce-cleanup/" "/$tp/wc-email-template-sync-test-helper/" "/$tt/"
  for p in woocommerce-e2e-test-helper woocommerce-cleanup wc-email-template-sync-test-helper; do
    take woocommerce "$tp/$p" plugins "$p"
    [ -f "$out/wp-content/plugins/$p/$p.php" ] || { echo "prepare: $p has no $p.php; refused" >&2; exit 1; }
    add imp_plugins "$p"
  done
  for th in emptytheme theme-with-woo-templates \
      storefront-child__block-notices-filter storefront-child__block-notices-template storefront-child__classic-notices-template \
      storefront-child__with-block-template-part storefront-child__with-block-template-part-support \
      twentytwentyfour-child__block-notices-filter twentytwentyfour-child__block-notices-template twentytwentyfour-child__classic-notices-template; do
    # Gutenberg's suite has its own, different emptytheme under the same name. With gb in the build, Gutenberg's wins:
    # no WooCommerce spec at WC_SHA names emptytheme (measured 2026-11-20), and Gutenberg's specs do.
    if [ "$th" = emptytheme ] && [ "$want_gb" = 1 ]; then
      echo "  themes/emptytheme: woocommerce's not taken (gb is in this build and ships its own emptytheme)" >> "$out/PINS"
      continue
    fi
    take woocommerce "$tt/$th" themes "$th"
    [ -f "$out/wp-content/themes/$th/style.css" ] || { echo "prepare: theme $th has no style.css; refused" >&2; exit 1; }
    add imp_themes "$th"
  done
fi
if [ "$want_gb" = 1 ]; then
  add themes twentytwentyone; add themes twentytwentythree; add themes twentytwentyfour
  fetch gutenberg "$GB_REPO" "$GB_SHA" /packages/e2e-tests/plugins/ /packages/e2e-tests/mu-plugins/ /test/emptytheme/ /test/gutenberg-test-themes/
  take gutenberg packages/e2e-tests/plugins plugins gutenberg-test-plugins
  add imp_plugins gutenberg-test-plugins
  take gutenberg test/emptytheme themes emptytheme
  take gutenberg test/gutenberg-test-themes themes gutenberg-test-themes
  add imp_themes emptytheme; add imp_themes gutenberg-test-themes
  for f in "$out/src/gutenberg/packages/e2e-tests/mu-plugins"/*; do
    m=$(basename "$f")
    take gutenberg "packages/e2e-tests/mu-plugins/$m" mu-plugins "$m"
    add imp_mu "$m"
  done
fi
rm -rf "$out/src"
line="IMPORT_CONTENT=$out/wp-content"
[ -z "$imp_themes" ] || line="$line IMPORT_THEMES='$imp_themes'"
[ -z "$imp_plugins" ] || line="$line IMPORT_PLUGINS='$imp_plugins'"
[ -z "$imp_mu" ] || line="$line IMPORT_MU_PLUGINS='$imp_mu'"
[ -z "$themes" ] || line="$line THEME_SUITE=$here/themes.txt THEMES='$themes'"
[ -z "$plugins" ] || line="$line SUITE=$here/plugins.txt PLUGINS='$plugins'"
echo "$line" | tee -a "$out/PINS"
