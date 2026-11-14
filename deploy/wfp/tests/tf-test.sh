#!/bin/bash
# Terraform checks of deploy/wfp (issue #35), offline (no credentials; the
# providers are downloaded on the first init). CI runs it with a checksum-verified
# terraform 1.17.1 (issue #336); run it locally before a live run too.
#   deploy/wfp/tests/tf-test.sh [a copy of deploy/wfp/terraform]
# - terraform validate and fmt for terraform/shared and terraform/site;
# - terraform/site makes no account token (#273): the keys that empty the bucket
#   and put an import's uploads are temporary R2 credentials (r2_temp.py), so the
#   deploy token needs no API Tokens permission.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
TFD=${1:-$HERE/../terraform}
fails=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
for r in shared site; do
	(cd "$TFD/$r" && terraform init -backend=false -input=false >/dev/null 2>&1 && terraform validate -no-color >/dev/null 2>&1); ok "$r: terraform validate" "$([ $? = 0 ] && echo 1 || echo 0)"
	(cd "$TFD/$r" && terraform fmt -check >/dev/null 2>&1); ok "$r: terraform fmt" "$([ $? = 0 ] && echo 1 || echo 0)"
done
g=$(cd "$TFD/site" && terraform graph 2>/dev/null)
[ -n "$g" ] || { echo "FAIL terraform graph gave nothing"; exit 1; }
ok "site: the graph has no cloudflare_account_token (#273)" "$(printf '%s\n' "$g" | grep -q 'cloudflare_account_token' && echo 0 || echo 1)"
# The control: the graph has the media bucket, so the check above reads a real graph.
ok "site: the graph has the media bucket (the check above can see a resource)" "$(printf '%s\n' "$g" | grep -q '"cloudflare_r2_bucket.media"' && echo 1 || echo 0)"
echo "$fails failing check(s)"
exit $fails
