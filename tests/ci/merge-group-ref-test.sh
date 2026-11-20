#!/usr/bin/env bash
# #1070. The merge-queue gate in .github/workflows/approval-at-head.yml reads the PR
# number and head sha from github.event.merge_group.head_ref. This test pulls the
# REAL parse block out of that workflow (between "# parse-begin" and "# parse-end")
# and runs it on good and bad refs, so the shipped code is what is tested, not a copy.
# It also checks that the three workflows answer merge_group.
#
# Exit 0 = all passed, 1 = a check failed, 2 = COULD NOT MEASURE (block not found).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
WF="$ROOT/.github/workflows/approval-at-head.yml"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
FAILS=0
check() {
    if [ "$2" = "$3" ]; then
        echo "ok $1"
    else
        echo "FAIL $1"
        echo "  actual:   $2"
        echo "  expected: $3"
        FAILS=$((FAILS + 1))
    fi
}

# The block, with the workflow's 10-space indent removed.
awk '/# parse-begin/{f=1; next} /# parse-end/{f=0} f' "$WF" | sed 's/^          //' >"$T/parse.sh"
if ! grep -q 'BASH_REMATCH' "$T/parse.sh"; then
    echo "approval-at-head-test: COULD NOT MEASURE: the parse block was not found in $WF" >&2
    exit 2
fi

SHA=0123456789abcdef0123456789abcdef01234567
# parse <ref>: sets RC and the pr= and sha= lines it wrote.
parse() {
    : >"$T/out"
    HEAD_REF="$1" GITHUB_OUTPUT="$T/out" bash "$T/parse.sh" >"$T/log" 2>&1
    RC=$?
    PR=$(sed -n 's/^pr=//p' "$T/out")
    GOT=$(sed -n 's/^sha=//p' "$T/out")
}

parse "refs/heads/gh-readonly-queue/main/pr-1070-$SHA"
check "a good ref exits 0" "$RC" "0"
check "a good ref gives the PR number" "$PR" "1070"
check "a good ref gives the head sha" "$GOT" "$SHA"

parse "refs/heads/gh-readonly-queue/release/1.x/pr-7-$SHA"
check "a base branch with a slash parses" "$RC:$PR" "0:7"

parse "refs/heads/gh-readonly-queue/main/pr-123456-$SHA"
check "a six digit PR number parses" "$RC:$PR" "0:123456"

# Every one of these must be refused, and must write nothing.
refuse() {
    parse "$2"
    check "$1: refused" "$RC" "1"
    check "$1: writes no output" "$(wc -c <"$T/out" | tr -d ' ')" "0"
}
refuse "an empty ref" ""
refuse "a plain branch" "refs/heads/main"
refuse "no refs/heads prefix" "gh-readonly-queue/main/pr-1-$SHA"
refuse "a pull request ref" "refs/pull/1/merge"
refuse "PR number zero" "refs/heads/gh-readonly-queue/main/pr-0-$SHA"
refuse "a leading zero in the PR number" "refs/heads/gh-readonly-queue/main/pr-01-$SHA"
refuse "no PR number" "refs/heads/gh-readonly-queue/main/pr--$SHA"
refuse "a non-numeric PR" "refs/heads/gh-readonly-queue/main/pr-abc-$SHA"
refuse "a short sha" "refs/heads/gh-readonly-queue/main/pr-1-${SHA%?}"
refuse "a long sha" "refs/heads/gh-readonly-queue/main/pr-1-${SHA}0"
refuse "an upper case sha" "refs/heads/gh-readonly-queue/main/pr-1-$(printf '%s' "$SHA" | tr 'a-f' 'A-F')"
refuse "a non-hex sha" "refs/heads/gh-readonly-queue/main/pr-1-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"
refuse "text after the sha" "refs/heads/gh-readonly-queue/main/pr-1-$SHA-x"
refuse "a command after the sha" "refs/heads/gh-readonly-queue/main/pr-1-$SHA; echo pwned"
refuse "a newline in the ref" "refs/heads/gh-readonly-queue/main/pr-1-$SHA
pr=999"
refuse "text before refs/heads" "x/refs/heads/gh-readonly-queue/main/pr-1-$SHA"
refuse "a missing base branch" "refs/heads/gh-readonly-queue/pr-1-$SHA"
refuse "the wrong queue name" "refs/heads/gh-readonly-queue-x/main/pr-1-$SHA"

# The workflows answer merge_group, and the queue job uses the same judge as the PR job.
check "ci.yml answers merge_group" "$(grep -c '^  merge_group:' "$ROOT/.github/workflows/ci.yml")" "1"
check "codeql.yml answers merge_group" "$(grep -c '^  merge_group:' "$ROOT/.github/workflows/codeql.yml")" "1"
check "approval-at-head.yml answers merge_group" "$(grep -c '^  merge_group:' "$WF")" "1"
pins=$(grep 'approval-at-head-reusable.yml@' "$WF" | sed 's/.*@//' | sort -u)
check "both jobs use one pinned judge" "$(printf '%s\n' "$pins" | wc -l | tr -d ' ')" "1"
check "the retrigger uses that same pin" "$(grep -c "@$pins" "$ROOT/.github/workflows/approval-at-head-retrigger.yml")" "1"
check "the queue job is skipped unless it is a merge_group run" "$(grep -c "if: github.event_name == 'merge_group'" "$WF")" "2"
check "the pull_request job is skipped on a merge_group run" "$(grep -c "if: github.event_name == 'pull_request'" "$WF")" "1"
check "the queue job waits for the ref check" "$(grep -c 'needs: queue-ref' "$WF")" "1"

if [ "$FAILS" -ne 0 ]; then
    echo "$FAILS failed"
    exit 1
fi
echo "all passed"
