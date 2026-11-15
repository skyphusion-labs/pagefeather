#!/usr/bin/env bash
# deploy/deploy.sh OPCACHE_A=1 (#296): approach A primes its OPcache with opcache-a.sh, with no
# Docker and no local MySQL, and an EMPTY cache fails the deploy instead of shipping. Offline: the
# opcache-a.sh under test is a stub in a temp dir, so each case controls what it leaves behind.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fails=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; fails=$((fails+1)); }

# Every tool a step would run is a stub that fails, so a case that gets past its refusal fails
# at once instead of running Terraform or a build on this machine.
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
mkdir -p "$W/bin"
for t in terraform npm npx node curl docker; do printf '#!/bin/sh\necho "stub %s ran: a step started" >&2\nexit 97\n' "$t" > "$W/bin/$t"; chmod +x "$W/bin/$t"; done

# 1. The flag is refused off variant a, before any step.
out=$(env -i PATH="$W/bin:$PATH" HOME="$HOME" NAME=zarapo ACCOUNT_ID=0123456789abcdef0123456789abcdef CLOUDFLARE_API_TOKEN=fake VARIANT=b-dosql OPCACHE_A=1 bash "$ROOT/deploy/deploy.sh" 2>&1); rc=$?
if [ "$rc" = 2 ] && grep -qF "OPCACHE_A=1 is for VARIANT=a only" <<<"$out" && ! grep -qE '^== (terraform|build|deploy)' <<<"$out"; then ok "refuses OPCACHE_A=1 on b-dosql"
else bad "OPCACHE_A=1 on b-dosql: expected exit 2 before any step (rc=$rc): $(tail -1 <<<"$out")"; fi

# 2. a_opcache_primed against stub opcache-a.sh scripts.
[ -f "$ROOT/deploy/a-opcache.sh" ] || { bad "deploy/a-opcache.sh is missing"; echo "$fails failing case(s)"; exit 1; }
case_run() { # case_run <name> <stub body>; prints rc and output of a_opcache_primed in a fresh app dir
  local d="$W/$1"; mkdir -p "$d/build"
  printf '#!/bin/bash\n%s\n' "$2" > "$d/opcache-a.sh"; chmod +x "$d/opcache-a.sh"
  (cd "$d" && . "$ROOT/deploy/a-opcache.sh" && a_opcache_primed) 2>&1
}
zip3='python3 -c "import zipfile; z=zipfile.ZipFile(\"build/opcache.zip\",\"w\"); [z.writestr(f\"a{i}.php.bin\",\"x\") for i in range(3)]; z.close()"'
zip0='python3 -c "import zipfile; zipfile.ZipFile(\"build/opcache.zip\",\"w\").close()"'

out=$(case_run primed "echo priming; $zip3"); rc=$?
if [ "$rc" = 0 ] && grep -qF "3 compiled scripts" <<<"$out"; then ok "a primed cache passes and says how many scripts"
else bad "primed: expected rc 0 and '3 compiled scripts' (rc=$rc): $out"; fi

out=$(case_run empty "$zip0"); rc=$?
if [ "$rc" != 0 ] && grep -qF "0 compiled scripts" <<<"$out"; then ok "an empty cache fails"
else bad "empty: expected a failure naming 0 compiled scripts (rc=$rc): $out"; fi

out=$(case_run nozip "echo no zip written"); rc=$?
if [ "$rc" != 0 ] && grep -qF "not a readable zip" <<<"$out"; then ok "a missing cache fails"
else bad "nozip: expected a failure, not a readable zip (rc=$rc): $out"; fi

out=$(case_run broken "echo the woo.py step failed; exit 1"); rc=$?
if [ "$rc" != 0 ] && grep -qF "opcache-a.sh failed" <<<"$out" && grep -qF "the woo.py step failed" <<<"$out"; then ok "a failed opcache-a.sh fails and shows its log"
else bad "broken: expected a failure with the log tail (rc=$rc): $out"; fi

# 3. deploy.sh calls it on variant a when the flag is set (read in code: the call is after Terraform).
if grep -qE 'OPCACHE_A:-0\}" = 1 \]; then a_opcache_primed' "$ROOT/deploy/deploy.sh"; then ok "deploy.sh calls a_opcache_primed under OPCACHE_A=1"
else bad "deploy.sh does not call a_opcache_primed under OPCACHE_A=1"; fi

echo "$fails failing case(s)"
[ "$fails" = 0 ]
