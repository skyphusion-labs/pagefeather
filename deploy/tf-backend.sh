# shellcheck shell=bash
# Terraform state for deploy/ (sourced by deploy.sh and import.sh).
#
# Local by default: the state is in deploy/terraform/terraform.tfstate.d/ of
# the clone that ran deploy.sh, and only that clone has it. DEPLOY_STATE=r2
# keeps it in an R2 bucket (STATE_BUCKET, STATE_ENDPOINT, and an R2 key in
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY), so any clone can read it.
# Uses NAME.

# backend <root dir>: with DEPLOY_STATE=r2, write the backend override for
# that root (deploy/terraform or deploy/mysql).
backend() {
  if [ "${DEPLOY_STATE:-local}" != r2 ]; then
    # A backend_override.tf is left by an earlier DEPLOY_STATE=r2 run in this
    # clone, for THAT run's site (its state key). With local state it would
    # still be used, so a plain init could select another site's state.
    if [ -f "$1/backend_override.tf" ]; then
      echo "$1/backend_override.tf exists (from an earlier DEPLOY_STATE=r2 run, maybe for another site). Set DEPLOY_STATE=r2 with STATE_BUCKET and STATE_ENDPOINT, or remove that file to use local state." >&2
      return 1
    fi
    return 0
  fi
  : "${STATE_BUCKET:?set STATE_BUCKET}" "${STATE_ENDPOINT:?set STATE_ENDPOINT (https://<account>.r2.cloudflarestorage.com)}"
  # Each site has its own state key, so the workspace the last site selected
  # is not in this one and init refuses it. Start from default; tf() selects.
  rm -f "$1/.terraform/environment"
  cat > "$1/backend_override.tf" <<TF
terraform {
  backend "s3" {
    bucket                      = "$STATE_BUCKET"
    key                         = "deploy/$NAME/$(basename "$1").tfstate"
    region                      = "auto"
    endpoints                   = { s3 = "$STATE_ENDPOINT" }
    use_path_style              = true
    use_lockfile                = true
    skip_s3_checksum            = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
  }
}
TF
}

# site_state <root dir>: init that root as deploy.sh does and select the
# existing workspace NAME. It never makes a workspace: a site that this clone
# (or the R2 state) does not have is an error, with what to do.
site_state() {
  local dir=$1
  backend "$dir" || return 1
  (cd "$dir" && terraform init -input=false -reconfigure >/dev/null) || { echo "terraform init failed in $dir" >&2; return 1; }
  if ! (cd "$dir" && terraform workspace select "$NAME" >/dev/null 2>&1); then
    if [ "${DEPLOY_STATE:-local}" = r2 ]; then
      echo "no Terraform state for $NAME in the R2 state bucket ($STATE_BUCKET): check NAME" >&2
    else
      echo "no Terraform state for $NAME in this clone ($dir/terraform.tfstate.d). The state is local to the clone that ran deploy.sh: run import.sh there, or deploy with DEPLOY_STATE=r2 and set it here too." >&2
    fi
    return 1
  fi
}

# site_name_matches <root dir>: the state selected for NAME must say name=NAME
# (output "name"). A mismatch means the backend or workspace points at another
# site; destroy.sh refuses then.
site_name_matches() {
  local got
  got=$(cd "$1" && terraform workspace select "$NAME" >/dev/null 2>&1 && terraform output -raw name 2>/dev/null || true)
  [ "$got" = "$NAME" ] || { echo "the Terraform state selected for $NAME in $1 says name='$got': refusing" >&2; return 1; }
}

# site_vars <root dir> <out file>: the site's variables. deploy.sh's
# sites/<NAME>.tfvars in the clone that deployed it, or the same values from
# the state's outputs (deploy/terraform only: account_id, name, variant,
# location, and media from media_bucket). Prints the path to use.
site_vars() {
  local dir=$1 out=$2
  if [ -f "$dir/sites/$NAME.tfvars" ]; then echo "$dir/sites/$NAME.tfvars"; return 0; fi
  _site_out() { (cd "$dir" && terraform workspace select "$NAME" >/dev/null && terraform output -raw "$1"); }
  printf 'account_id = "%s"\nname = "%s"\nvariant = "%s"\nlocation = "%s"\nmedia = %s\n' \
    "$(_site_out account_id)" "$(_site_out name)" "$(_site_out variant)" "$(_site_out location)" "$( [ -n "$(_site_out media_bucket)" ] && echo true || echo false)" > "$out"
  echo "$out"
}
