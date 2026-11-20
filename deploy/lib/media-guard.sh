# shellcheck shell=bash
# #1108: deploy.sh never deletes an existing site's media bucket by default. A rebuild that omits MEDIA=1 used to apply
# media = false, and Terraform (main.tf: the bucket's count is var.media) destroyed the bucket and every upload in it,
# with no prompt (measured on the throwaway cf759f, 2026-11-20). Sourced by deploy/deploy.sh; test:
# deploy/tests/media-guard-test.sh.
#
# media_guard <terraform dir> <site name> <var file, relative to the dir>: return 2, with the reason on stderr, when
#   1. the site's workspace already holds the media bucket (cloudflare_r2_bucket.media[0]) and MEDIA is not 1, or
#   2. the plan for this run deletes ANY cloudflare_r2_bucket (a rename or a variant change, too).
# DESTROY_MEDIA=1 is the one way to delete it on purpose; the run says so. A plan that can not be read is a refusal
# (fail closed), never a pass. A new site (no workspace yet) has nothing to lose, so check 1 passes and the plan decides.
media_guard() {
  local dir=$1 name=$2 vars=$3 plan
  if [ "${DESTROY_MEDIA:-0}" = 1 ]; then
    echo "DESTROY_MEDIA=1: this run may delete $name's media bucket and every upload in it" >&2
    return 0
  fi
  if [ "${MEDIA:-0}" != 1 ] && (cd "$dir" && terraform workspace select "$name" >/dev/null 2>&1 && terraform state list 2>/dev/null) | grep -qx 'cloudflare_r2_bucket.media\[0\]'; then
    echo "refused: $name has a media bucket, and this run would delete it with every upload (MEDIA is ${MEDIA:-unset})." >&2
    echo "  Deploy it again with MEDIA=1. To delete its media on purpose, set DESTROY_MEDIA=1. Nothing was changed. (#1108)" >&2
    return 2
  fi
  plan="sites/$name.media-guard.plan"
  if ! (cd "$dir" && terraform workspace select -or-create "$name" >/dev/null && terraform plan -input=false -lock=false -var-file="$vars" -out="$plan" > "sites/$name.media-guard.log" 2>&1); then
    echo "refused: the plan for $name could not be made, so a media bucket delete can not be ruled out (see $dir/sites/$name.media-guard.log). Nothing was changed. (#1108)" >&2
    return 2
  fi
  local deletes
  deletes=$(cd "$dir" && terraform show -json "$plan" | python3 -I -c '
import json, sys
p = json.load(sys.stdin)
for r in p.get("resource_changes") or []:
    if r.get("type") == "cloudflare_r2_bucket" and "delete" in ((r.get("change") or {}).get("actions") or []):
        print(r.get("address"))
') || { echo "refused: the plan for $name could not be read. Nothing was changed. (#1108)" >&2; rm -f "$dir/$plan"; return 2; }
  rm -f "$dir/$plan"
  if [ -n "$deletes" ]; then
    echo "refused: the plan for $name deletes R2 bucket(s): $deletes. Every upload in them would be lost." >&2
    echo "  If that is meant, set DESTROY_MEDIA=1. Nothing was changed. (#1108)" >&2
    return 2
  fi
  return 0
}
