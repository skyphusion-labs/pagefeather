#!/bin/bash
# shellcheck shell=bash
# deploy-upload.sh (#751): upload the Worker with its secrets in the same version.
# Sourced by deploy/deploy.sh.
#
# wrangler 4.107.0 (the pin in deploy/tools) accepts `deploy --secrets-file`
# (JSON or .env). Checked in this clone: `wrangler deploy --help` and
# node_modules/wrangler/wrangler-dist/cli.js (`"secrets-file"`). Secrets go in
# at that deploy. A second secrets upload after that would publish another version.
# The id that serves is not wrangler's Current Version ID. It is read after
# the upload (pf_print_serving_version): a settings PATCH, when logs are on,
# can still publish a version, and that later version is the one that serves.
#
# deploy_code_and_secrets: unless CODE_ONLY=1 (secrets persist; no Terraform
# state to read them from), write the secrets JSON mode 600 in a mktemp dir
# and pass --secrets-file. Prints Total Upload (from wrangler). Does not print
# the serving version: a later step (obs_redact, when logs are on) can publish
# another version, so the version line is pf_print_serving_version, after that
# step. Sets DEP and URL. Needs ROOT, NAME, CONF, CODE_ONLY, TF, tf,
# deploy_secrets_json, deployed_workers_url. WR points at the pinned wrangler;
# a test stubs it.
#
# wrangler 4.107.0 --secrets-file (deploy/tools): "Applies additively with
# secrets from previous deployments - omitted secrets will not be deleted."
# The flag stays on the deploy. A later secret update would publish again.

_pf_secrets_dir=
_pf_secrets_prev=
_pf_secrets_prev_cmd=

# Delete the secrets dir on EXIT, and keep any EXIT trap already set (the
# approach-A docker prime, or a test's temp dir).
_pf_secrets_arm() {
  _pf_secrets_dir=$1
  _pf_secrets_prev=$(trap -p EXIT 2>/dev/null || true)
  _pf_secrets_prev_cmd=$(printf '%s\n' "$_pf_secrets_prev" | sed -n "s/^trap -- '\\(.*\\)' EXIT\$/\\1/p")
  trap '_pf_secrets_on_exit' EXIT
}
_pf_secrets_on_exit() {
  [ -n "${_pf_secrets_dir:-}" ] && rm -rf -- "$_pf_secrets_dir"
  _pf_secrets_dir=
  eval "${_pf_secrets_prev_cmd:-true}"
}
_pf_secrets_disarm() {
  [ -n "${_pf_secrets_dir:-}" ] && rm -rf -- "$_pf_secrets_dir"
  _pf_secrets_dir=
  if [ -n "${_pf_secrets_prev:-}" ]; then
    eval "$_pf_secrets_prev"
  else
    trap - EXIT
  fi
  _pf_secrets_prev=
  _pf_secrets_prev_cmd=
}

# pf_print_serving_version: the version that serves, from the Cloudflare API.
# Call it after the last step that can publish a version (the upload, then
# obs_redact). GET /accounts/{account}/workers/scripts/{name}/deployments.
# The first deployment is the latest. Its version at 100 percent is the one
# that serves. Prints "Serving Version ID: <id>". A read that does not return
# that id fails the deploy. The token goes to curl -K through a process
# substitution, never argv. WFP_API overrides the API base (the same seam as
# deploy/wfp/obs_settings.py). Unset, the URL is the live deployments endpoint.
# Needs ACCOUNT_ID, NAME, CLOUDFLARE_API_TOKEN.
pf_print_serving_version() {
  local base vid
  base=${WFP_API:-https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID}
  # pipefail stays inside the subshell, so a curl failure is not python's exit.
  vid=$(
    set -o pipefail
    curl -sf --max-time 60 -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") \
      "$base/workers/scripts/$NAME/deployments" | python3 -I -c '
import json, sys
try:
    d = json.load(sys.stdin)
    deps = (d.get("result") or {}).get("deployments") or []
    if d.get("success") is not True or not deps:
        sys.exit(2)
    # Newest first. Only that deployment. An older one can also be at 100 percent.
    vers = deps[0].get("versions") or []
    got = [v.get("version_id") for v in vers if v.get("percentage") == 100 and v.get("version_id")]
    if len(got) != 1:
        sys.exit(2)
    print(got[0])
except Exception:
    sys.exit(2)
'
  ) || { echo "the serving version could not be read from the deployments API; the deploy stops" >&2; return 1; }
  [[ "$vid" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || {
    echo "the serving version could not be read from the deployments API; the deploy stops" >&2
    return 1
  }
  echo "Serving Version ID: $vid"
}

deploy_code_and_secrets() {
  local wr secdir secrets
  wr=${WR:-$ROOT/deploy/wr}
  DEP=
  URL=
  if [ "${CODE_ONLY:-0}" = 1 ]; then
    DEP=$("$wr" deploy --config "$CONF" 2>&1) || { echo "$DEP" | tail -20; return 1; }
    URL=$(deployed_workers_url "$NAME" <<<"$DEP")
    echo "$DEP" | grep -E 'Total Upload' || true
    return 0
  fi
  secdir=$(mktemp -d "${TMPDIR:-/tmp}/pf-secrets.XXXXXX")
  chmod 700 "$secdir"
  secrets="$secdir/secrets.json"
  _pf_secrets_arm "$secdir"
  tf "$TF" output -json | deploy_secrets_json "$secrets" || { _pf_secrets_disarm; return 1; }
  if ! DEP=$("$wr" deploy --config "$CONF" --secrets-file "$secrets" 2>&1); then
    echo "$DEP" | tail -20
    _pf_secrets_disarm
    return 1
  fi
  _pf_secrets_disarm
  URL=$(deployed_workers_url "$NAME" <<<"$DEP")
  echo "$DEP" | grep -E 'Total Upload' || true
}
