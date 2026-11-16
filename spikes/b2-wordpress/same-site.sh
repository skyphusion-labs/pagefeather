# shellcheck shell=bash
# same_site_location <base> <location>: exit 0 when a redirect's Location stays on the site <base>
# (scheme://host[:port], no trailing slash), 1 when it leaves. e2e.sh checks every hop with it (#760).
#   same site:  "" (no Location), <base>, <base>/..., a path "/..." (relative to the site),
#               and a protocol-relative "//<host[:port]>" or "//<host[:port]>/..." naming the site's own host.
#   off site:   any other absolute URL, and a protocol-relative "//other/..." (it names another host;
#               before #760's review the "/..." arm let it through).
# Test: tests/same-site-test.sh.
same_site_location() {
  local base=$1 loc=$2 hostport
  hostport=${base#*://}
  case "$loc" in
    "") return 0 ;;
    "$base"|"$base"/*) return 0 ;;
    "//$hostport"|"//$hostport"/*) return 0 ;;
    //*) return 1 ;;
    /*) return 0 ;;
    *) return 1 ;;
  esac
}
