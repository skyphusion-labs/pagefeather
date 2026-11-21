#!/bin/bash
# #1258: wp-cli.phar is in the site bundle only when WP_CLI_ENDPOINT=on.
# With the endpoint unset, the zip's file list and content hash match a tree
# the phar step never touched. No network. No Cloudflare.
#   spikes/b2-wordpress/tests/wp-cli-bundle-test.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails + 1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/wp-cli-bundle.XXXXXX")
trap 'rm -rf "$T"' EXIT

# A small tree with fixed mtimes, so the off path can match a build that never
# calls the phar step. The names sit where site.zip's members sit.
make_tree() {
	local d=$1
	mkdir -p "$d/wordpress/wp-content/mu-plugins" "$d/wordpress/wp-includes"
	printf '<?php echo "hi";\n' > "$d/wordpress/index.php"
	printf 'plugin\n' > "$d/wordpress/wp-content/mu-plugins/edge-cache.php"
	printf 'core\n' > "$d/wordpress/wp-includes/version.php"
	touch -t 202611211200.00 \
		"$d/wordpress" "$d/wordpress/wp-content" "$d/wordpress/wp-content/mu-plugins" \
		"$d/wordpress/wp-includes" \
		"$d/wordpress/index.php" \
		"$d/wordpress/wp-content/mu-plugins/edge-cache.php" \
		"$d/wordpress/wp-includes/version.php"
}

# File list plus sha256 of each member's bytes. Zip timestamps are not part of it.
sig() {
	python3 -I - "$1" <<'PY'
import hashlib, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
names = sorted(i.filename for i in z.infolist() if not i.is_dir())
h = hashlib.sha256()
h.update(("\n".join(names) + "\n").encode())
for n in names:
    h.update(n.encode() + b"\0")
    h.update(z.read(n))
    h.update(b"\0")
sys.stdout.write(h.hexdigest() + "\n" + "\n".join(names))
PY
}

zip_tree() {
	local parent=$1 out=$2
	rm -f "$out"
	(cd "$parent" && zip -qr -9 site.zip wordpress)
	cp "$parent/site.zip" "$out"
}

make_tree "$T/bare"
make_tree "$T/off"
# The off build runs the same step build.sh runs. Unset must not write.
(
	cd "$HERE"
	WP_CLI_BUNDLE_TEST=1 WP_CLI_CACHE="$T/cache-off" WP_CLI_PHAR_URL="file://$T/missing.phar" \
		./wp-cli-bundle.sh "$T/off/wordpress"
) >"$T/off.out" 2>"$T/off.err"
rc=$?
ok "endpoint unset exits 0 and does not fetch" "$([ $rc = 0 ] && [ ! -f "$T/off/wordpress/wp-cli.phar" ] && echo 1 || echo 0)"
zip_tree "$T/bare" "$T/bare.zip"
zip_tree "$T/off" "$T/off.zip"
bare_sig=$(sig "$T/bare.zip")
off_sig=$(sig "$T/off.zip")
ok "endpoint-off file list and hash match a build without the phar step" "$([ "$bare_sig" = "$off_sig" ] && echo 1 || echo 0)"
if [ "$bare_sig" != "$off_sig" ]; then
	echo "    bare: $(printf '%s\n' "$bare_sig" | head -1)"
	echo "    off:  $(printf '%s\n' "$off_sig" | head -1)"
fi

