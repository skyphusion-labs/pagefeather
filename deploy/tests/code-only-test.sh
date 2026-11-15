#!/usr/bin/env bash
# deploy/deploy.sh CODE_ONLY=1 (fleet-chezmoi#2620): the refusals fire before any Terraform, build,
# network call or deploy. env -i, a fake token: a case that got past its refusal would fail, not pass.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fails=0
O="https://zarapo.skyphusion.workers.dev"
# shellcheck source=SCRIPTDIR/lib.sh
. "$ROOT/deploy/tests/lib.sh"   # refuse, behind the fence
FENCE=$(mktemp -d "${TMPDIR:-/tmp}/code-only-fence.XXXXXX"); trap 'rm -rf "$FENCE"' EXIT
fence_dir "$FENCE"
refuse "is for VARIANT=b-dosql only" VARIANT=b-do CODE_ONLY=1 SITE_ORIGIN=$O
refuse "is for VARIANT=b-dosql only" VARIANT=a CODE_ONLY=1 SITE_ORIGIN=$O
refuse "needs SITE_ORIGIN" VARIANT=b-dosql CODE_ONLY=1 MEDIA=1 MEDIA_BUCKET=zarapo-media
refuse "needs MEDIA_BUCKET" VARIANT=b-dosql CODE_ONLY=1 MEDIA=1 SITE_ORIGIN=$O
refuse "needs MEDIA_BUCKET" VARIANT=b-dosql CODE_ONLY=1 MEDIA=1 MEDIA_BUCKET=Bad_Bucket SITE_ORIGIN=$O
refuse "DRY_RUN=1 is for CODE_ONLY=1 only" VARIANT=b-dosql DRY_RUN=1
echo "$fails failing case(s)"
[ "$fails" = 0 ]
