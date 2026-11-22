#!/bin/bash
# Test prepare-content.sh against stub upstream repos (no network). The happy path ends in the
# REAL deploy/import/content.sh, so the printed line is checked against the build contract.
#   tests/conformance/prepare-content-test.sh
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
P=${PREPARE:-$here/prepare-content.sh}
t=$(mktemp -d "${TMPDIR:-/tmp}/conf-prep.XXXXXX")
# prepare-content.sh prints the path from pwd, which collapses a trailing slash on TMPDIR.
t=$(cd "$t" && pwd)
trap 'rm -rf "$t"' EXIT
fails=0
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fails=$((fails + 1)); }
expect_refused() { # label, the reason (an ERE the stderr must match), then the command.
  # The reason matters: a refusal for ANOTHER reason (an earlier guard, git, set -e) is a FAIL.
  local label=$1 why=$2; shift 2
  if "$@" >"$t/o" 2>"$t/e"; then bad "$label: exit 0, expected a refusal"
  elif grep -qE "$why" "$t/e"; then ok "$label: refused ($(grep -E "$why" "$t/e" | head -1))"
  else bad "$label: refused for another reason: $(head -1 "$t/e")"; fi
}
git_q() { git -c core.hooksPath=/dev/null -c user.name=stub -c user.email=stub@example.invalid -c init.defaultBranch=main "$@"; }
stub_repo() { # dir: an upstream repo that serves any sha and partial clones
  git_q init -q "$1"
  git -C "$1" config uploadpack.allowAnySHA1InWant true
  git -C "$1" config uploadpack.allowFilter true
}
commit() { git_q -C "$1" add -A && git_q -C "$1" commit -qm stub && git -C "$1" rev-parse HEAD; }

# A stub WooCommerce repo.
wc=$t/wc; stub_repo "$wc"
tp=$wc/plugins/woocommerce/tests/e2e/test-plugins
for p in woocommerce-e2e-test-helper woocommerce-cleanup wc-email-template-sync-test-helper; do mkdir -p "$tp/$p"; echo "<?php /* Plugin Name: $p */" > "$tp/$p/$p.php"; done
mkdir -p "$tp/blocks"; echo "<?php // not taken" > "$tp/blocks/x.php"
tt=$wc/plugins/woocommerce/tests/e2e/themes/blocks
wc_themes="emptytheme theme-with-woo-templates storefront-child__block-notices-filter storefront-child__block-notices-template storefront-child__classic-notices-template storefront-child__with-block-template-part storefront-child__with-block-template-part-support twentytwentyfour-child__block-notices-filter twentytwentyfour-child__block-notices-template twentytwentyfour-child__classic-notices-template"
for th in $wc_themes; do mkdir -p "$tt/$th"; echo "/* Theme Name: wc $th */" > "$tt/$th/style.css"; done
echo outside > "$wc/README.md"
wc_sha=$(commit "$wc")
# A second commit, so the pin is not simply the tip.
echo later > "$wc/later.txt"; commit "$wc" >/dev/null

# A stub Gutenberg repo.
gb=$t/gb; stub_repo "$gb"
mkdir -p "$gb/packages/e2e-tests/plugins/assets" "$gb/packages/e2e-tests/mu-plugins" "$gb/test/emptytheme" "$gb/test/gutenberg-test-themes/darktheme"
echo "<?php /* Plugin Name: Gutenberg Test Plugin, Disables the CSS animations */" > "$gb/packages/e2e-tests/plugins/disables-the-css-animations.php"
echo "x" > "$gb/packages/e2e-tests/plugins/assets/a.js"
echo "<?php" > "$gb/packages/e2e-tests/mu-plugins/nocache-headers.php"
echo "<?php" > "$gb/packages/e2e-tests/mu-plugins/server-timing.php"
echo "/* Theme Name: Empty */" > "$gb/test/emptytheme/style.css"
echo "/* Theme Name: Dark */" > "$gb/test/gutenberg-test-themes/darktheme/style.css"
gb_sha=$(commit "$gb")

