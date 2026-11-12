#!/bin/bash
# tests/fixtures/terraform leaves the clone CLEAN. A `terraform init` there must not leave an
# untracked file, or every build from the clone reads -dirty.
#   tests/fixtures/tests/tf-clean-test.sh
# 1. git check-ignore: every Terraform artifact path is ignored, and .terraform.lock.hcl is NOT
#    (it is tracked). Runs everywhere.
# 2. Where terraform is on PATH: a real `terraform init -backend=false` in the root, then
#    `git status --porcelain` for the root is empty. CI runners have no terraform, so step 2 says
#    SKIP there; it is not a pass.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
TF="tests/fixtures/terraform"
cd "$ROOT" || exit 1
fails=0
check() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }

for p in "$TF/.terraform/providers/x" "$TF/terraform.tfstate" "$TF/terraform.tfstate.backup" "$TF/plan.tfplan" \
         "$TF/backend_override.tf" "$TF/terraform.tfstate.d/w/terraform.tfstate"; do
  git check-ignore -q "$p"; check "ignored: $p" "$([ $? = 0 ] && echo 1 || echo 0)"
done
git check-ignore -q "$TF/.terraform.lock.hcl"; check "NOT ignored: $TF/.terraform.lock.hcl" "$([ $? = 1 ] && echo 1 || echo 0)"
check "tracked: $TF/.terraform.lock.hcl" "$(git ls-files --error-unmatch "$TF/.terraform.lock.hcl" >/dev/null 2>&1 && echo 1 || echo 0)"

# What makes a build -dirty is an UNTRACKED file, or a change in the worktree to a tracked file
# (the init must not rewrite .terraform.lock.hcl). Staged index changes are not what init makes.
dirty() { git status --porcelain --untracked-files=all -- "$TF" | grep -E '^(\?\?|.[MD])' || true; }
if command -v terraform >/dev/null 2>&1; then
  before=$(dirty)
  check "no untracked or modified file in the root before init" "$([ -z "$before" ] && echo 1 || echo 0)"
  (cd "$TF" && terraform init -backend=false -input=false -no-color >/dev/null 2>&1); rc=$?
  check "terraform init -backend=false succeeds" "$([ "$rc" = 0 ] && echo 1 || echo 0)"
  made=0; [ -d "$TF/.terraform" ] && made=1
  check "the init made .terraform/ (the case this guards)" "$made"
  after=$(dirty)
  check "no untracked or modified file in the root after init" "$([ -z "$after" ] && echo 1 || echo 0)"
  [ -z "$after" ] || printf '%s\n' "$after" | sed 's/^/   /'
else
  echo "SKIP terraform init: no terraform on PATH (step 1 still ran)"
fi
echo "$fails failing check(s)"
exit $fails
