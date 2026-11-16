#!/bin/bash
# shellcheck shell=bash
# deploy-upload.sh (#751): upload the Worker with its secrets in the same version.
# Sourced by deploy/deploy.sh.
#
# wrangler 4.107.0 (the pin in deploy/tools) accepts `deploy --secrets-file`
# (JSON or .env). Checked in this clone: `wrangler deploy --help` and
# node_modules/wrangler/wrangler-dist/cli.js (`"secrets-file"`). One deploy
# makes the serving version. Updating secrets after that upload would publish
# another version, and that later version is the one that serves.
#
# deploy_code_and_secrets: unless CODE_ONLY=1 (secrets persist; no Terraform
# state to read them from), write the secrets JSON mode 600 in a mktemp dir
# and pass --secrets-file. Prints Total Upload (from wrangler) and exactly one
# version id, labelled Serving Version ID. Fails if wrangler prints no
# Current Version ID. Sets DEP and URL. Needs ROOT, NAME, CONF, CODE_ONLY, TF,
# tf, deploy_secrets_json, deployed_workers_url. WR points at the pinned
# wrangler; a test stubs it.

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

_pf_print_serving_version() {
  local vid
  echo "$DEP" | grep -E 'Total Upload' || true
  vid=$(printf '%s\n' "$DEP" | grep -E 'Current Version ID:' | head -1 | awk '{print $NF}')
  [ -n "$vid" ] || { echo "deploy printed no Current Version ID; the serving version is unknown" >&2; return 1; }
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
    _pf_print_serving_version || return 1
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
  _pf_print_serving_version || return 1
}
