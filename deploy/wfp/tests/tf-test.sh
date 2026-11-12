#!/bin/bash
# Terraform checks of deploy/wfp (issue #35), offline (no credentials; the
# providers are downloaded on the first init). CI runs it with terraform from
# hashicorp/setup-terraform (issue #336); run it locally before a live run too.
#   deploy/wfp/tests/tf-test.sh [a copy of deploy/wfp/terraform]
# - terraform validate and fmt for terraform/shared and terraform/site;
# - in terraform/site, the teardown key depends on NOTHING (terraform graph),
#   so down.sh's "apply -target=cloudflare_account_token.teardown" cannot
#   create the bucket or the site map entry (a down never creates).
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
edges=$(printf '%s\n' "$g" | grep -E '"cloudflare_account_token\.teardown" -> ' || true)
ok "site: the teardown key has no dependency (got: ${edges:-none})" "$([ -z "$edges" ] && echo 1 || echo 0)"
# The control: the graph has the teardown key at all, so an empty edge list
# above is a reading of it, not a miss (the mutant with the token referencing
# cloudflare_r2_bucket.media makes the check above fail).
ok "site: the graph has the teardown key (the check above can see it)" "$(printf '%s\n' "$g" | grep -q '"cloudflare_account_token.teardown"' && echo 1 || echo 0)"
# The same for the import key ("site import", deploy/import.sh for deploy/wfp):
# its -target apply must not create or change anything else.
edges=$(printf '%s\n' "$g" | grep -E '"cloudflare_account_token\.media_import" -> ' || true)
ok "site: the media import key has no dependency (got: ${edges:-none})" "$([ -z "$edges" ] && echo 1 || echo 0)"
ok "site: the graph has the media import key (the check above can see it)" "$(printf '%s\n' "$g" | grep -q '"cloudflare_account_token.media_import"' && echo 1 || echo 0)"
echo "$fails failing check(s)"
exit $fails
