# shellcheck shell=bash
# The remote packs (#563, #569, #394, #598): the ONE rule, sourced by both b-dosql deploy paths: deploy/wfp/lib.sh
# (site add, site update, up.sh, build_dosql) and deploy/deploy.sh (VARIANT=b-dosql, through deploy/a-settings.sh and
# deploy/render-conf.sh). Sourced, not run. Variant a keeps its own off-unless-set rule (deploy/a-settings.sh, a_vars).
#
# OPCACHE_REMOTE=1: ALL OPcache files leave the bundle, as packs under /_pf/ that PHP fetches while it pauses in open()
# (opcache-remote.py, remote-packs.mjs). SITE_REMOTE=1: site.zip leaves the bundle too (site-remote.py). Both need the
# ASSETS binding with /_pf/ first (remote_assets_check.py refuses an upload without it).

# #563 (#394 Gate 1, OPCACHE_REMOTE=1). NO split: the 2026-11-13 ruling keeps OPCACHE_SPLIT off (#394
# issuecomment-6862048364), so the two flags together fail. The var is rendered so that the config hash changes with
# the flag: the build id does not, and an update would otherwise upload nothing.
opcache_remote_var() {
  case "${OPCACHE_REMOTE:-0}" in
    0) ;;
    1) [ "${OPCACHE_SPLIT:-0}" = 1 ] && { echo "OPCACHE_REMOTE=1 and OPCACHE_SPLIT=1 together: pick one (#563 has no split)" >&2; return 1; }
       echo 'OPCACHE_REMOTE = "on"' ;;
    *) echo "OPCACHE_REMOTE must be 0 or 1, not ${OPCACHE_REMOTE}" >&2; return 1 ;;
  esac
}
# #569 (#394 Gate 2, SITE_REMOTE=1): only on top of OPCACHE_REMOTE=1: the same hook, request budget, ASSETS binding
# and /_pf/ first. The var makes the config hash change with the flag.
site_remote_var() {
  case "${SITE_REMOTE:-0}" in
    0) ;;
    1) [ "${OPCACHE_REMOTE:-0}" = 1 ] || { echo "SITE_REMOTE=1 needs OPCACHE_REMOTE=1" >&2; return 1; }
       echo 'SITE_REMOTE = "on"' ;;
    *) echo "SITE_REMOTE must be 0 or 1, not ${SITE_REMOTE}" >&2; return 1 ;;
  esac
}
# #394 (the D/R round of 2026-11-14, issuecomment-6886246890): the remote packs are the DEFAULT for every b-dosql
# site. On the pf394a store, the 7-screen admin round lost 5 of 210 requests with OPCACHE_REMOTE=1 and SITE_REMOTE=1
# against 95 of 210 without them; #598's live run (issuecomment-6934185301) lost 14 of 40 post-new.php on a deploy.sh
# b-dosql store without them and 0 of 40 with them. An unset or empty OPCACHE_REMOTE becomes 1, except with
# OPCACHE_SPLIT=1 (the split cannot be remote, opcache_remote_var); an unset or empty SITE_REMOTE follows
# OPCACHE_REMOTE. 0 opts out (deploy/wfp records it, #558, and later updates keep it). Every caller runs this AFTER its
# settings are known and BEFORE the build and the render, so the build and the config read the same values
# (remote_assets_check refuses a disagreement).
remote_pack_defaults() {
  if [ -z "${OPCACHE_REMOTE:-}" ]; then
    if [ "${OPCACHE_SPLIT:-0}" = 1 ]; then OPCACHE_REMOTE=0; else OPCACHE_REMOTE=1; fi
  fi
  [ -n "${SITE_REMOTE:-}" ] || SITE_REMOTE=$OPCACHE_REMOTE
  export OPCACHE_REMOTE SITE_REMOTE
}
# remote_pack_build <woo active 0|1>: the pack step of a primed b-dosql build, run from the app directory
# (spikes/b2-wordpress) right after opcache.sh. #394 L1 (OPCACHE_SPLIT=1, deploy/wfp only): trace which OPcache files
# a WARM request reads, then keep only those as the module. #563 (OPCACHE_REMOTE=1): the same trace, then EVERY
# OPcache file to packs in cold-boot read order. #569 (SITE_REMOTE=1): after opcache-remote.py (it clears _pf/<id>/;
# site-remote.py adds st-*.zip and site-hot.zip). Each step's status is checked; no pipe. Nothing runs with both off.
remote_pack_build() {
  local woo=$1
  opcache_remote_var > /dev/null || return 1
  site_remote_var > /dev/null || return 1
  if [ "${OPCACHE_SPLIT:-0}" = 1 ] || [ "${OPCACHE_REMOTE:-0}" = 1 ]; then
    WOO_ACTIVE=$woo DEV_ENV=dosql-local ./file-trace.sh > build/file-trace.log 2>&1 || { echo "file-trace.sh failed:"; tail -15 build/file-trace.log; return 1; }
  fi
  if [ "${OPCACHE_SPLIT:-0}" = 1 ]; then
    python3 -I opcache-split.py build/opcache.zip build/file-trace.json build/build-id.js || return 1
  fi
  if [ "${OPCACHE_REMOTE:-0}" = 1 ]; then
    python3 -I opcache-remote.py build/opcache.zip build/file-trace.json build/build-id.js || return 1
  fi
  if [ "${SITE_REMOTE:-0}" = 1 ]; then
    python3 -I site-remote.py build/site.zip build/file-trace.json build/build-id.js || return 1
  fi
  return 0
}
