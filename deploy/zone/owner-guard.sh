# shellcheck shell=bash
# Sourced by apply.sh and destroy.sh (issue #282). Both PUT the zone's
# http_request_cache_settings phase entrypoint, and that PUT REPLACES every rule
# in the phase. If another root owns the phase (a site's own Terraform, for
# example), a run here silently overwrites that owner's rules. Seen on ggc.sh on
# 2026-11-09: this package's rules replaced the ggc repo's cache_bypass ruleset,
# and the store's "storefront HTML is never cached" rule was gone.
#
# guard_cache_phase reads the entrypoint first. It allows the PUT only when the
# phase has no rules, or every rule in it is one this package writes (matched
# by the rule descriptions of cache-ruleset.json and
# cache-ruleset.multitenant.json). Otherwise it stops with exit 3 and names the
# rules it found. FORCE=1 overrides that, for an operator who has decided that
# this package is now the owner.
#
# Needs cf() from the caller (it prints the body, then a line with the HTTP code)
# and SCRIPT_DIR, ZONE_ID.

guard_cache_phase() {
  local out code body verdict
  out=$(cf GET "/zones/$ZONE_ID/rulesets/phases/http_request_cache_settings/entrypoint") \
    || { echo "  owner check: curl failed" >&2; exit 1; }
  code=$(printf '%s' "$out" | tail -1)
  body=$(printf '%s' "$out" | sed '$d')
  case "$code" in
    404) echo "  owner check: the cache phase has no entrypoint yet (nothing to overwrite)"; return 0 ;;
    2*) ;;
    *) echo "  owner check: HTTP $code reading the cache phase; refusing (an unknown owner is never read as none)" >&2
       echo "$body" | head -5 >&2; exit 1 ;;
  esac
  verdict=$(printf '%s' "$body" | GUARD_DIR="$SCRIPT_DIR" python3 -I -c '
import json, sys, os
d = os.environ["GUARD_DIR"]
ours = set()
for f in ("cache-ruleset.json", "cache-ruleset.multitenant.json"):
    for r in json.load(open(os.path.join(d, f))).get("rules", []):
        ours.add(r.get("description", ""))
try:
    rules = (json.load(sys.stdin).get("result") or {}).get("rules") or []
except ValueError:
    print("unreadable"); sys.exit(0)
foreign = [r.get("description") or r.get("ref") or r.get("id") or "?" for r in rules if r.get("description", "") not in ours]
if not rules:
    print("empty")
elif not foreign:
    print("ours %d" % len(rules))
else:
    print("foreign " + json.dumps(foreign))
')
  case "$verdict" in
    empty) echo "  owner check: the cache phase is empty" ;;
    ours*) echo "  owner check: the cache phase holds only this package's rules (${verdict#ours })" ;;
    unreadable) echo "  owner check: the cache phase answer is not JSON; refusing" >&2; exit 1 ;;
    foreign*)
      if [ "${FORCE:-0}" = 1 ]; then
        echo "  owner check: FORCE=1, overwriting rules this package did not write: ${verdict#foreign }" >&2
      else
        echo "  owner check: the cache phase of zone $ZONE_ID holds rules this package did not write:" >&2
        echo "    ${verdict#foreign }" >&2
        echo "  Another root (a site's own Terraform, for example) owns this phase. The PUT here would replace" >&2
        echo "  its rules. Nothing was changed. Set FORCE=1 only once this package is meant to be the owner." >&2
        exit 3
      fi ;;
    *) echo "  owner check: unexpected verdict '$verdict'; refusing" >&2; exit 1 ;;
  esac
}
