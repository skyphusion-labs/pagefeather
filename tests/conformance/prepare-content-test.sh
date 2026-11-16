#!/bin/bash
# Test prepare-content.sh against stub upstream repos (no network). The happy path ends in the
# REAL deploy/import/content.sh, so the printed line is checked against the build contract.
#   tests/conformance/prepare-content-test.sh
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
P=${PREPARE:-$here/prepare-content.sh}
t=$(mktemp -d "${TMPDIR:-/tmp}/conf-prep.XXXXXX")
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
for p in woocommerce-e2e-test-helper woocommerce-cleanup; do mkdir -p "$tp/$p"; echo "<?php /* Plugin Name: $p */" > "$tp/$p/$p.php"; done
mkdir -p "$tp/blocks"; echo "<?php // not taken" > "$tp/blocks/x.php"
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
  plugins/gutenberg-test-plugins/disables-the-css-animations.php plugins/gutenberg-test-plugins/assets/a.js \
  themes/emptytheme/style.css themes/gutenberg-test-themes/darktheme/style.css mu-plugins/nocache-headers.php mu-plugins/server-timing.php \
  mu-plugins/pf-conformance-throwaway.php; do
  [ -f "$c/$f" ] && ok "laid out: $f" || bad "missing: $f"
done
[ ! -e "$c/plugins/blocks" ] && ok "a helper not asked for is not taken (blocks)" || bad "blocks was taken"
[ ! -e "$t/out/src" ] && ok "the checkouts are removed" || bad "out/src is left behind"
grep -q "^woocommerce file://$wc $wc_sha$" "$t/out/PINS" && ok "PINS records the woocommerce pin" || bad "PINS lacks the woocommerce pin"
grep -q "^gutenberg file://$gb $gb_sha$" "$t/out/PINS" && ok "PINS records the gutenberg pin" || bad "PINS lacks the gutenberg pin"
tree=$(git -C "$gb" rev-parse "$gb_sha:packages/e2e-tests/plugins")
grep -q "plugins/gutenberg-test-plugins = gutenberg:packages/e2e-tests/plugins $tree" "$t/out/PINS" && ok "PINS records the upstream tree id" || bad "PINS lacks the tree id"
for want in "IMPORT_CONTENT=$t/out/wp-content" "IMPORT_THEMES='emptytheme gutenberg-test-themes'" \
  "IMPORT_PLUGINS='woocommerce-e2e-test-helper woocommerce-cleanup gutenberg-test-plugins'" \
  "IMPORT_MU_PLUGINS='pf-conformance-throwaway.php nocache-headers.php server-timing.php'" "THEMES='twentytwentythree twentytwentyone twentytwentyfour'" \
  "SUITE=$here/plugins.txt PLUGINS='wp-mail-logging'" "THEME_SUITE=$here/themes.txt"; do
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
  [ "$line" = "IMPORT_CONTENT=$t/wp/wp-content IMPORT_MU_PLUGINS='pf-conformance-throwaway.php' THEME_SUITE=$here/themes.txt THEMES='twentytwentyone'" ] && ok "wp only: the line is exact" || bad "wp only: line is '$line'"
else bad "wp only: exit non-zero ($(cat "$t/e"))"; fi

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
