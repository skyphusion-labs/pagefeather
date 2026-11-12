#!/usr/bin/env bash
# Wrangler runs only through deploy/wr, which runs the version pinned in deploy/tools.
# A bare `npx wrangler` runs whatever is installed globally or fetches the latest, with
# CLOUDFLARE_API_TOKEN in its environment. This fails on any such call in a tracked script,
# workflow or Dockerfile, and on a missing or loose pin.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: got '$2', want '$3'"; fails=$((fails+1)); fi; }

# scan_bare <files...>: print file:line for every bare npx wrangler call
scan_bare() { grep -nE 'npx[[:space:]]+(-y[[:space:]]+|--yes[[:space:]]+)?wrangler' -- "$@" 2>/dev/null; }

# Control: the scan can go red on a bare call, with and without -y.
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
printf '%s\n' 'npx wrangler deploy' > "$T/bare.sh"
printf '%s\n' 'npx -y wrangler@latest deploy' > "$T/bare-y.sh"
printf '%s\n' 'deploy/wr deploy' > "$T/clean.sh"
check "control: a bare npx wrangler call is found" "$(scan_bare "$T/bare.sh" | wc -l | tr -d ' ')" "1"
check "control: npx -y wrangler@latest is found" "$(scan_bare "$T/bare-y.sh" | wc -l | tr -d ' ')" "1"
check "control: a deploy/wr call is not flagged" "$(scan_bare "$T/clean.sh" | wc -l | tr -d ' ')" "0"

# The real tree: scripts, workflows, Dockerfiles. Prose (*.md, docs/) records historical
# commands and is not a call site; this file and deploy/wr name the pattern on purpose.
FILES=(); while IFS= read -r f; do FILES+=("$f"); done < <(git ls-files | grep -vE '\.md$|^docs/|^deploy/tests/wrangler-pin-test\.sh$|^deploy/wr$')
check "the scan read a real population of files" "$([ "${#FILES[@]}" -gt 50 ] && echo yes || echo no)" "yes"
check "no bare npx wrangler in a tracked script, workflow or Dockerfile" "$(scan_bare "${FILES[@]}" | wc -l | tr -d ' ')" "0"
scan_bare "${FILES[@]}" | sed 's/^/        /'

# A bare `wrangler <command>` in a shell script runs whatever is on PATH (#371): on the laptop a
# global Homebrew copy, on a GitHub runner nothing, so run.sh's wrangler dev never started and the
# zarapo OPcache build timed out. A call is one at command position (line start, after ( ; & | { or
# $(, or after VAR=value prefixes). Comments, quoted text (echo "...", pkill -f "...") and "$WR"
# calls are not calls.
scan_bare_call() { grep -nE '(^|[;&|({]|\$\(|=[^[:space:]]*[[:space:]]+)[[:space:]]*wrangler[[:space:]]+(dev|deploy|tail|secret|r2|kv|d1|versions|whoami)([[:space:])]|$)' -- "$@" 2>/dev/null | grep -vE '^([^:]+:)?[0-9]+:[[:space:]]*#'; }
printf '%s\n' 'wrangler dev --port 1' '(wrangler dev --port 1 > dev.log 2>&1 &)' 'X=1 Y=2 wrangler deploy --env a' 'd=$(wrangler deploy)' > "$T/call.sh"
printf '%s\n' '"$WR" dev --port 1' 'pkill -f "wrangler dev --port 1"' 'echo "wrangler dev did not answer"' '# wrangler dev in a comment' 'deploy/wr deploy' > "$T/nocall.sh"
check "control: 4 bare wrangler calls are found" "$(scan_bare_call "$T/call.sh" | wc -l | tr -d ' ')" "4"
check "control: \$WR, a pkill pattern, an echo and a comment are not calls" "$(scan_bare_call "$T/nocall.sh" | wc -l | tr -d ' ')" "0"
SH=(); while IFS= read -r f; do SH+=("$f"); done < <(printf '%s\n' "${FILES[@]}" | grep -E '\.sh$')
check "the call scan read a real population of shell scripts" "$([ "${#SH[@]}" -gt 30 ] && echo yes || echo no)" "yes"
check "no bare wrangler call in a tracked shell script" "$(scan_bare_call "${SH[@]}" | wc -l | tr -d ' ')" "0"
scan_bare_call "${SH[@]}" | sed 's/^/        /'

# The pin: exact version, present in the lockfile, and the wrapper uses node_modules/.bin.
P=deploy/tools/package.json
ver=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["devDependencies"]["wrangler"])' "$P" 2>/dev/null)
check "wrangler is an exact version (no ^, ~, range or tag)" "$(printf '%s' "$ver" | grep -cE '^[0-9]+\.[0-9]+\.[0-9]+$')" "1"
lockver=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["packages"]["node_modules/wrangler"]["version"])' deploy/tools/package-lock.json 2>/dev/null)
check "the lockfile carries the same wrangler version" "$lockver" "$ver"
check "deploy/wr runs node_modules/.bin/wrangler" "$(grep -c 'node_modules/.bin/wrangler' deploy/wr)" "1"
check "deploy/wr is executable" "$([ -x deploy/wr ] && echo yes || echo no)" "yes"

echo "$fails failing case(s)"
exit "$fails"
