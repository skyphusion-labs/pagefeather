#!/usr/bin/env bash
# deploy/deploy.sh CODE_ONLY=1 (fleet-chezmoi#2620): the refusals fire before any Terraform, build,
# network call or deploy. env -i, a fake token: a case that got past its refusal would fail, not pass.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fails=0
O="https://zarapo.skyphusion.workers.dev"
refuse() { # refuse <expected text> <VAR=value...>
  local want=$1; shift
  local out rc
  out=$(env -i PATH="$PATH" HOME="$HOME" NAME=zarapo ACCOUNT_ID=0123456789abcdef0123456789abcdef CLOUDFLARE_API_TOKEN=fake "$@" bash "$ROOT/deploy/deploy.sh" 2>&1); rc=$?
  if [ "$rc" = 2 ] && grep -qF "$want" <<<"$out" && ! grep -qE '^== (terraform|build|deploy)' <<<"$out"; then echo "  ok   refuses: $want"
  else echo "  FAIL expected exit 2 with '$want' before any step (rc=$rc): $(tail -1 <<<"$out")"; fails=$((fails+1)); fi
}
refuse "is for VARIANT=b-dosql only" VARIANT=b-do CODE_ONLY=1 SITE_ORIGIN=$O
refuse "is for VARIANT=b-dosql only" VARIANT=a CODE_ONLY=1 SITE_ORIGIN=$O
refuse "needs SITE_ORIGIN" VARIANT=b-dosql CODE_ONLY=1 MEDIA=1 MEDIA_BUCKET=zarapo-media
refuse "needs MEDIA_BUCKET" VARIANT=b-dosql CODE_ONLY=1 MEDIA=1 SITE_ORIGIN=$O
refuse "needs MEDIA_BUCKET" VARIANT=b-dosql CODE_ONLY=1 MEDIA=1 MEDIA_BUCKET=Bad_Bucket SITE_ORIGIN=$O
refuse "DRY_RUN=1 is for CODE_ONLY=1 only" VARIANT=b-dosql DRY_RUN=1
echo "$fails failing case(s)"
[ "$fails" = 0 ]
