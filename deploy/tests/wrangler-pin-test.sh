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
