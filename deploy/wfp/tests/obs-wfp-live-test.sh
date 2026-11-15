#!/bin/bash
# #693: OBSERVABILITY=full on a live Workers for Platforms site (ggc, ggc-test) is
# refused before any upload or build, even with THROWAWAY=1. The marker is
# deploy/wfp/live-sites/<name>, not deploy/live-sites/<name>.env: that directory
# is the b-dosql CODE_ONLY contract (its README, deploy-workers.yml).
# Against a stand-in API (fake-account.py) and a stand-in terraform. No Cloudflare account.
#   deploy/wfp/tests/obs-wfp-live-test.sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
LIB="$HERE/../lib.sh"
SITE="$HERE/../site"
SITESH="$HERE/../site.sh"
UPSH="$HERE/../up.sh"
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails + 1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/obs-wfp-live-test.XXXXXX")
SRV=
trap '[ -n "$SRV" ] && kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; rm -rf "$T"' EXIT

echo "1. ggc and ggc-test have a WfP live marker, and are not b-dosql live-sites files"
marker=0
if [ -f "$ROOT/deploy/wfp/live-sites/ggc" ] && [ -f "$ROOT/deploy/wfp/live-sites/ggc-test" ] \
  && [ ! -e "$ROOT/deploy/live-sites/ggc.env" ] && [ ! -e "$ROOT/deploy/live-sites/ggc-test.env" ] \
  && ! grep -E '^(VARIANT|LOCATION|MEDIA|MEDIA_BUCKET|SITE_ORIGIN|HTTP_ALLOW_HOSTS|WOO_ACTIVE)=' \
    "$ROOT/deploy/wfp/live-sites/ggc" "$ROOT/deploy/wfp/live-sites/ggc-test" >/dev/null 2>&1; then
  marker=1
fi
ok "deploy/wfp/live-sites lists ggc and ggc-test, and deploy/live-sites does not" "$marker"

echo "2. full on ggc or ggc-test is refused before any upload or build"
echo '{"sites": {}}' > "$T/state.json"
python3 -I "$HERE/fake-account.py" "$T/port" "$T/state.json" & SRV=$!
for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
mkdir -p "$T/bin"
cat > "$T/bin/terraform" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$T/tf.log"
case "\$*" in
  init*) exit 0 ;;
  "output -raw kv_namespace_id") printf kv1 ;;
  "workspace list") printf '* default\n  one\n' ;;
  *) echo "stand-in terraform: \$* is not expected" >&2; exit 9 ;;
esac
EOF
chmod +x "$T/bin/terraform"
PORT=$(cat "$T/port")
# A clean environment: the stand-in API and terraform, never the caller's token or account.
run() { # run <command> [args...]; prints rc, writes, tf-lines, then the output
  rm -f "$T/state.json.writes" "$T/tf.log"
  local out rc writes tf
  out=$(env -i PATH="$T/bin:$PATH" HOME="${HOME:-/tmp}" TMPDIR="${TMPDIR:-/tmp}" \
    WFP_API="http://127.0.0.1:$PORT" WFP_STATE=local CLOUDFLARE_API_TOKEN=test \
    ACCOUNT_ID=test-account NAMESPACE=wp-wfp \
    "$@" 2>&1); rc=$?
  writes=0
  [ -f "$T/state.json.writes" ] && writes=$(wc -l < "$T/state.json.writes" | tr -d ' ')
  tf=0
  [ -f "$T/tf.log" ] && tf=$(wc -l < "$T/tf.log" | tr -d ' ')
  printf '%s\n%s\n%s\n' "$rc" "$writes" "$tf"
  printf '%s\n' "$out"
}
# First three lines are rc, api writes, terraform invocations. The rest is the command output.
live_refused() { # live_refused <label> <where-substring> <command> [args...]
  local label=$1 where=$2
  shift 2
  local meta rc writes tf out
  meta=$(run "$@")
  out=$(printf '%s\n' "$meta" | tail -n +4)
  rc=$(printf '%s\n' "$meta" | sed -n '1p')
  writes=$(printf '%s\n' "$meta" | sed -n '2p')
  tf=$(printf '%s\n' "$meta" | sed -n '3p')
  ok "$label: refused before any upload (rc $rc, api writes $writes, terraform calls $tf)" \
    "$([ "$rc" = 2 ] && [ "$writes" = 0 ] && [ "$tf" = 0 ] && printf '%s\n' "$out" | grep -q 'is a live site' && printf '%s\n' "$out" | grep -Fq "$where" && ! printf '%s\n' "$out" | grep -q 'not built' && echo 1 || echo 0)"
  printf '%s\n' "$out" | sed 's/^/      /'
}
for name in ggc ggc-test; do
  live_refused "site update $name OBSERVABILITY=full THROWAWAY=1" "deploy/wfp/live-sites/$name" \
    env OBSERVABILITY=full THROWAWAY=1 "$SITE" update "$name"
done
# BUILD stays unset (site add's default is 0). A missing refusal must stop at the
# "not built" gate, never at build_dosql, so this test cannot start a real build.
live_refused "site add ggc OBSERVABILITY=full THROWAWAY=1" "deploy/wfp/live-sites/ggc" \
  env OBSERVABILITY=full THROWAWAY=1 "$SITE" add ggc
live_refused "site.sh up ggc OBSERVABILITY=full THROWAWAY=1" "deploy/wfp/live-sites/ggc" \
  env OBSERVABILITY=full THROWAWAY=1 "$SITESH" up ggc
