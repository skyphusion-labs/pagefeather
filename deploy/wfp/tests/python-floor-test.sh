#!/bin/bash
# Test of #1385: site update refuses a python3 older than 3.11 before it changes anything (the rollback reads the
# config with tomllib, which 3.9 does not have). python_floor_check (lib.sh) on its own, against a stand-in
# python3 that reports 3.9, and the real one; and the site file calls it for update before shared init.
#   deploy/wfp/tests/python-floor-test.sh [another site file]
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
SITE=${1:-$HERE/../site}
ACCOUNT_ID=test
# shellcheck disable=SC1091
. "$HERE/../lib.sh"
fails=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/old"
cat > "$T/old/python3" <<'PY'
#!/bin/bash
# A stand-in python3 3.9: -V prints the version; the version check (-c) fails as 3.9 would.
case "$*" in *-V*) echo "Python 3.9.6"; exit 0 ;; *version_info*) exit 1 ;; esac
exit 1
PY
chmod +x "$T/old/python3"
msg=$( (PATH="$T/old:$PATH"; python_floor_check) 2>&1); rc=$?
check "python 3.9: refused (2)" "$rc" 2
check "  the message names the version found" "$(printf '%s' "$msg" | grep -c 'this python3 is Python 3.9.6')" 1
check "  and says nothing was changed" "$(printf '%s' "$msg" | grep -c 'Nothing was changed')" 1
python_floor_check 2>/dev/null; check "the real python3 ($(python3 -V 2>&1)): accepted (0)" "$?" 0
# The site file calls it for update, before shared init (so before the build and any upload).
call=$(grep -n '^if \[ "$cmd" = update \]; then python_floor_check || exit 2; fi$' "$SITE" | cut -d: -f1)
init=$(grep -n '^tfr shared init' "$SITE" | head -1 | cut -d: -f1)
check "the site file calls python_floor_check for update" "$([ -n "$call" ] && echo yes || echo no)" yes
check "  before shared init" "$([ -n "$call" ] && [ -n "$init" ] && [ "$call" -lt "$init" ] && echo yes || echo no)" yes
echo "$fails failing check(s)"
[ "$fails" = 0 ]
