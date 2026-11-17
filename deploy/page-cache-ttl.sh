# shellcheck shell=bash
# PAGE_CACHE_TTL (#759 pass 2, the lead's ruling): seconds a guest page stays fresh at the edge page cache
# (spikes/b2-wordpress/index.js pageCacheRoute and pageCacheHeaders; 0 turns the edge page cache OFF, unset is 120).
# Before this only deploy/variants/c1-config.sh rendered it (and refused 0), so on b-dosql a run's PAGE_CACHE_TTL=0
# deployed with the cache ON and said nothing. One rule for both b-dosql emitters: deploy/deploy.sh (check before any
# step, render-conf.sh the line) and deploy/wfp (render_user; a recorded setting). Rendered only when set: an integer
# from 0 to 86400 with no leading zero (0 itself is valid). Unset renders nothing, byte-identical.
# Test: deploy/tests/page-cache-ttl-test.sh.

# page_cache_ttl_check [variant]: exit 2 and the reason when refused; 0 when valid or unset. With a variant, a value on
# any variant other than b-dosql is refused (c1 has its own, deploy/variants/c1-config.sh).
page_cache_ttl_check() {
  local v=${PAGE_CACHE_TTL:-} variant=${1:-}
  # Empty is unset: deploy/wfp site update declares every setting local -x, which turns unset into empty.
  [ -n "${PAGE_CACHE_TTL:-}" ] || return 0
  [ "$variant" != c1 ] || return 0  # c1 keeps its own rule (deploy/variants/c1-config.sh); unchanged here
  if [ -n "$variant" ] && [ "$variant" != b-dosql ]; then
    echo "PAGE_CACHE_TTL is for variant b-dosql (c1 sets its own), not ${variant}" >&2; return 2
  fi
  if ! [[ "$v" =~ ^(0|[1-9][0-9]{0,4})$ ]] || [ "$v" -gt 86400 ]; then
    echo "PAGE_CACHE_TTL must be an integer from 0 to 86400 (0 turns the edge page cache off), not ${v}" >&2; return 2
  fi
}

# page_cache_ttl_line: the [vars] line, nothing when unset. Call page_cache_ttl_check first.
page_cache_ttl_line() {
  [ -z "${PAGE_CACHE_TTL:-}" ] || echo "PAGE_CACHE_TTL = \"${PAGE_CACHE_TTL}\""
}
