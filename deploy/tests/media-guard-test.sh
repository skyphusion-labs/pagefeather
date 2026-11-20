#!/bin/bash
# #1108: deploy.sh never deletes an existing media bucket by default. A stub terraform answers `state list` and
# `show -json` from files, so the guard (deploy/lib/media-guard.sh) is tested with no Cloudflare and no provider.
#   deploy/tests/media-guard-test.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/media-guard-test.XXXXXX"); trap 'rm -rf "${T:?}"' EXIT
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails + 1)); fi; }
mkdir -p "$T/bin" "$T/tf/sites"
# The stub: `workspace select <n>` fails unless $T/ws/<n> exists; `state list` prints $T/state; `plan ... -out=<f>` writes
# $T/plan.json to <f>; `show -json <f>` prints it. Every call is logged.
cat > "$T/bin/terraform" <<STUB
#!/bin/bash
echo "\$*" >> "$T/tf.log"
case "\$1" in
  workspace) [ "\$2" = select ] && [ -e "$T/ws/\$3" ] && exit 0; [ "\$2" = select ] && [ "\$3" = -or-create ] && exit 0; exit 1 ;;
  state) [ -f "$T/state" ] && cat "$T/state"; exit 0 ;;
  plan) for a in "\$@"; do case "\$a" in -out=*) cp "$T/plan.json" "\${a#-out=}" ;; esac; done; exit 0 ;;
  show) cat "\${@: -1}"; exit 0 ;;
esac
exit 0
STUB
chmod +x "$T/bin/terraform"
PLAN_KEEP='{"resource_changes":[{"address":"cloudflare_r2_bucket.media[0]","type":"cloudflare_r2_bucket","change":{"actions":["no-op"]}}]}'
PLAN_DEL='{"resource_changes":[{"address":"cloudflare_r2_bucket.media[0]","type":"cloudflare_r2_bucket","change":{"actions":["delete"]}}]}'
PLAN_NONE='{"resource_changes":[]}'
run() { # run <MEDIA> <DESTROY_MEDIA> <has-workspace 0|1> <state file content> <plan json>
  rm -rf "$T/ws" "$T/state"; mkdir -p "$T/ws"; : > "$T/tf.log"
  [ "$3" = 1 ] && touch "$T/ws/site1"
  [ -n "$4" ] && printf '%s\n' "$4" > "$T/state"
  printf '%s\n' "$5" > "$T/plan.json"
  ( export PATH="$T/bin:$PATH" MEDIA="$1" DESTROY_MEDIA="$2"; . "$ROOT/deploy/lib/media-guard.sh"
    media_guard "$T/tf" site1 "sites/site1.tfvars" ) > "$T/out" 2> "$T/err"
}
STATE_BUCKET=$'cloudflare_r2_bucket.media[0]\ncloudflare_workers_kv_namespace.oc[0]'
run "" "" 1 "$STATE_BUCKET" "$PLAN_DEL"; rc=$?
ok "a rebuild with MEDIA unset on a site whose state holds a media bucket is REFUSED (rc $rc)" "$([ $rc = 2 ] && echo 1 || echo 0)"
ok "  the refusal names MEDIA and DESTROY_MEDIA" "$(grep -q 'MEDIA=1' "$T/err" && grep -q 'DESTROY_MEDIA=1' "$T/err" && echo 1 || echo 0)"
ok "  and no apply is ever run" "$(! grep -q '^apply' "$T/tf.log" && echo 1 || echo 0)"
# The state check on its own: the plan shows NO delete, so only check 1 can refuse (a mutant that drops check 1 goes red).
run "" "" 1 "$STATE_BUCKET" "$PLAN_NONE"; rc=$?
ok "the STATE check alone refuses MEDIA unset on a site with a bucket, even when the plan shows no delete (rc $rc)" "$([ $rc = 2 ] && grep -q 'has a media bucket' "$T/err" && echo 1 || echo 0)"
run 0 "" 1 "$STATE_BUCKET" "$PLAN_DEL"; rc=$?
ok "MEDIA=0 explicitly is refused the same way (rc $rc)" "$([ $rc = 2 ] && echo 1 || echo 0)"
run 1 "" 1 "$STATE_BUCKET" "$PLAN_KEEP"; rc=$?
ok "MEDIA=1 on a site with its bucket passes (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"
run "" "" 0 "" "$PLAN_NONE"; rc=$?
ok "a NEW site (no workspace) with MEDIA unset passes: nothing to lose (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"
run "" "" 1 "cloudflare_workers_kv_namespace.oc[0]" "$PLAN_NONE"; rc=$?
ok "an existing site that never had media passes with MEDIA unset (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"
run "" 1 1 "$STATE_BUCKET" "$PLAN_DEL"; rc=$?
ok "DESTROY_MEDIA=1 allows the delete, on purpose (rc $rc)" "$([ $rc = 0 ] && grep -q 'DESTROY_MEDIA=1' "$T/err" && echo 1 || echo 0)"
# The plan backstop: the state check passes (MEDIA=1), but the plan still deletes a bucket (a rename, a variant change).
run 1 "" 1 "$STATE_BUCKET" "$PLAN_DEL"; rc=$?
ok "the plan backstop refuses any r2 bucket delete even when MEDIA=1 (rc $rc)" "$([ $rc = 2 ] && grep -q 'cloudflare_r2_bucket.media\[0\]' "$T/err" && echo 1 || echo 0)"
# Wiring: deploy.sh runs the guard on the data plane, before its first apply.
g=$(grep -n 'media_guard "\$TF"' "$ROOT/deploy/deploy.sh" | head -1 | cut -d: -f1)
a=$(grep -n 'tf "\$TF" apply' "$ROOT/deploy/deploy.sh" | head -1 | cut -d: -f1)
ok "deploy.sh calls media_guard before its first data-plane apply (guard line ${g:-none}, apply line ${a:-none})" "$([ -n "$g" ] && [ -n "$a" ] && [ "$g" -lt "$a" ] && echo 1 || echo 0)"
[ "$fails" = 0 ] && echo "media-guard: all checks pass" || echo "media-guard: $fails failing check(s)"
exit $((fails > 0))
