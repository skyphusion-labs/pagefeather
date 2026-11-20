#!/bin/bash
# #1108 part 3: a deploy.sh site records its inputs in its own Terraform state (output deploy_inputs), and a rebuild
# whose inputs differ is shown the difference and refused unless REPLACE_INPUTS=1. A stub terraform answers
# `output -raw deploy_inputs` from a file, so deploy/lib/recorded-inputs.sh is tested with no Cloudflare.
#   deploy/tests/recorded-inputs-test.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/recorded-inputs-test.XXXXXX"); trap 'rm -rf "${T:?}"' EXIT
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails + 1)); fi; }
mkdir -p "$T/bin" "$T/tf"
cat > "$T/bin/terraform" <<STUB
#!/bin/bash
case "\$1" in
  workspace) [ -e "$T/ws" ] && exit 0; exit 1 ;;
  output) [ -f "$T/rec" ] && { cat "$T/rec"; exit 0; }; echo "Warning: No outputs found" >&2; exit 1 ;;
esac
exit 0
STUB
chmod +x "$T/bin/terraform"
# shellcheck source=../lib/recorded-inputs.sh
. "$ROOT/deploy/lib/recorded-inputs.sh"
# record <env assignments...>: what a deploy with those settings records (the base64 value).
record() { env -i PATH="$PATH" "$@" bash -c '. "'"$ROOT"'/deploy/lib/recorded-inputs.sh"; deploy_inputs_value'; }
check() { # check <recorded value or ""> <env assignments...>
  local rec=$1; shift; rm -f "$T/rec" "$T/ws"; touch "$T/ws"; [ -n "$rec" ] && printf '%s' "$rec" > "$T/rec"
  env -i PATH="$T/bin:$PATH" "$@" bash -c '. "'"$ROOT"'/deploy/lib/recorded-inputs.sh"; inputs_check "'"$T/tf"'" site1' > "$T/out" 2> "$T/err"
}
R=$(record VARIANT=b-dosql LOCATION=enam MEDIA=1 WOO_ACTIVE=0 MAIL_FROM=wp-test@example.co)
ok "the recorded value is base64 of JSON with the set names only" "$(printf '%s' "$R" | base64 -d 2>/dev/null | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(1 if d=={"VARIANT":"b-dosql","LOCATION":"enam","MEDIA":"1","WOO_ACTIVE":"0","MAIL_FROM":"wp-test@example.co"} else 0)')"
S=$(record VARIANT=a MYSQL_PASSWORD=s3cret TURNSTILE_SECRET=t0p CLOUDFLARE_API_TOKEN=tok)
ok "no secret is ever recorded (MYSQL_PASSWORD, TURNSTILE_SECRET, CLOUDFLARE_API_TOKEN), and the record is real (VARIANT a is in it)" "$(printf '%s' "$S" | base64 -d 2>/dev/null | grep -q '"VARIANT": "a"' && ! printf '%s' "$S" | base64 -d | grep -qE 's3cret|t0p|tok' && echo 1 || echo 0)"
check "$R" VARIANT=b-dosql LOCATION=enam MEDIA=1 WOO_ACTIVE=0 MAIL_FROM=wp-test@example.co; rc=$?
ok "the same inputs pass (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"
check "$R" VARIANT=b-dosql LOCATION=enam MEDIA=0 WOO_ACTIVE=0 MAIL_FROM=wp-test@example.co; rc=$?
ok "a changed MEDIA is refused (rc $rc)" "$([ $rc = 2 ] && echo 1 || echo 0)"
ok "  the difference is shown: MEDIA recorded 1, this run 0" "$(grep -q "MEDIA: recorded '1', this run '0'" "$T/err" && echo 1 || echo 0)"
ok "  and REPLACE_INPUTS=1 is named" "$(grep -q 'REPLACE_INPUTS=1' "$T/err" && echo 1 || echo 0)"
check "$R" VARIANT=b-dosql LOCATION=enam MEDIA=1 WOO_ACTIVE=0; rc=$?
ok "a setting recorded but UNSET in this run is refused, not silently dropped (rc $rc)" "$([ $rc = 2 ] && grep -q "MAIL_FROM: recorded 'wp-test@example.co', this run ''" "$T/err" && echo 1 || echo 0)"
check "$R" VARIANT=b-dosql LOCATION=enam MEDIA=1 WOO_ACTIVE=0 MAIL_FROM=wp-test@example.co PLACEMENT=azure:westus2; rc=$?
ok "a NEW setting in this run is a difference too (rc $rc)" "$([ $rc = 2 ] && grep -q "PLACEMENT: recorded '', this run 'azure:westus2'" "$T/err" && echo 1 || echo 0)"
check "$R" VARIANT=b-dosql LOCATION=enam MEDIA=0 WOO_ACTIVE=0 REPLACE_INPUTS=1; rc=$?
ok "REPLACE_INPUTS=1 accepts the differences on purpose, and says so (rc $rc)" "$([ $rc = 0 ] && grep -q 'REPLACE_INPUTS=1: the recorded inputs are replaced' "$T/err" && echo 1 || echo 0)"
check "" VARIANT=b-dosql MEDIA=1; rc=$?
ok "a site with no record (new, or deployed before #1108) passes and says it records now (rc $rc)" "$([ $rc = 0 ] && grep -q 'no recorded inputs' "$T/err" && echo 1 || echo 0)"
check "!!not-base64!!" VARIANT=b-dosql; rc=$?
ok "an unreadable record is a refusal, never a pass (rc $rc)" "$([ $rc = 2 ] && echo 1 || echo 0)"
# Wiring: deploy.sh renders the record into the var file, checks before media_guard, and Terraform carries the output.
ok "deploy.sh writes deploy_inputs into the site's var file" "$(grep -q 'deploy_inputs  *= ' "$ROOT/deploy/deploy.sh" && echo 1 || echo 0)"
c=$(grep -n 'inputs_check "\$TF"' "$ROOT/deploy/deploy.sh" | head -1 | cut -d: -f1); g=$(grep -n 'media_guard "\$TF"' "$ROOT/deploy/deploy.sh" | head -1 | cut -d: -f1)
ok "deploy.sh runs inputs_check before media_guard (lines ${c:-none} and ${g:-none})" "$([ -n "$c" ] && [ -n "$g" ] && [ "$c" -lt "$g" ] && echo 1 || echo 0)"
ok "Terraform declares the deploy_inputs variable and output" "$(grep -q 'variable "deploy_inputs"' "$ROOT/deploy/terraform/variables.tf" && grep -q 'output "deploy_inputs"' "$ROOT/deploy/terraform/outputs.tf" && echo 1 || echo 0)"
[ "$fails" = 0 ] && echo "recorded-inputs: all checks pass" || echo "recorded-inputs: $fails failing check(s)"
exit $((fails > 0))
