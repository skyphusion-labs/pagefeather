#!/bin/bash
# Checks of the SSH test source (#83, design #31 comment 6681505234), after
# terraform apply here. Run from the laptop, in this directory:
#
#   tests/ssh-source/check.sh before     # no inbound; tunnel with and without the token; marker
#   (the import: see README.md)
#   tests/ssh-source/check.sh after      # nothing on the box newer than the marker
#
# Reads hostname, box_ip and the service token from terraform output, or
# from the environment when another seat holds the state: SSH_SRC_HOST,
# SSH_SRC_IP, TUNNEL_SERVICE_TOKEN_ID and TUNNEL_SERVICE_TOKEN_SECRET. The
# token goes to cloudflared in those two variables (its own), never in an
# argument. Needs a ssh config block (terraform output -raw ssh_config):
# ~/.ssh/config, or a file in SSH_CONFIG.
set -euo pipefail
cd "$(dirname "$0")"
H=${SSH_SRC_HOST:-$(terraform output -raw hostname)}
IP=${SSH_SRC_IP:-$(terraform output -raw box_ip)}
if [ -n "${TUNNEL_SERVICE_TOKEN_ID:-}" ] && [ -n "${TUNNEL_SERVICE_TOKEN_SECRET:-}" ]; then
  TOK_ID=$TUNNEL_SERVICE_TOKEN_ID; TOK_SECRET=$TUNNEL_SERVICE_TOKEN_SECRET
else
  TOK_ID=$(terraform output -raw access_client_id); TOK_SECRET=$(terraform output -raw access_client_secret)
fi
unset TUNNEL_SERVICE_TOKEN_ID TUNNEL_SERVICE_TOKEN_SECRET
with_token() { TUNNEL_SERVICE_TOKEN_ID=$TOK_ID TUNNEL_SERVICE_TOKEN_SECRET=$TOK_SECRET "$@"; }
SSHC=(ssh ${SSH_CONFIG:+-F "$SSH_CONFIG"} -o BatchMode=yes)
# limit <seconds> <cmd...>: run it, kill it after that long (macOS has no
# timeout). Without a token, cloudflared may wait for a browser login.
limit() { local s=$1; shift; "$@" & local p=$!; (sleep "$s"; kill "$p" 2>/dev/null) & local w=$!; wait "$p"; local rc=$?; kill "$w" 2>/dev/null || true; return "$rc"; }
fails=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }
case "${1:-}" in
before)
  # 1. No inbound: port 22 on the public address, from this laptop (no
  # allowlist exists, so any vantage is a stranger's).
  if nc -z -w 5 "$IP" 22 2>/dev/null; then open=yes; else open=no; fi
  check "port 22 on $IP from this laptop is closed" "$open" "no"
  # 2. Through the tunnel: with the token it works, without it it is refused.
  out=$(with_token limit 60 "${SSHC[@]}" "$H" 'cat /var/lib/ssh-source-ready' 2>&1 || true)
  check "ssh through the tunnel with the token" "$(printf '%s' "$out" | grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' || true)" "1"
  out=$(limit 30 "${SSHC[@]}" "$H" true 2>&1 && echo CONNECTED || true)
  check "ssh through the tunnel without the token is refused" "$(printf '%s' "$out" | grep -c CONNECTED || true)" "0"
  # 3. The marker for the read-only check (written by importer in its own
  # home BEFORE the import; the import itself must write nothing).
  with_token "${SSHC[@]}" "$H" 'touch ~/.import-marker && date -u +%Y-%m-%dT%H:%M:%SZ'
  ;;
after)
  # No file newer than the marker in the site, /tmp, /var/tmp or the
  # importer home. NOT checked: MariaDB's own files (the user importer cannot
  # read /var/lib/mysql; the dump only reads, with --single-transaction).
  # The /tmp, /var/tmp and home DIRECTORIES themselves are not counted (the
  # files in them are): a probe that makes and removes its own file moves a
  # home's mtime, and during a
  # dump another process (most likely the MariaDB server, tmpdir=/tmp) makes
  # and removes an entry there, so their mtime moves although no file stays
  # (measured 2026-11-06; strace of the import's own processes: no /tmp
  # call). It is printed as a note.
  newer=$(with_token "${SSHC[@]}" "$H" 'find /var/www/wordpress -newer ~/.import-marker 2>/dev/null; find /tmp /var/tmp ~ -mindepth 1 -newer ~/.import-marker -not -path ~/.import-marker 2>/dev/null; true')
  dirs=$(with_token "${SSHC[@]}" "$H" 'find /tmp /var/tmp ~ -maxdepth 0 -newer ~/.import-marker 2>/dev/null; true')
  echo "newer than the marker:"; printf '%s\n' "$newer" | sed 's/^/  /'
  [ -z "$dirs" ] || echo "note: directory mtime moved (no file in it): $(printf '%s' "$dirs" | tr '\n' ' ')"
  check "no file in the site, /tmp, /var/tmp or the importer home is newer" "$(printf '%s\n' "$newer" | grep -c . || true)" "0"
  ;;
*) echo "usage: $0 before|after" >&2; exit 2 ;;
esac
[ "$fails" = 0 ] || { echo "$fails failed"; exit 1; }
echo "all passed"
