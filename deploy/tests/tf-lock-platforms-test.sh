#!/bin/bash
# Test of #1382 and #1389: every deploy and test-fixture Terraform root's .terraform.lock.hcl already holds the provider hashes of each
# platform an operator, a box or CI runs on, so `terraform init` there never REWRITES the tracked lock. A rewrite
# leaves the clone dirty, and every build from it is stamped -dirty (seen on a fresh Linux box, 2026-11-23: the
# locks held one platform's h1 hash, and init added linux_amd64's). For each root it copies the .tf files and the
# lock to a temp dir, runs `terraform providers lock` for the platforms below, and fails if the lock changed.
#   deploy/tests/tf-lock-platforms-test.sh
# Needs terraform and the registry (CI has both). Without terraform: SKIP, which is not a pass.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
PLATFORMS="linux_amd64 linux_arm64 darwin_arm64 darwin_amd64"
ROOTS="deploy/terraform deploy/mysql deploy/wfp/terraform/shared deploy/wfp/terraform/site"
# #1389: the test fixtures' roots too. A clone that ran their init is just as dirty for build-id.sh.
ROOTS="$ROOTS tests/a/terraform tests/a2/terraform tests/do/terraform tests/fixtures/terraform tests/ssh-source tests/wfp/terraform"
fails=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }
command -v terraform >/dev/null 2>&1 || { echo "SKIP: no terraform on PATH (this is not a pass)"; exit 0; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
args=""; for p in $PLATFORMS; do args="$args -platform=$p"; done
for r in $ROOTS; do
  check "$r: its lock file is tracked" "$(git -C "$ROOT" ls-files --error-unmatch "$r/.terraform.lock.hcl" >/dev/null 2>&1 && echo yes || echo no)" yes
  mkdir -p "$T/$r"; cp "$ROOT/$r"/*.tf "$ROOT/$r/.terraform.lock.hcl" "$T/$r/"
  # shellcheck disable=SC2086
  (cd "$T/$r" && terraform providers lock $args > "$T/out" 2>&1); rc=$?
  check "$r: terraform providers lock ran" "$rc" 0
  [ "$rc" = 0 ] || { tail -3 "$T/out" | sed 's/^/   /'; continue; }
  added=$(diff "$ROOT/$r/.terraform.lock.hcl" "$T/$r/.terraform.lock.hcl" | grep -c '^>')
  check "$r: the lock already holds every platform's hashes (lines a lock for $PLATFORMS adds)" "$added" 0
done
echo "$fails failing check(s)"
[ "$fails" = 0 ]
