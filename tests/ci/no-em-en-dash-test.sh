#!/bin/bash
# The "No em or en dashes" step must FAIL on a text file that holds a real em dash
# (U+2014) and PASS on a binary file that holds the same byte sequence.
# This runs the git grep line from that step, so today's command (no -I) is red
# on the binary case and the command with -I is green (#593).
#   tests/ci/no-em-en-dash-test.sh
# Needs bash, git, python3. Exits 0 only when both cases hold.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
WF="$ROOT/.github/workflows/ci.yml"
fails=0
work=$(mktemp -d "${TMPDIR:-/tmp}/no-em-en-dash.XXXXXX")
trap 'rm -rf "$work"' EXIT

say() { printf '%s\n' "$1"; }

if [ ! -f "$WF" ]; then
  say "FAIL missing $WF"
  exit 1
fi

lines=$(grep -F 'x{2014}' "$WF" | grep -F 'git grep' || true)
n=0
if [ -n "$lines" ]; then
  n=$(printf '%s\n' "$lines" | wc -l | tr -d ' ')
fi
if [ "$n" != 1 ]; then
  say "FAIL expected one dash-gate git grep line in ci.yml, found $n"
  exit 1
fi

cmd=$(printf '%s\n' "$lines" | sed -n 's/.*\(git grep [^;]*\).*/\1/p' | sed 's/[[:space:]]*$//')
case "$cmd" in
  git\ grep*'x{2014}'*'x{2013}'*package-lock.json*) ;;
  *)
    say "FAIL could not parse the dash gate command"
    exit 1
    ;;
esac
say "gate command: $cmd"

# git grep exit status. Match lines are discarded so a dash byte never hits the log.
run_gate() {
  d=$1
  (
    cd "$d" || exit 99
    unset GIT_DIR GIT_WORK_TREE
    bash -c "$cmd" >/dev/null
  )
}

# $1 path, $2 "1" if the file must contain a NUL (binary), "0" if it must not.
check_bytes() {
  python3 - "$1" "$2" <<'PY'
import pathlib, sys
b = pathlib.Path(sys.argv[1]).read_bytes()
seq = bytes((0xE2, 0x80, 0x94))
want_nul = sys.argv[2] == "1"
ok = seq in b and ((0 in b) == want_nul)
sys.exit(0 if ok else 1)
PY
}

new_repo() {
  d=$1
  rm -rf "$d"
  mkdir -p "$d"
  git -C "$d" init -q -b main
}

td="$work/text"
new_repo "$td"
printf 'alpha \xe2\x80\x94 omega\n' > "$td/note.txt"
if ! check_bytes "$td/note.txt" 0; then
  say "FAIL text fixture is not a text file holding the em dash bytes"
  exit 1
fi
git -C "$td" add note.txt
run_gate "$td"
trc=$?
if [ "$trc" -eq 0 ]; then
  say "PASS text: gate FAILS on a text file holding an em dash (git grep exit 0)"
else
  say "FAIL text: gate did not FAIL on a text file holding an em dash (git grep exit $trc)"
  fails=$((fails + 1))
fi

bd="$work/bin"
new_repo "$bd"
printf 'alpha \x00\xe2\x80\x94 omega\n' > "$bd/blob.bin"
if ! check_bytes "$bd/blob.bin" 1; then
  say "FAIL binary fixture does not hold a NUL plus the same em dash bytes"
  exit 1
fi
git -C "$bd" add blob.bin
run_gate "$bd"
brc=$?
if [ "$brc" -eq 1 ]; then
  say "PASS binary: gate PASSES on a binary file holding the same byte sequence (git grep exit 1)"
else
  say "FAIL binary: gate did not PASS on a binary file holding the same byte sequence (git grep exit $brc)"
  fails=$((fails + 1))
fi

say "$fails failing check(s)"
exit "$fails"
