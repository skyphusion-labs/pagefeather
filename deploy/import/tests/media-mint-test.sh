#!/bin/bash
# #1031: import.sh's media step puts the uploads into R2 with a TEMPORARY R2 credential for the
# site's media bucket (deploy/wfp/r2_temp.py), never an account token (media-import.tf, which
# needs API Tokens Write). It runs the real media_step, cut out of import.sh, with stand-ins for
# Terraform and media.sh, against deploy/wfp/tests/fake-r2-temp.py. No account.
#   deploy/import/tests/media-mint-test.sh [another import.sh]
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
IMPORT_SH=${1:-$REPO/deploy/import.sh}
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/media-mint-test.XXXXXX")
python3 -I "$REPO/deploy/wfp/tests/fake-r2-temp.py" "$T/port" & PID=$!
trap 'kill $PID 2>/dev/null; wait $PID 2>/dev/null; rm -rf "$T"' EXIT
for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
R2="http://127.0.0.1:$(cat "$T/port")"
eval "$(sed -n '/^media_step() {/,/^}/p' "$IMPORT_SH")"
type media_step >/dev/null 2>&1 || { echo "FAIL media_step was not found in $IMPORT_SH"; exit 1; }
# The stand-ins: Terraform answers the outputs and logs anything else; media.sh logs what it got.
tf_ready() { return 0; }
tfi() { case "$*" in
  "output -raw media_bucket") echo site-x-media ;;
  "output -raw r2_endpoint") echo "$R2" ;;
  *) echo "$*" >> "$T/tf.log"; return 1 ;; esac; }
mkdir -p "$T/imp" "$T/src/wp-content/uploads/2026" "$T/tf/sites"
echo x > "$T/src/wp-content/uploads/2026/a.jpg"
cat > "$T/imp/media.sh" <<'SH'
#!/bin/bash
# Logs: the endpoint, the bucket, and whether a readable credential file with all three values came in.
ok=no
if [ -n "${R2_CRED_FILE:-}" ] && [ -r "$R2_CRED_FILE" ]; then ( . "$R2_CRED_FILE"; [ -n "$R2_KEY_ID" ] && [ -n "$R2_SECRET" ] && [ -n "$R2_SESSION_TOKEN" ] ) && ok=yes; fi
echo "$1 $2 cred=$ok refresh=$([ -n "${R2_CRED_REFRESH:-}" ] && echo set || echo none)" >> "$MEDIA_LOG"
echo "media: 0 sent, 1 already there, 0 failed"
SH
chmod +x "$T/imp/media.sh"
state() { python3 -I -c 'import json, sys, urllib.request; d = json.load(urllib.request.urlopen(sys.argv[1] + "/_state")); print(eval(sys.argv[2]))' "$R2" "$1"; }
run() { # media_step in a subshell (it exits on a failure), output in $T/out
  : > "$T/tf.log"; : > "$T/media.log"; rm -rf "$T/work"; mkdir -m 700 "$T/work"
  # shellcheck disable=SC2034 # read by media_step, which eval brought in
  ( ROOT=$REPO IMP=$T/imp WORK=$T/work SRC_CONTENT=$T/src/wp-content NAME=site-x TF=$T/tf; export MEDIA_LOG=$T/media.log
    export CLOUDFLARE_API_TOKEN=test ACCOUNT_ID=test WFP_API="$R2/api"; unset SKIP_MEDIA MEDIA_BUCKET
    media_step; echo "rc=$?" ) > "$T/out" 2>&1 || echo "rc=$?" >> "$T/out"
}
run
check "the media step sends with a temporary credential: media.sh runs twice, with the credential file" "$(cat "$T/media.log" | tr '\n' ';')" "$R2 site-x-media cred=yes refresh=set;$R2 site-x-media cred=yes refresh=set;"
check "  one mint, for that bucket only, object-read-write" "$(state '[ (m["bucket"], m["permission"]) for m in d["mints"] ]')" "[('site-x-media', 'object-read-write')]"
check "  Terraform is never applied (no account token)" "$(wc -l < "$T/tf.log" | tr -d ' ')" "0"
check "  the credential file is removed after the step" "$([ -e "$T/work/r2-temp.cred" ] && echo kept || echo gone)" "gone"
check "  the step returns 0" "$(grep -c '^rc=0$' "$T/out")" "1"
curl -s -o /dev/null -X POST "$R2/_refuse_mint"
run
check "a refused mint: the step stops, nothing is sent" "$(grep -c '^rc=1$' "$T/out"):$(wc -l < "$T/media.log" | tr -d ' '):$(grep -c 'nothing was sent' "$T/out")" "1:0:1"
echo "$fails failing case(s)"
[ "$fails" = 0 ]
