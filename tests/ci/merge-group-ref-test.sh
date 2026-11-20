#!/usr/bin/env bash
# #1070, corrected by #1083. The merge-queue gate in .github/workflows/approval-at-head.yml
# reads the PR number from github.event.merge_group.head_ref, then reads the PR head from
# the API. The compare of that head with the merge group is a DIAGNOSTIC only (lead ruling,
# #1083: with squash the PR head is not an ancestor of the group commit). This test cuts the REAL blocks out of the
# workflow (between "# parse-begin"/"# parse-end" and "# verify-begin"/"# verify-end") and
# runs them, so the shipped code is what is tested, not a copy. The verify block runs with a
# stub `gh` that answers from environment variables. It also checks the three workflows
# answer merge_group.
#
# The ref shape is the MEASURED one (2026-11-20, #1083): the sha after pr-<N>- is the commit
# the queue entry is built on (main, or the entry ahead), NOT the PR head.
#
# Exit 0 = all passed, 1 = a check failed, 2 = COULD NOT MEASURE (a block was not found).
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

# extract <name> <needle>: the block, with the workflow's 10-space indent removed.
extract() {
    awk -v b="# $1-begin" -v e="# $1-end" 'index($0, b){f=1; next} index($0, e){f=0} f' "$WF" | sed 's/^          //' >"$T/$1.sh"
    if ! grep -q "$2" "$T/$1.sh"; then
        echo "merge-group-ref-test: COULD NOT MEASURE: the $1 block was not found in $WF" >&2
        exit 2
    fi
}
extract parse BASH_REMATCH
extract verify 'gh api'