# On: a fixture phar, pinned to its own sha512. It lands at wordpress/wp-cli.phar.
mkdir -p "$T/cache-on"
printf 'phar-bytes-2.12.0\n' > "$T/cache-on/wp-cli-2.12.0.phar"
pin=$(shasum -a 512 "$T/cache-on/wp-cli-2.12.0.phar" | awk '{print $1}')
printf '%s\n' "$pin" > "$T/pin"
make_tree "$T/on"
(
	cd "$HERE"
	WP_CLI_ENDPOINT=on WP_CLI_BUNDLE_TEST=1 WP_CLI_PHAR_PIN="$T/pin" WP_CLI_CACHE="$T/cache-on" \
		./wp-cli-bundle.sh "$T/on/wordpress"
) >"$T/on.out" 2>"$T/on.err"
rc=$?
got=$(shasum -a 512 "$T/on/wordpress/wp-cli.phar" 2>/dev/null | awk '{print $1}')
ok "endpoint on places the phar at the runner path and the pin matches (rc $rc)" "$([ $rc = 0 ] && [ "$got" = "$pin" ] && echo 1 || echo 0)"
zip_tree "$T/on" "$T/on.zip"
on_names=$(sig "$T/on.zip" | tail -n +2)
ok "the on bundle lists wordpress/wp-cli.phar and the off bundle does not" "$(printf '%s\n' "$on_names" | grep -qx 'wordpress/wp-cli.phar' && ! printf '%s\n' "$off_sig" | grep -qx 'wordpress/wp-cli.phar' && echo 1 || echo 0)"

# A changed file fails, and the tree is left without the phar.
mkdir -p "$T/cache-bad"
printf 'not-the-phar\n' > "$T/cache-bad/wp-cli-2.12.0.phar"
make_tree "$T/bad"
(
	cd "$HERE"
	WP_CLI_ENDPOINT=on WP_CLI_BUNDLE_TEST=1 WP_CLI_PHAR_PIN="$T/pin" WP_CLI_CACHE="$T/cache-bad" \
		./wp-cli-bundle.sh "$T/bad/wordpress"
) >"$T/bad.out" 2>"$T/bad.err"
rc=$?
ok "a phar that misses the pin fails and is not copied (rc $rc)" "$([ $rc != 0 ] && [ ! -f "$T/bad/wordpress/wp-cli.phar" ] && grep -q 'sha512' "$T/bad.err" && echo 1 || echo 0)"

# build.sh calls the step after the static copy and the prune, and before the zip,
# so the phar is not a public asset and prune cannot drop it.
B="$HERE/build.sh"
line_of() { grep -n "$1" "$2" | head -1 | cut -d: -f1; }
cpio=$(line_of 'cpio -0pdm' "$B")
prune=$(line_of './prune-php-tree.sh' "$B")
step=$(line_of './wp-cli-bundle.sh' "$B")
zip=$(line_of 'zip -qr -9 site.zip wordpress' "$B")
ok "build.sh adds the phar after prune and before the zip" "$([ -n "$cpio" ] && [ -n "$prune" ] && [ -n "$step" ] && [ -n "$zip" ] && [ "$step" -gt "$cpio" ] && [ "$step" -gt "$prune" ] && [ "$zip" -gt "$step" ] && echo 1 || echo 0)"
ok "the pin file is the tracked sha512" "$(grep -q '^be928f6b8ca1e8dfb9d2f4b75a13aa4aee0896f8a9a0a1c45cd5d2c98605e6172e6d014dda2e27f88c98befc16c040cbb2bd1bfa121510ea5cdf5f6a30fe8832$' "$HERE/wp-cli-2.12.0.sha512" && echo 1 || echo 0)"
ok "build-id.sh names -wpcli only when the endpoint is on" "$(grep -q 'WP_CLI_ENDPOINT' "$HERE/build-id.sh" && grep -q -- '-wpcli' "$HERE/build-id.sh" && echo 1 || echo 0)"

make_tree "$T/override"
(
	cd "$HERE"
	WP_CLI_ENDPOINT=on WP_CLI_PHAR_PIN="$T/pin" ./wp-cli-bundle.sh "$T/override/wordpress"
) >"$T/override.out" 2>"$T/override.err"
rc=$?
ok "a pin override outside the bundle test is refused (rc $rc)" "$([ $rc = 2 ] && [ ! -f "$T/override/wordpress/wp-cli.phar" ] && grep -q 'bundle test' "$T/override.err" && echo 1 || echo 0)"

echo "$fails failing case(s)"
[ "$fails" = 0 ]