export WC_REPO=file://$wc WC_SHA=$wc_sha GB_REPO=file://$gb GB_SHA=$gb_sha

# 1. The happy path: wc and gb.
if line=$("$P" "$t/out" wc gb 2>"$t/e"); then ok "wc gb: exit 0"; else bad "wc gb: exit non-zero ($(cat "$t/e"))"; fi
c=$t/out/wp-content
for f in plugins/woocommerce-e2e-test-helper/woocommerce-e2e-test-helper.php plugins/woocommerce-cleanup/woocommerce-cleanup.php \
  plugins/wc-email-template-sync-test-helper/wc-email-template-sync-test-helper.php \
  plugins/gutenberg-test-plugins/disables-the-css-animations.php plugins/gutenberg-test-plugins/assets/a.js \
  themes/emptytheme/style.css themes/gutenberg-test-themes/darktheme/style.css mu-plugins/nocache-headers.php mu-plugins/server-timing.php \
  mu-plugins/pf-conformance-throwaway.php mu-plugins/pf-conformance-gaps.php; do
  [ -f "$c/$f" ] && ok "laid out: $f" || bad "missing: $f"
done
[ ! -e "$c/plugins/blocks" ] && ok "a helper not asked for is not taken (blocks)" || bad "blocks was taken"
for th in $wc_themes; do
  [ "$th" = emptytheme ] && continue
  [ -f "$c/themes/$th/style.css" ] && ok "wc test theme laid out: $th" || bad "wc test theme missing: $th"
done
grep -q "Theme Name: Empty" "$c/themes/emptytheme/style.css" && [ ! -e "$c/themes/emptytheme/emptytheme" ] \
  && ok "wc gb: emptytheme is Gutenberg's, not nested" || bad "wc gb: emptytheme is not Gutenberg's alone"
grep -q "themes/emptytheme: woocommerce's not taken" "$t/out/PINS" && ok "PINS records the emptytheme choice" || bad "PINS lacks the emptytheme choice"
[ ! -e "$t/out/src" ] && ok "the checkouts are removed" || bad "out/src is left behind"
grep -q "^woocommerce file://$wc $wc_sha$" "$t/out/PINS" && ok "PINS records the woocommerce pin" || bad "PINS lacks the woocommerce pin"
grep -q "^gutenberg file://$gb $gb_sha$" "$t/out/PINS" && ok "PINS records the gutenberg pin" || bad "PINS lacks the gutenberg pin"
tree=$(git -C "$gb" rev-parse "$gb_sha:packages/e2e-tests/plugins")
grep -q "plugins/gutenberg-test-plugins = gutenberg:packages/e2e-tests/plugins $tree" "$t/out/PINS" && ok "PINS records the upstream tree id" || bad "PINS lacks the tree id"
for want in "IMPORT_CONTENT=$t/out/wp-content" "IMPORT_THEMES='theme-with-woo-templates storefront-child__block-notices-filter storefront-child__block-notices-template storefront-child__classic-notices-template storefront-child__with-block-template-part storefront-child__with-block-template-part-support twentytwentyfour-child__block-notices-filter twentytwentyfour-child__block-notices-template twentytwentyfour-child__classic-notices-template emptytheme gutenberg-test-themes'" \
  "IMPORT_PLUGINS='woocommerce-e2e-test-helper woocommerce-cleanup wc-email-template-sync-test-helper gutenberg-test-plugins'" \
  "IMPORT_MU_PLUGINS='pf-conformance-throwaway.php pf-conformance-gaps.php nocache-headers.php server-timing.php'" "THEMES='twentytwentythree storefront twentytwenty twentytwentytwo twentytwentyfour twentytwentyone'" \
  "SUITE=$here/plugins.txt PLUGINS='wp-mail-logging'" "THEME_SUITE=$here/themes.txt "; do
  case "$line" in *"$want"*) ok "line has: $want" ;; *) bad "line lacks: $want (line: $line)" ;; esac
