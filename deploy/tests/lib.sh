# shellcheck shell=bash
# Shared by the deploy/deploy.sh refusal tests (code-only-test.sh, a-settings-test.sh). Source it
# after setting ROOT and fails=0.
#
# THE FENCE (#394): a refusal test runs the real deploy.sh. Before its refusal exists (the red
# phase of a test written first), a case runs on into Terraform, the build and the network on
# this machine. That happened twice on 2026-11-15 (rollins-sb1114k; #625's red phase nearly did
# too). fence_dir makes a directory of stubs that exit 97 for terraform, curl, docker, npm, npx and
# node, put first on PATH by refuse, so a case that gets past its refusal stops at its first real
# step and fails, instead of running it. deploy.sh's refusals run before any of them.

# fence_dir <dir>: write the stubs into <dir>.
fence_dir() {
  local d=$1 c
  mkdir -p "$d"
  for c in terraform curl docker npm npx node; do
    printf '#!/bin/sh\necho "STUB %s called: a refusal did not fire" >&2\nexit 97\n' "$c" > "$d/$c"
    chmod +x "$d/$c"
  done
}

# The site name every refusal case uses. NOT a real site: deploy.sh writes
# deploy/terraform/sites/<NAME>.tfvars before its first Terraform call, so a case that gets past its
# refusal leaves that one file (the fence stops it right after). Under a live site's name (zarapo was
# used before) it would overwrite that site's tfvars in an operator's clone.
REFUSE_NAME=pf-refusal-test

# refuse <expected text> <VAR=value...>: deploy.sh exits 2 with that text, before any step.
# env -i and a fake token, behind the fence. Needs FENCE (a fence_dir) and ROOT; counts into fails.
refuse() {
  local want=$1; shift
  local out rc
  out=$(env -i PATH="$FENCE:$PATH" HOME="$HOME" NAME="$REFUSE_NAME" ACCOUNT_ID=0123456789abcdef0123456789abcdef CLOUDFLARE_API_TOKEN=fake "$@" bash "$ROOT/deploy/deploy.sh" 2>&1); rc=$?
  if [ "$rc" = 2 ] && grep -qF "$want" <<<"$out" && ! grep -qE '^== (terraform|build|deploy)' <<<"$out"; then echo "  ok   refuses: $want ($*)"
  else echo "  FAIL expected exit 2 with '$want' before any step ($*; rc=$rc): $(tail -1 <<<"$out")"; fails=$((fails+1)); fi
}
