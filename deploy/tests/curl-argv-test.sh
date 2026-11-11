#!/usr/bin/env bash
# The spike token and the admin password reach curl through a config on a file descriptor
# (-K <(printf ...)), never as -H on the command line, where every user of the host can read
# them in the process list while curl runs. This fails on a -H carrying either value in the
# deploy and test scripts, and proves the -K form delivers the headers without exposing them.
# This file holds the -H form on purpose (a control), so it is not scanned. spikes/ is local wrangler dev against localhost with a published default token and is out of scope.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: got '$2', want '$3'"; fails=$((fails+1)); fi; }

PAT='-H[[:space:]]+["'"'"']x-(spike-token|admin-password):[[:space:]]*\$'
scan() { grep -nE -- "$PAT" "$@" 2>/dev/null; }

T=$(mktemp -d); trap 'kill "${SPID:-}" 2>/dev/null; rm -rf "$T"' EXIT
printf '%s\n' 'curl -H "x-spike-token: $SPIKE_TOKEN" "$URL"' > "$T/a.sh"
printf '%s\n' 'curl -H "x-admin-password: $ADMIN_PASSWORD" "$URL"' > "$T/b.sh"
printf '%s\n' "curl -K <(printf 'header = \"x-spike-token: %s\"\\n' \"\$SPIKE_TOKEN\") \"\$URL\"" > "$T/c.sh"
check "control: -H x-spike-token with a variable is found" "$(scan "$T/a.sh" | wc -l | tr -d ' ')" "1"
check "control: -H x-admin-password with a variable is found" "$(scan "$T/b.sh" | wc -l | tr -d ' ')" "1"
check "control: the -K form is not flagged" "$(scan "$T/c.sh" | wc -l | tr -d ' ')" "0"

FILES=(); while IFS= read -r f; do FILES+=("$f"); done < <(git ls-files 'deploy/*.sh' 'deploy/**/*.sh' 'tests/*.sh' 'tests/**/*.sh' | grep -v '^deploy/tests/curl-argv-test\.sh$' | sort -u)
check "the scan read a real population of scripts" "$([ "${#FILES[@]}" -gt 15 ] && echo yes || echo no)" "yes"
check "no -H carries the spike token or admin password in a deploy or test script" "$(scan "${FILES[@]}" | wc -l | tr -d ' ')" "0"
scan "${FILES[@]}" | sed 's/^/        /'

# The mechanism, against a real server and a real curl: the header arrives, and the value is
# not in curl's argv while the request is in flight.
if command -v python3 >/dev/null && command -v curl >/dev/null; then
  PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
  python3 - "$PORT" "$T/seen" <<'PY' &
import sys, time, http.server
port, out = int(sys.argv[1]), sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/ready":
            open(out, "a").write("%s|%s\n" % (self.headers.get("x-spike-token"), self.headers.get("x-admin-password")))
            time.sleep(2)
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
PY
  SPID=$!; disown "$SPID" 2>/dev/null || true
  for _ in $(seq 1 50); do curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/ready" && break; sleep 0.1; done
  : > "$T/seen"
  SPIKE_TOKEN=tok-$RANDOM$RANDOM ADMIN_PASSWORD=pw-$RANDOM$RANDOM
  curl -s -m 10 -K <(printf 'header = "x-spike-token: %s"\nheader = "x-admin-password: %s"\n' "$SPIKE_TOKEN" "$ADMIN_PASSWORD") "http://127.0.0.1:$PORT/" >/dev/null &
  CPID=$!
  sleep 0.7
  argv=$(ps -o args= -p "$CPID" 2>/dev/null)
  check "curl was running while its argv was read" "$([ -n "$argv" ] && echo yes || echo no)" "yes"
  check "the token is not in curl's argv" "$(printf '%s' "$argv" | grep -c -- "$SPIKE_TOKEN")" "0"
  check "the password is not in curl's argv" "$(printf '%s' "$argv" | grep -c -- "$ADMIN_PASSWORD")" "0"
  wait "$CPID"
  check "the server received both headers" "$(grep -cxF -- "$SPIKE_TOKEN|$ADMIN_PASSWORD" "$T/seen" 2>/dev/null)" "1"
  # Negative control: the -H form IS visible, so the argv check above can fail.
  curl -s -m 10 -H "x-spike-token: $SPIKE_TOKEN" "http://127.0.0.1:$PORT/" >/dev/null &
  CPID=$!; sleep 0.7
  check "control: a -H token is visible in argv, so the check can go red" "$(ps -o args= -p "$CPID" 2>/dev/null | grep -c -- "$SPIKE_TOKEN")" "1"
  wait "$CPID"
else
  echo "  SKIP the mechanism check needs python3 and curl"
fi

echo "$fails failing case(s)"
exit "$fails"
