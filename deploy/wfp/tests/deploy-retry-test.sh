#!/bin/bash
# Test of wrangler_deploy in deploy/wfp/lib.sh (issue #35): a bounded retry of
# the small workers.dev deploys, for the transient subdomain-enable error.
#   deploy/wfp/tests/deploy-retry-test.sh [another lib.sh]
# A stub npx on PATH fails the first <FAIL_N> attempts, then succeeds.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=${1:-$HERE/../lib.sh}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
cat > "$T/bin/npx" <<'SH'
#!/bin/sh
c=$(cat "$NPX_COUNT" 2>/dev/null || echo 0); c=$((c + 1)); echo "$c" > "$NPX_COUNT"
[ "$c" -gt "${FAIL_N:-0}" ] && exit 0
echo "stub npx: unknown error has occurred [code: 10013]" >&2; exit 1
SH
chmod +x "$T/bin/npx"
# shellcheck disable=SC1090
. "$LIB"
fails=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
run() { # run <FAIL_N>: prints "<rc> <attempts>"
  : > "$T/count"
  PATH="$T/bin:$PATH" NPX_COUNT="$T/count" FAIL_N="$1" WRANGLER_RETRIES=3 WRANGLER_RETRY_S=0 wrangler_deploy "$T" "$T/log" --config x.toml >/dev/null 2>&1
  echo "$? $(cat "$T/count")"
}
r=$(run 0); ok "succeeds first try: rc 0, 1 attempt (got $r)" "$([ "$r" = '0 1' ] && echo 1 || echo 0)"
r=$(run 2); ok "succeeds on the 3rd attempt: rc 0, 3 attempts (got $r)" "$([ "$r" = '0 3' ] && echo 1 || echo 0)"
r=$(run 9); ok "all attempts fail: rc non-0, exactly 3 attempts (bounded) (got $r)" "$([ "${r% *}" != 0 ] && [ "${r#* }" = 3 ] && echo 1 || echo 0)"
echo "$fails failing check(s)"
exit $fails
