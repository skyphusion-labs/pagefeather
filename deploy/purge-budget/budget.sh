# shellcheck shell=bash
# #699 part B: is the account's purge budget (pf-purge-budget, deploy/purge-budget) there, and does this site bind it?
# Sourced by deploy/render-conf.sh, deploy/deploy.sh, deploy/wfp/lib.sh, deploy/wfp/site and deploy/wfp/site.sh.
#
# A site binds the budget when it is PRESENT on the account, and says so in its deploy output. When it is absent, or
# its presence cannot be read, the site deploys WITHOUT it and keeps part A's rules (purge-state.mjs): fail-open, the
# lead's ruling. The binding is exactly: name PURGE_BUDGET, class PurgeBudget, script_name pf-purge-budget (which
# deploy/wfp/bindings.py allows, and nothing else of that script).
#
# Needs CLOUDFLARE_API_TOKEN and ACCOUNT_ID (or CLOUDFLARE_ACCOUNT_ID). PURGE_BUDGET_API overrides the API base (tests).
PURGE_BUDGET_SCRIPT=pf-purge-budget

# purge_budget_present: prints yes, no or unknown. The token goes to curl only through -K.
purge_budget_present() {
  local acct=${ACCOUNT_ID:-${CLOUDFLARE_ACCOUNT_ID:-}} base=${PURGE_BUDGET_API:-https://api.cloudflare.com/client/v4} code
  if [ -z "$acct" ] || [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then echo unknown; return 0; fi
  code=$(curl -s -o /dev/null -m 30 -w '%{http_code}' -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") \
    "$base/accounts/$acct/workers/scripts/$PURGE_BUDGET_SCRIPT/settings") || code=000
  case "$code" in 200) echo yes ;; 404) echo no ;; *) echo unknown ;; esac
}

# purge_budget_decide <who>: sets PURGE_BUDGET_BIND (1 or 0) and prints which way this deploy goes.
# PURGE_BUDGET_BIND already set to 0 or 1 by the caller wins (tests, and an operator who wants part A only).
purge_budget_decide() {
  local who=${1:-this site} p
  case "${PURGE_BUDGET_BIND:-}" in
    0|1) echo "$who: purge budget: PURGE_BUDGET_BIND=$PURGE_BUDGET_BIND (set by the caller)" ;;
    *)
      p=$(purge_budget_present)
      case "$p" in
        yes) PURGE_BUDGET_BIND=1; echo "$who: purge budget: bound to $PURGE_BUDGET_SCRIPT (the account's, #699)" ;;
        no) PURGE_BUDGET_BIND=0; echo "$who: purge budget: none on this account; the site keeps part A's own rules (#699)" ;;
        *) PURGE_BUDGET_BIND=0; echo "$who: purge budget: its presence could NOT be read; deploying WITHOUT it, part A's rules (fail-open, #699)" >&2 ;;
      esac ;;
  esac
}

# purge_budget_toml_lines: the binding, one line each, when PURGE_BUDGET_BIND=1; nothing otherwise.
purge_budget_toml_lines() {
  [ "${PURGE_BUDGET_BIND:-0}" = 1 ] || return 0
  printf '%s\n' '[[durable_objects.bindings]]' 'name = "PURGE_BUDGET"' 'class_name = "PurgeBudget"' "script_name = \"$PURGE_BUDGET_SCRIPT\""
}

# purge_budget_toml_suffix: the same lines, each with a LEADING newline and none at the end, to append to an existing
# line of a heredoc. Unset renders nothing at all, so an unbound config stays byte-identical.
purge_budget_toml_suffix() {
  [ "${PURGE_BUDGET_BIND:-0}" = 1 ] || return 0
  printf '\n[[durable_objects.bindings]]\nname = "PURGE_BUDGET"\nclass_name = "PurgeBudget"\nscript_name = "%s"' "$PURGE_BUDGET_SCRIPT"
}
