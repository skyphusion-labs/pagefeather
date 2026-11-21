#!/bin/bash
# Add wp-cli.phar to the WordPress tree only when WP_CLI_ENDPOINT=on (#1258).
# $1 is the wordpress directory (build/wordpress). The runner reads
# /wordpress/wp-cli.phar, which is this file inside site.zip.
# Unset: exit 0 and do not write, so the zip matches a build without this step.
# The sha512 is wp-cli-2.12.0.sha512 (the published digest of WP-CLI 2.12.0).
# A changed upstream file fails the build.
# Test: tests/wp-cli-bundle-test.sh. WP_CLI_BUNDLE_TEST=1 may point the pin,
# the cache and the URL at fixtures. A deploy does not set that.
set -euo pipefail
cd "$(dirname "$0")"
wp=${1:?usage: wp-cli-bundle.sh <wordpress dir>}
case "${WP_CLI_ENDPOINT:-}" in
	"") exit 0 ;;
	on) ;;
	*) echo "wp-cli-bundle.sh: WP_CLI_ENDPOINT must be on or unset, not ${WP_CLI_ENDPOINT}" >&2; exit 2 ;;
esac

PIN_DEFAULT=$PWD/wp-cli-2.12.0.sha512
URL_DEFAULT=https://github.com/wp-cli/wp-cli/releases/download/v2.12.0/wp-cli-2.12.0.phar
VER=2.12.0
if [ -n "${WP_CLI_BUNDLE_TEST:-}" ]; then
	PIN=${WP_CLI_PHAR_PIN:-$PIN_DEFAULT}
	CACHE=${WP_CLI_CACHE:-$PWD/build/cache}
	URL=${WP_CLI_PHAR_URL:-$URL_DEFAULT}
else
	if [ -n "${WP_CLI_PHAR_PIN:-}${WP_CLI_CACHE:-}${WP_CLI_PHAR_URL:-}" ]; then
		echo "wp-cli-bundle.sh: pin, cache and url overrides are only for the bundle test" >&2
		exit 2
	fi
	PIN=$PIN_DEFAULT
	CACHE=$PWD/build/cache
	URL=$URL_DEFAULT
fi

want=$(awk 'NF && $1 !~ /^#/ { print $1; exit }' "$PIN")
case "$want" in
	*[!0-9a-fA-F]*) echo "wp-cli-bundle.sh: pinned sha512 is not hex" >&2; exit 2 ;;
esac
[ "${#want}" = 128 ] || { echo "wp-cli-bundle.sh: pinned sha512 is not 128 hex chars" >&2; exit 2; }
mkdir -p "$CACHE"
phar=$CACHE/wp-cli-$VER.phar
sum_of() { shasum -a 512 "$1" | awk '{print $1}'; }
if [ -f "$phar" ] && [ "$(sum_of "$phar")" = "$want" ]; then
	:
elif [ -n "${WP_CLI_BUNDLE_TEST:-}" ] && [ -z "${WP_CLI_PHAR_URL:-}" ]; then
	echo "wp-cli-bundle.sh: sha512 mismatch for wp-cli $VER (pinned). The upstream file changed, so the build stops." >&2
	exit 2
else
	rm -f "$phar"
	curl -fsSL "$URL" -o "$phar.tmp" || { rm -f "$phar.tmp"; echo "wp-cli-bundle.sh: fetch failed: $URL" >&2; exit 2; }
	mv "$phar.tmp" "$phar"
fi
got=$(sum_of "$phar")
if [ "$got" != "$want" ]; then
	rm -f "$phar"
	echo "wp-cli-bundle.sh: sha512 mismatch for wp-cli $VER (pinned). The upstream file changed, so the build stops." >&2
	exit 2
fi
cp "$phar" "$wp/wp-cli.phar"