live_refused "up.sh SITES=ggc OBSERVABILITY=full THROWAWAY=1 BUILD=0" "deploy/wfp/live-sites/ggc" \
  env OBSERVABILITY=full THROWAWAY=1 BUILD=0 SITES=ggc "$UPSH"
live_refused "up.sh SITES='one ggc' refuses before the build of either" "deploy/wfp/live-sites/ggc" \
  env OBSERVABILITY=full THROWAWAY=1 BUILD=0 SITES="one ggc" "$UPSH"
# The same function also sees a b-dosql live-sites file (obs_live_site's other clause, #639).
live_refused "site update woocap OBSERVABILITY=full THROWAWAY=1" "deploy/live-sites/woocap.env" \
  env OBSERVABILITY=full THROWAWAY=1 "$SITE" update woocap

echo "3. 1, 0 and unset are not the live-site refusal, and an unmarked name is not either"
as_today() { # as_today <label> <absent-name> <command> [args...]
  local label=$1 absent=$2
  shift 2
  local meta rc out
  meta=$(run "$@")
  out=$(printf '%s\n' "$meta" | tail -n +4)
  rc=$(printf '%s\n' "$meta" | sed -n '1p')
  ok "$label: not a live-site refusal (rc $rc)" \
    "$([ "$rc" = 2 ] && ! printf '%s\n' "$out" | grep -q 'is a live site' && printf '%s\n' "$out" | grep -q "no site $absent" && echo 1 || echo 0)"
}
as_today "site update ggc OBSERVABILITY=1" ggc env OBSERVABILITY=1 "$SITE" update ggc
as_today "site update ggc OBSERVABILITY unset" ggc env -u OBSERVABILITY "$SITE" update ggc
as_today "site update ggc OBSERVABILITY=0" ggc env OBSERVABILITY=0 "$SITE" update ggc
as_today "site update pf693 OBSERVABILITY=full THROWAWAY=1" pf693 \
  env OBSERVABILITY=full THROWAWAY=1 "$SITE" update pf693

echo "4. render_user refuses full for a marked site and still renders 1, unset, and a throwaway"
render_rc() { # render_rc <site> [NAME=value ...]; toml in $T/render.toml, stderr in $T/render.err
  local site=$1
  shift
  env "$@" bash -c ". '$LIB'; render_user \"\$1\" \"\$2\"" _ "$site" "https://$site.example" > "$T/render.toml" 2>"$T/render.err"
}
render_rc ggc THROWAWAY=1 OBSERVABILITY=full; rc=$?
ok "render_user ggc OBSERVABILITY=full THROWAWAY=1 is refused as a live site (rc $rc)" \
  "$([ "$rc" != 0 ] && grep -q 'is a live site' "$T/render.err" && grep -q 'deploy/wfp/live-sites/ggc' "$T/render.err" && ! grep -q 'invocation_logs = true' "$T/render.toml" && echo 1 || echo 0)"
render_rc ggc-test THROWAWAY=1 OBSERVABILITY=full; rc=$?
ok "render_user ggc-test OBSERVABILITY=full THROWAWAY=1 is refused as a live site (rc $rc)" \
  "$([ "$rc" != 0 ] && grep -q 'deploy/wfp/live-sites/ggc-test' "$T/render.err" && ! grep -q 'invocation_logs = true' "$T/render.toml" && echo 1 || echo 0)"
render_rc ggc OBSERVABILITY=1; rc=$?
ok "render_user ggc OBSERVABILITY=1 still renders events only (rc $rc)" \
  "$([ "$rc" = 0 ] && grep -q 'invocation_logs = false' "$T/render.toml" && echo 1 || echo 0)"
render_rc ggc; rc=$?
ok "render_user ggc OBSERVABILITY unset still renders an explicit off (rc $rc)" \
  "$([ "$rc" = 0 ] && grep -q 'enabled = false' "$T/render.toml" && echo 1 || echo 0)"
render_rc one THROWAWAY=1 OBSERVABILITY=full; rc=$?
ok "render_user one (not a live site) OBSERVABILITY=full THROWAWAY=1 still has invocation logs (rc $rc)" \
  "$([ "$rc" = 0 ] && grep -q 'invocation_logs = true' "$T/render.toml" && echo 1 || echo 0)"

echo "5. the refusal is ordered before the build and the upload"
order() { # order <label> <file> <awk program printing 1 when the early line is before the late one>
  local got
  got=$(awk "$3" "$2")
  ok "$1" "$got"
}
order "site refuses full before shared terraform init" "$SITE" \
  '/obs_refuse_full/ && !e {e=NR} /tfr shared init/ && !t {t=NR} END {print (e && t && e < t) ? 1 : 0}'
order "site update_one refuses full before its build_dosql" "$SITE" \
  '/update_one_inner\(\)/ {u=NR} /obs_refuse_full/ && u && !r {r=NR} /build_dosql/ && u && !b {b=NR} END {print (u && r && b && u < r && r < b) ? 1 : 0}'
order "site.sh up refuses full before the user Worker upload" "$SITESH" \
  '/obs_refuse_full/ && !e {e=NR} /deploy --config/ && !d {d=NR} END {print (e && d && e < d) ? 1 : 0}'
order "up.sh refuses full before build_dosql" "$UPSH" \
  '/obs_refuse_full/ && !e {e=NR} /build_dosql/ && !b {b=NR} END {print (e && b && e < b) ? 1 : 0}'

echo "$fails failing case(s)"
exit "$fails"
