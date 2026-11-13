#!/bin/bash
# tests/plugins/fetch.sh offline (#457): zips made here and put in the cache, so no download.
#   bash tests/plugins/fetch-test.sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); chmod 700 "$T"; trap 'rm -rf "$T"' EXIT
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: got '$2', want '$3'"; fails=$((fails + 1)); fi; }
export FETCH_CACHE="$T/cache"
mkdir -p "$FETCH_CACHE/plugins" "$FETCH_CACHE/themes"
# mkzip <kind> <slug> <ver> [style.css text] [link]: a zip with <slug>/ in the cache; prints its SHA-256.
mkzip() {
  python3 -I - "$FETCH_CACHE/$1s/$2-$3.zip" "$2" "${4:-}" "${5:-}" <<'PY'
import hashlib, sys, zipfile
out, slug, style, link = sys.argv[1:5]
with zipfile.ZipFile(out, "w") as z:
    z.writestr(slug + "/main.php", "<?php // " + slug + "\n")
    if style:
        z.writestr(slug + "/style.css", style)
    if link:
        i = zipfile.ZipInfo(slug + "/escape")
        i.create_system = 3
        i.external_attr = (0o120777 << 16)
        z.writestr(i, "/etc/hosts")
print(hashlib.sha256(open(out, "rb").read()).hexdigest())
PY
}
P1=$(mkzip plugin good-plugin 1.0)
P2=$(mkzip plugin other-plugin 2.0)
L1=$(mkzip plugin linked-plugin 1.0 "" link)
T1=$(mkzip theme base-theme 1.0 "/* Theme Name: Base */")
T2=$(mkzip theme child-theme 1.0 "/*
Theme Name: Child
Template: base-theme
*/")
T3=$(mkzip theme orphan-child 1.0 "/* Template: not-here */")
{
  echo "# plugins"; echo "good-plugin 1.0 $P1 10"; echo "other-plugin 2.0 $P2 10"
  echo "bad-sha 1.0 0000000000000000000000000000000000000000000000000000000000000000 10"
  echo "linked-plugin 1.0 $L1 10"
} > "$T/plugins.txt"
cp "$FETCH_CACHE/plugins/good-plugin-1.0.zip" "$FETCH_CACHE/plugins/bad-sha-1.0.zip"
{ echo "base-theme 1.0 $T1"; echo "child-theme 1.0 $T2"; echo "orphan-child 1.0 $T3"; } > "$T/themes.txt"
export SUITE="$T/plugins.txt" THEME_SUITE="$T/themes.txt"
run() { local d=$1; shift; mkdir -p "$d"; bash "$HERE/fetch.sh" "$@" > "$T/out" 2>&1; echo $?; }

D=$T/p1; check "control: a pinned plugin installs" "$(run "$D" "$D" good-plugin)" 0
check "  its files are there" "$(ls "$D")" "good-plugin"
D=$T/p2; check "THE #457 CASE: a slug that is not pinned is refused (was exit 0, nothing written)" "$(run "$D" "$D" good-plugin no-such-plugin)" 1
check "  the refusal names the slug" "$(grep -c 'not pinned in .*no-such-plugin' "$T/out")" 1
D=$T/p3; check "a SHA-256 mismatch is refused" "$(run "$D" "$D" bad-sha)" 1
D=$T/p4; check "a symbolic link in the zip is refused" "$(run "$D" "$D" linked-plugin)" 1
check "  and the linked tree is removed" "$(ls -A "$D" | wc -l | tr -d ' ')" 0
D=$T/p5; check "no slug: every plugin of the list is tried (the c1 build) and the bad pins stop it" "$(run "$D" "$D")" 1
D=$T/t1; check "control: a pinned theme installs" "$(run "$D" --themes "$D" base-theme)" 0
check "  its files are there" "$(ls "$D")" "base-theme"
D=$T/t2; check "a theme that is not pinned is refused" "$(run "$D" --themes "$D" no-such-theme)" 1
D=$T/t3; check "a child theme without its parent is refused" "$(run "$D" --themes "$D" child-theme)" 1
check "  the refusal names the parent" "$(grep -c 'child of base-theme' "$T/out")" 1
D=$T/t4; check "a child theme with its parent in THEMES installs" "$(run "$D" --themes "$D" child-theme base-theme)" 0
D=$T/t5; mkdir -p "$D/base-theme"; check "a child theme whose parent is already in the build installs" "$(run "$D" --themes "$D" child-theme)" 0
D=$T/t6; check "a parent that is nowhere is refused" "$(run "$D" --themes "$D" orphan-child)" 1
D=$T/t7; check "a plugin slug is not a theme pin (the lists are separate)" "$(run "$D" --themes "$D" good-plugin)" 1
D=$T/t8; check "a missing list is refused" "$(THEME_SUITE=$T/none.txt run "$D" --themes "$D" base-theme)" 2

echo "$fails failing case(s)"
[ "$fails" = 0 ]