done
[ "$(printf '%s\n' "$line" | wc -l | tr -d ' ')" = 1 ] && ok "stdout is one line" || bad "stdout is not one line"

# 2. The line works with the REAL content.sh (the build calls it the same way).
mkdir -p "$t/build/wp-content/plugins" "$t/build/wp-content/themes" "$t/build/wp-content/mu-plugins"
if ( eval "export $line"; "$root/deploy/import/content.sh" "$IMPORT_CONTENT" "$t/build/wp-content" && \
     "$root/deploy/import/content.sh" --mu "$IMPORT_CONTENT" "$t/build/wp-content" ) >"$t/o" 2>&1; then
  ok "content.sh accepts the line"
else bad "content.sh refused the line: $(tail -2 "$t/o")"; fi
[ -f "$t/build/wp-content/plugins/gutenberg-test-plugins/disables-the-css-animations.php" ] && [ -f "$t/build/wp-content/mu-plugins/server-timing.php" ] \
  && [ -f "$t/build/wp-content/themes/emptytheme/style.css" ] && ok "content.sh copied plugins, mu-plugins and themes" || bad "content.sh did not copy everything"

# 3. wp only: no git at all, one theme.
if line=$(WC_REPO=file:///nonexistent GB_REPO=file:///nonexistent "$P" "$t/wp" wp 2>"$t/e"); then
  [ "$line" = "IMPORT_CONTENT=$t/wp/wp-content IMPORT_MU_PLUGINS='pf-conformance-throwaway.php pf-conformance-gaps.php' THEME_SUITE=$here/themes-wp.txt THEMES='twentytwentyone'" ] && ok "wp only: the line is exact" || bad "wp only: line is '$line'"
else bad "wp only: exit non-zero ($(cat "$t/e"))"; fi

# 3b. wc only: WooCommerce's emptytheme is taken.
if line=$(GB_REPO=file:///nonexistent "$P" "$t/wconly" wc 2>"$t/e"); then
  grep -q "Theme Name: wc emptytheme" "$t/wconly/wp-content/themes/emptytheme/style.css" && ok "wc only: emptytheme is WooCommerce's" || bad "wc only: emptytheme is not WooCommerce's"
  case "$line" in *"IMPORT_THEMES='emptytheme theme-with-woo-templates "*) ok "wc only: IMPORT_THEMES starts with emptytheme" ;; *) bad "wc only: line is '$line'" ;; esac
else bad "wc only: exit non-zero ($(cat "$t/e"))"; fi

# 3c. gb only: the widgets specs activate twentytwenty, which the release zip lacks.
if line=$(WC_REPO=file:///nonexistent "$P" "$t/gbonly" gb 2>"$t/e"); then
  case "$line" in *"THEMES='twentytwentyone twentytwentythree twentytwentyfour twentytwenty'"*) ok "gb only: THEMES has twentytwenty" ;; *) bad "gb only: line is '$line'" ;; esac
  case "$line" in *"THEME_SUITE=$here/themes.txt "*) ok "gb only: THEME_SUITE is themes.txt" ;; *) bad "gb only: THEME_SUITE is not themes.txt (line: $line)" ;; esac
else bad "gb only: exit non-zero ($(cat "$t/e"))"; fi

