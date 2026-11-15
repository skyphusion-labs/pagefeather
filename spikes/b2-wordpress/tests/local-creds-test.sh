#!/usr/bin/env bash
# #682: opcache.sh and file-trace.sh build against a LOCAL dev server, which must run with the local
# token and admin password. Before, both scripts (and run.sh, opcache-activate.sh, e2e.sh, woo.py under
# them) took SPIKE_TOKEN and ADMIN_PASSWORD from the caller. A caller with a site's real values exported
# started the local server on the real token and sent the wrong password, so /_activate ran as a
# non-operator, answered 200 with an empty body, and WooCommerce did not activate (four ggc.sh updates).
# Now local-creds.sh pins the local values, says which variable it ignored, and never prints a value.
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
run() { # run <env assignments...>: source local-creds.sh in a clean shell, print the values a child sees
  env -i PATH="$PATH" "$@" bash -c ". '$HERE/local-creds.sh' && local_creds && bash -c 'echo \"T=\$SPIKE_TOKEN P=\$ADMIN_PASSWORD\"'" 2>&1
}

o=$(run SPIKE_TOKEN=realsitetoken123 ADMIN_PASSWORD=realsitepass456)
ok "a caller's values are replaced by the local ones, for children too" "$(echo "$o" | grep -qx 'T=local-spike-token P=local-spike-password' && echo 1 || echo 0)"
ok "the note names SPIKE_TOKEN" "$(echo "$o" | grep -q 'SPIKE_TOKEN' && echo 1 || echo 0)"
ok "the note names ADMIN_PASSWORD" "$(echo "$o" | grep -q 'ADMIN_PASSWORD .*ignored\|ignored.*ADMIN_PASSWORD' && echo 1 || echo 0)"
ok "no value is printed" "$(echo "$o" | grep -q 'realsitetoken123\|realsitepass456' && echo 0 || echo 1)"

o=$(run)
ok "nothing set: the local values, no note" "$([ "$o" = 'T=local-spike-token P=local-spike-password' ] && echo 1 || echo 0)"
o=$(run SPIKE_TOKEN=local-spike-token ADMIN_PASSWORD=local-spike-password)
ok "the local values set: no note" "$([ "$o" = 'T=local-spike-token P=local-spike-password' ] && echo 1 || echo 0)"
o=$(run SPIKE_TOKEN= ADMIN_PASSWORD=)
ok "empty values: the local values, no note" "$([ "$o" = 'T=local-spike-token P=local-spike-password' ] && echo 1 || echo 0)"

# Wiring: both scripts pin the values before they start the dev server (run.sh) and before any request.
for s in opcache.sh file-trace.sh; do
  f="$HERE/$s"
  lc=$(grep -n '^local_creds$' "$f" | head -1 | cut -d: -f1)
  rs=$(grep -n '\./run\.sh _ping' "$f" | head -1 | cut -d: -f1)
  ok "$s calls local_creds before ./run.sh _ping" "$([ -n "$lc" ] && [ -n "$rs" ] && [ "$lc" -lt "$rs" ] && echo 1 || echo 0)"
  ok "$s sources local-creds.sh" "$(grep -q '^\. \./local-creds\.sh$' "$f" && echo 1 || echo 0)"
done

echo "$fails failing case(s)"
[ "$fails" = 0 ]
