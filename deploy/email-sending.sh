#!/bin/bash
# Onboard a domain for Cloudflare Email Sending, or print whether it is on.
#
#   ./deploy/email-sending.sh status skyphusionwp.dev
#   ./deploy/email-sending.sh enable skyphusionwp.dev
#   ./deploy/email-sending.sh disable skyphusionwp.dev
#
# status is a read. enable and disable change the zone's DNS: an MX, an SPF
# TXT and a DKIM TXT on cf-bounce, and a DMARC TXT on _dmarc (measured
# 2026-11-06 on a subdomain; see deploy/README.md). disable passes --force,
# because without it Wrangler 4.107 in a shell with no terminal prints
# "Not disabling." and exits 0.
#
# The demo sender for this repository, when an operator sets MAIL_FROM to an
# address on it, is skyphusionwp.dev. This script does not pick a From address
# and it does not run unless you name enable or disable.
set -euo pipefail
cd "$(dirname "$0")/.."

usage() {
	echo "usage: ./deploy/email-sending.sh status|enable|disable <domain>" >&2
	exit 2
}

[ $# -eq 2 ] || usage
action=$1
domain=$2
[[ "$domain" =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ ]] || { echo "refusing domain: $domain" >&2; exit 2; }
case "$domain" in
	*.workers.dev|example.com|example.org|example.net|localhost) echo "refusing a domain that cannot send: $domain" >&2; exit 2 ;;
esac

case "$action" in
	status)
		deploy/wr email sending list
		;;
	enable)
		echo "onboarding $domain for Email Sending (this writes DNS in that zone)"
		deploy/wr email sending enable "$domain"
		deploy/wr email sending dns get "$domain"
		;;
	disable)
		echo "disabling Email Sending for $domain (this removes the records Wrangler added)"
		deploy/wr email sending disable "$domain" --force
		;;
	*)
		usage
		;;
esac