# 3d. Per-suite Twenty Twenty-One (#1335). fetch.sh --themes reads one file, THEME_SUITE.
# prepare-content.sh picks it. The wp file pins the version wordpress-develop bundles at
# WP_DEVELOP_SHA (style.css Version: 2.9). The gb file keeps 2.1, the zip Gutenberg mounts.
# A build that names wp and not gb selects the wp file. A build that names gb and not wp
# keeps themes.txt. A build that names both stops before any install: one slug, one copy.
# The other slugs match, so only this version moves.
WP_TT1='twentytwentyone 2.9 51d4ac1dcaef18b0e35a1a313bce8115d3aa4ff315bb1143f95c223c38817d8b'
GB_TT1='twentytwentyone 2.1 5b2e99b6e93a529fe4ae243752089ed1d26f6b70af8b289603b87ce1472a5f01'
pin_line() { grep -E '^twentytwentyone ' "$1" 2>/dev/null || true; }
other_pins() { grep -E '^[a-z0-9]' "$1" | grep -v '^twentytwentyone '; }
[ "$(pin_line "$here/themes-wp.txt")" = "$WP_TT1" ] && ok "themes-wp.txt pins Twenty Twenty-One 2.9 and its zip sha256" || bad "themes-wp.txt pin is '$(pin_line "$here/themes-wp.txt")'"
[ "$(pin_line "$here/themes.txt")" = "$GB_TT1" ] && ok "themes.txt pins Twenty Twenty-One 2.1" || bad "themes.txt pin is '$(pin_line "$here/themes.txt")'"
if [ -f "$here/themes-wp.txt" ] && diff -q <(other_pins "$here/themes.txt") <(other_pins "$here/themes-wp.txt") >/dev/null; then
  ok "themes-wp.txt matches themes.txt on every slug but twentytwentyone"
else
  bad "themes-wp.txt drifted from themes.txt beyond twentytwentyone"
fi
# Both wp and gb: one site holds one copy of twentytwentyone, so the build stops
# before anything is installed (#1335).
expect_refused "wp and gb together" 'wp and gb need different Twenty Twenty-One versions \(2\.9 and 2\.1, #1335\): prepare each suite on its own' \
  "$P" "$t/wpgb" wp gb
[ ! -e "$t/wpgb" ] && ok "wp and gb: nothing was installed" || bad "wp and gb: $t/wpgb was created"
if line=$(GB_REPO=file:///nonexistent "$P" "$t/wpwc" wp wc 2>"$t/e"); then
  case "$line" in *"THEME_SUITE=$here/themes-wp.txt "*) ok "wp wc: THEME_SUITE is themes-wp.txt" ;; *) bad "wp wc: line is '$line'" ;; esac
else bad "wp wc: exit non-zero ($(cat "$t/e"))"; fi

# 4. Refusals.
expect_refused "an existing out dir" "exists; refused" "$P" "$t/out" wc
expect_refused "no suite" "name at least one suite" "$P" "$t/n1"
expect_refused "an unknown suite" "unknown suite .woo." "$P" "$t/n2" wp woo
expect_refused "a short sha" "is not a full sha" env WC_SHA="${wc_sha:0:12}" "$P" "$t/n3" wc
expect_refused "a sha the repo lacks" "not our ref" env WC_SHA=0123456789abcdef0123456789abcdef01234567 "$P" "$t/n4" wc
git_q -C "$wc" rm -q -r plugins/woocommerce/tests/e2e/test-plugins/woocommerce-cleanup && no_cleanup=$(commit "$wc")
expect_refused "a missing upstream path" "has no .*woocommerce-cleanup at the pin" env WC_SHA="$no_cleanup" "$P" "$t/n5" wc
# Restore the cleanup plugin first, so the ONLY defect of this commit is the link.
git_q -C "$wc" checkout -q "$wc_sha" -- plugins/woocommerce/tests/e2e/test-plugins/woocommerce-cleanup
ln -s /etc "$tp/woocommerce-e2e-test-helper/link" && link_sha=$(commit "$wc")
expect_refused "a symbolic link in a copied tree" "woocommerce-e2e-test-helper has a symbolic link" env WC_SHA="$link_sha" "$P" "$t/n6" wc

echo
[ "$fails" = 0 ] && { echo "PASS prepare-content-test"; exit 0; } || { echo "FAIL prepare-content-test: $fails"; exit 1; }
