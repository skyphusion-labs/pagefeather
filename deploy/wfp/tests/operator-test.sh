#!/bin/bash
# Test of deploy/wfp/operator.sh (issue #148): the assembly flow over the
# proven primitives. Offline, no live account.
#   deploy/wfp/tests/operator-test.sh [another operator.sh]
#
# Part 1 (DRY_RUN): the ordered plan for several SITES specs is exactly right
#   (order, per-site phase, the shared dispatcher only when a :cd site, the
#   build toggle). The plan is the single source the executor consumes, so a
#   plan check is a check of what runs.
# Part 2 (refusals): a bad name, a bad suffix, an empty list and a :cd site
#   with no WFP_SUBDOMAIN each exit 2 and plan nothing.
# Part 3 (executor): operator.sh up for a phase-A pair and for a mixed pair,
#   with stand-in terraform, npx and site on PATH, issues the real calls in
#   plan order (shared setup, the shared dispatcher only for the mixed pair,
#   then site add per site with the right WFP_CUSTOM_DOMAIN).
# Exits 0 only when every case holds. Needs bash, python3.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
OP=${1:-$HERE/../operator.sh}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fails=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; fails=$((fails + 1)); }

# ---- Part 1: DRY_RUN plans ----
plan_is() { # plan_is <label> <want-plan> ; reads SITES/BUILD/WFP_SUBDOMAIN from env
  local label=$1 want=$2 got
  got=$(DRY_RUN=1 CLOUDFLARE_API_TOKEN=dummy "$OP" "${CMD:-up}" 2>&1)
  if [ "$got" = "$want" ]; then pass "$label"; else fail "$label"; printf '  want:\n%s\n  got:\n%s\n' "$want" "$got" | sed 's/^/   /'; fi
}

SITES="shop blog" plan_is "up: two phase-A sites" "build-dosql
shared-setup
site-add shop a
site-add blog a"

SITES="shop blog:cd" WFP_SUBDOMAIN=ex.operator.net plan_is "up: mixed, shared dispatcher present" "build-dosql
shared-setup
shared-dispatcher
site-add shop a
site-add blog cd"

SITES="shop" BUILD=0 plan_is "up: BUILD=0 drops build-dosql" "shared-setup
site-add shop a"

CMD=down SITES="shop blog:cd" WFP_SUBDOMAIN=ex.operator.net plan_is "down: mixed, reverse-style with shared teardown" "site-remove shop a
site-remove blog cd
shared-dispatcher-down
shared-teardown"

# ---- Part 2: refusals (exit 2, nothing planned) ----
refuses() { # refuses <label> <want-substr> ; SITES/WFP_SUBDOMAIN from env
  local label=$1 want=$2 out rc
  out=$(DRY_RUN=1 CLOUDFLARE_API_TOKEN=dummy "$OP" up 2>&1); rc=$?
  if [ "$rc" = 2 ] && printf '%s' "$out" | grep -q -- "$want"; then pass "$label (exit 2)"; else fail "$label: exit $rc, want \"$want\""; printf '%s\n' "$out" | sed 's/^/   /'; fi
}
SITES="Bad_Name"   refuses "refuse bad name"        "bad site name"
SITES="foo:xx"     refuses "refuse bad suffix"      "only valid suffix is ':cd'"
SITES=""           refuses "refuse empty SITES"     "set SITES"
SITES="shop blog:cd" refuses "refuse :cd without WFP_SUBDOMAIN" "needs WFP_SUBDOMAIN"

# ---- Part 3: the executor issues the real calls in plan order ----
mkdir -p "$T/bin"
cat > "$T/bin/terraform" <<'SH'
#!/bin/sh
LOG="$CALLS"
case "$1 $2 $3" in
  "init -input=false"*) echo "tf init" >> "$LOG" ;;
  "shared output"*) : ;;
esac
case "$*" in
  init*) exit 0 ;;
  *apply*) echo "tf apply" >> "$CALLS"; exit 0 ;;
  "output -raw kv_namespace_id") echo "tf output" >> "$CALLS"; printf kv1 ;;
  "output -raw namespace") printf wp-wfp ;;
  *) exit 0 ;;
esac
SH
cat > "$T/bin/npx" <<'SH'
#!/bin/sh
# npx wrangler deploy --config X.toml  ->  log the config
cfg=""; for a in "$@"; do [ "$prev" = "--config" ] && cfg=$a; prev=$a; done
echo "npx deploy $cfg" >> "$CALLS"
echo "Uploaded; https://example.workers.dev"
exit 0
SH
cat > "$T/bin/site" <<'SH'
#!/bin/sh
# the stand-in per-site command: record the action and the phase flag
echo "site $1 $2 cd=${WFP_CUSTOM_DOMAIN:-unset}" >> "$CALLS"
exit 0
SH
chmod +x "$T/bin/terraform" "$T/bin/npx" "$T/bin/site"
# fake-account: subdomain (the address print after run_actions)
cat > "$T/state.json" <<'JSON'
{"sites": {}, "ns_list_shape": "top"}
JSON
python3 -I "$HERE/fake-account.py" "$T/port" "$T/state.json" & pid=$!
trap 'kill $pid 2>/dev/null; wait $pid 2>/dev/null; rm -rf "$T"' EXIT
for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done

exec_is() { # exec_is <label> <want-calls> ; SITES/WFP_SUBDOMAIN from env
  local label=$1 want=$2 got
  : > "$T/calls"
  CALLS="$T/calls" PATH="$T/bin:$PATH" WFP_API="http://127.0.0.1:$(cat "$T/port")" \
    SITE_CMD="$T/bin/site" BUILD=0 CLOUDFLARE_API_TOKEN=test NAMESPACE=wp-wfp \
    "$OP" up >/dev/null 2>&1
  got=$(cat "$T/calls")
  if [ "$got" = "$want" ]; then pass "$label"; else fail "$label"; printf '  want:\n%s\n  got:\n%s\n' "$want" "$got" | sed 's/^/   /'; fi
}

SITES="shop blog" exec_is "executor: phase-A pair, no shared dispatcher, cd=0" "tf init
tf apply
tf output
npx deploy outbound.toml
site add shop cd=0
site add blog cd=0"

SITES="shop blog:cd" WFP_SUBDOMAIN=ex.operator.net exec_is "executor: mixed, shared dispatcher, blog cd=1" "tf init
tf apply
tf output
npx deploy outbound.toml
npx deploy wp-dispatch.toml
site add shop cd=0
site add blog cd=1"

echo "$fails failing case(s)"
exit "$fails"