# A stub gh. It records every path it is asked for.
mkdir -p "$T/bin"
cat >"$T/bin/gh" <<'STUB'
#!/usr/bin/env bash
# gh api <path> --jq <expr>
echo "$2" >>"$STUB_CALLS"
case "$2" in
    repos/*/pulls/*)
        [ -z "${STUB_PULL_FAIL:-}" ] || exit 1
        printf '%s\n' "$STUB_PULL"
        ;;
    repos/*/compare/*)
        [ -z "${STUB_CMP_FAIL:-}" ] || exit 1
        printf '%s\n' "$STUB_CMP"
        ;;
    *) exit 2 ;;
esac
STUB
chmod +x "$T/bin/gh"

MAIN=956687f0123456789abcdef0123456789abcdef0 # what the live ref carried for #1052: main
HEAD=c0ed21d90123456789abcdef0123456789abcdef # a PR head, never what the ref carries
GROUP=aaaaaaaa23456789abcdef0123456789abcdef01 # the merge group commit
GOOD="refs/heads/gh-readonly-queue/main/pr-1067-$MAIN"

# parse <ref>: sets RC and PR.
parse() {
    : >"$T/out"
    HEAD_REF="$1" GITHUB_OUTPUT="$T/out" bash "$T/parse.sh" >"$T/log" 2>&1
    RC=$?
    PR=$(sed -n 's/^pr=//p' "$T/out")
}

parse "$GOOD"
check "the real ref shape exits 0" "$RC" "0"
check "the real ref shape gives the PR number" "$PR" "1067"
check "the parse block outputs no sha at all" "$(grep -c '^sha=' "$T/out")" "0"

parse "refs/heads/gh-readonly-queue/main/pr-1067-$HEAD"
check "a ref carrying the PR head parses the same" "$RC:$PR" "0:1067"
parse "refs/heads/gh-readonly-queue/release/1.x/pr-7-$MAIN"
check "a base branch with a slash parses" "$RC:$PR" "0:7"
parse "refs/heads/gh-readonly-queue/main/pr-123456-$MAIN"
check "a six digit PR number parses" "$RC:$PR" "0:123456"

refuse_ref() {
    parse "$2"
    check "$1: refused" "$RC" "1"
    check "$1: writes no output" "$(wc -c <"$T/out" | tr -d ' ')" "0"
}
refuse_ref "an empty ref" ""
refuse_ref "a plain branch" "refs/heads/main"
refuse_ref "no refs/heads prefix" "gh-readonly-queue/main/pr-1-$MAIN"
refuse_ref "text before refs/heads" "x/refs/heads/gh-readonly-queue/main/pr-1-$MAIN"
refuse_ref "a pull request ref" "refs/pull/1/merge"
refuse_ref "PR number zero" "refs/heads/gh-readonly-queue/main/pr-0-$MAIN"
refuse_ref "a leading zero in the PR number" "refs/heads/gh-readonly-queue/main/pr-01-$MAIN"
refuse_ref "no PR number" "refs/heads/gh-readonly-queue/main/pr--$MAIN"
refuse_ref "a non-numeric PR" "refs/heads/gh-readonly-queue/main/pr-abc-$MAIN"
refuse_ref "a short sha" "refs/heads/gh-readonly-queue/main/pr-1-${MAIN%?}"
refuse_ref "a long sha" "refs/heads/gh-readonly-queue/main/pr-1-${MAIN}0"
refuse_ref "an upper case sha" "refs/heads/gh-readonly-queue/main/pr-1-$(printf '%s' "$MAIN" | tr 'a-f' 'A-F')"
refuse_ref "text after the sha" "refs/heads/gh-readonly-queue/main/pr-1-$MAIN-x"
refuse_ref "a command after the sha" "refs/heads/gh-readonly-queue/main/pr-1-$MAIN; echo pwned"
refuse_ref "a newline in the ref" "refs/heads/gh-readonly-queue/main/pr-1-$MAIN
pr=999"
refuse_ref "a missing base branch" "refs/heads/gh-readonly-queue/pr-1-$MAIN"
refuse_ref "the wrong queue name" "refs/heads/gh-readonly-queue-x/main/pr-1-$MAIN"

# verify <pull> <compare> [VAR=value ...]: sets RC, SHA_OUT and CALLS.
verify() {
    local pull="$1" cmp="$2"
    shift 2
    : >"$T/out"
    : >"$T/calls"
    env PATH="$T/bin:$PATH" GH_TOKEN=x REPO=skyphusion-labs/pagefeather PR=1067 MG_SHA="$GROUP" \
        STUB_PULL="$pull" STUB_CMP="$cmp" STUB_CALLS="$T/calls" GITHUB_OUTPUT="$T/out" "$@" \
        bash "$T/verify.sh" >"$T/log" 2>&1
    RC=$?
    SHA_OUT=$(sed -n 's/^sha=//p' "$T/out")
    CALLS=$(tr '\n' ' ' <"$T/calls")
}

verify "open $HEAD" "ahead"
check "an open PR whose head is in the group passes" "$RC" "0"
check "the output sha is the PR head from the API" "$SHA_OUT" "$HEAD"
check "the compare asks about the PR head and the group commit" "$CALLS" "repos/skyphusion-labs/pagefeather/pulls/1067 repos/skyphusion-labs/pagefeather/compare/$HEAD...$GROUP "
check "the log shows the compare status as a diagnostic" "$(grep -c "compare says 'ahead' (diagnostic, not a gate)" "$T/log")" "1"
check "the output sha is not the sha in the queue ref" "$([ "$SHA_OUT" = "$MAIN" ] && echo same || echo different)" "different"

# The whole path on the live shape: parse the ref (sha = main), then verify with the API head.
parse "$GOOD"
verify "open $HEAD" "identical" PR="$PR"
check "identical also passes" "$RC:$SHA_OUT" "0:$HEAD"

refuse_verify() {
    verify "$2" "$3" "${@:4}"
    check "$1: refused" "$RC" "1"
    check "$1: outputs no sha" "$SHA_OUT" ""
}
refuse_verify "a closed PR" "closed $HEAD" "ahead"
refuse_verify "a merged PR" "merged $HEAD" "ahead"
refuse_verify "a malformed PR head from the API" "open zzzz" "ahead"
refuse_verify "an empty PR head from the API" "open " "ahead"
refuse_verify "a short PR head from the API" "open ${HEAD%?}" "ahead"
refuse_verify "the pulls API failing" "open $HEAD" "ahead" STUB_PULL_FAIL=1

# The compare is a diagnostic, never a gate. With squash the PR head is not an ancestor of
# the group commit, so none of these may refuse: the approval is judged at the API head.
pass_verify() {
    verify "$2" "$3" "${@:4}"
    check "$1: passes" "$RC" "0"
    check "$1: outputs the PR head" "$SHA_OUT" "$HEAD"
}
pass_verify "a squash group (compare diverged)" "open $HEAD" "diverged"
pass_verify "a group the PR head is behind" "open $HEAD" "behind"
pass_verify "an empty compare status" "open $HEAD" ""
pass_verify "the compare API failing" "open $HEAD" "ahead" STUB_CMP_FAIL=1
pass_verify "a malformed merge group sha" "open $HEAD" "ahead" MG_SHA=nope
pass_verify "an empty merge group sha" "open $HEAD" "ahead" MG_SHA=
verify "open $HEAD" "diverged"
check "a diverged group is logged as such" "$(grep -c "compare says 'diverged' (diagnostic, not a gate)" "$T/log")" "1"
verify "open $HEAD" "ahead" STUB_CMP_FAIL=1
check "a failed compare is logged as unavailable" "$(grep -c "compare says 'unavailable'" "$T/log")" "1"

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
# shellcheck disable=SC2016
check "the queue job judges the sha from the verify step" "$(grep -c 'head_sha: ${{ needs.queue-ref.outputs.sha }}' "$WF")" "1"
# shellcheck disable=SC2016
check "that sha output comes from verify, not parse" "$(grep -c 'sha: ${{ steps.verify.outputs.sha }}' "$WF")" "1"

if [ "$FAILS" -ne 0 ]; then
    echo "$FAILS failed"
    exit 1
fi
echo "all passed"
