# shellcheck shell=bash
# Shared by deploy/wfp/up.sh, down.sh and the tests (issue #35). Sourced, not run.
#
# Names (docs/wfp.md and the #35 slice 1 design):
#   the dispatch namespace          wp-wfp
#   the site map (KV)               wp-wfp-sites: hostname -> {"script", "cpuMs", "subRequests", "outbound"}
#   the outbound Worker             wp-wfp-outbound
#   a site's user Worker            site-<name>, in the namespace (b-dosql)
#   a site's dispatcher (phase A)   wp-<name>, a normal Worker on workers.dev; ONE script and
#                                   ONE config template for every site, only the name differs
#   a site's media bucket           wp-wfp-<name>-media
#   the stale-entry probe           wp-probe, a dispatcher copy whose entry names a script
#                                   that does not exist (it must answer 404)
WFP=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$WFP/../.." && pwd)
# The pinned Wrangler. A test points WR at a stub.
WR=${WR:-$ROOT/deploy/wr}
APP="$ROOT/spikes/b2-wordpress"
GEN="$WFP/gen"
NAMESPACE=${NAMESPACE:-wp-wfp}
# The account has NO default: a deploy that forgot it would otherwise send its
# API calls and its Terraform plan to someone else's account id. Each entry point
# calls need_account. The reference deploy sources deploy/wfp/reference.env.
ACCOUNT_ID=${ACCOUNT_ID:-}
export CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID
need_account() {
  [ -n "$ACCOUNT_ID" ] || { echo "set ACCOUNT_ID to the Cloudflare account id to deploy into (the reference deploy sources deploy/wfp/reference.env)" >&2; exit 2; }
  export TF_VAR_account_id=$ACCOUNT_ID
  if [ -n "${WFP_ZONE_ID:-}" ]; then export TF_VAR_zone_id=$WFP_ZONE_ID; fi
}
API=${WFP_API:-https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID}

# A site name: lower case, digits and hyphens, 1 to 30 characters, no hyphen at
# either end (wp-wfp-<name>-media must stay a valid bucket name).
#
# A site's dispatcher is wp-<name>, so a name must not make the name of a SHARED
# Worker: wp-probe, wp-dispatch (the phase B dispatcher), wp-cacheprobe,
# wp-cacheprobe-direct, and wp-wfp-outbound (any wfp- name, which also keeps
# wp-wfp-<x> free for the project's own scripts and buckets). Without this,
# `site remove dispatch` would see a dispatcher and delete the shared one.
# tests/render-test.sh checks every shared Worker name in this tree is refused.
SHARED_WORKER_SITE_NAMES="probe dispatch cacheprobe cacheprobe-direct"
valid_site() {
  [[ "$1" =~ ^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?$ ]] || return 1
  case "$1" in wfp-*) return 1 ;; esac
  local n
  for n in $SHARED_WORKER_SITE_NAMES; do [ "$1" != "$n" ] || return 1; done
}
user_script() { echo "site-$1"; }
dispatcher_name() { echo "wp-$1"; }
media_bucket() { echo "wp-wfp-$1-media"; }

# Phase B (#138, CR gated): the one shared dispatcher, and a site's hostname
# when it has a Custom Domain. WFP_SUBDOMAIN is the test subdomain CR #138
# routes; WFP_CUSTOM_DOMAIN=1 selects phase B. The default is phase A
# (workers.dev), so these change nothing until the flag is set.
SHARED_DISPATCHER=${SHARED_DISPATCHER:-wp-dispatch}
WFP_SUBDOMAIN=${WFP_SUBDOMAIN:-wfp-test.skyphusion.org}
custom_host() { echo "$1.$WFP_SUBDOMAIN"; }

# A site's routed hostname and its site map key, decided in ONE place so the
# key and the route can never drift. Phase A: the per-site workers.dev
# dispatcher wp-<name>. Phase B: the site's Custom Domain <name>.<subdomain>.
site_host() { # site_host <site> <workers.dev subdomain>
  if [ "${WFP_CUSTOM_DOMAIN:-0}" = 1 ]; then custom_host "$1"; else echo "$(dispatcher_name "$1").$2.workers.dev"; fi
}

# The shared dispatcher config (phase B): the same ONE template as phase A,
# rendered with the fixed name wp-dispatch (it routes by request hostname, so
# nothing per-site). render_shared_dispatcher <kv namespace id>.
render_shared_dispatcher() { sed -e "s/@SITE@/dispatch/g" -e "s/@NAMESPACE@/$NAMESPACE/g" -e "s/@KV_ID@/$1/g" -e "s/@COMPAT@/$(compat_date)/g" "$WFP/dispatcher/wrangler.template.toml"; }

# The "build" field of a site's map entry (issue #35 slice 5): the rollback
# target for "site update". Uses kv_build.py, not an inline literal in a pipe.
# The number of rows in the object's SQLite (issue #35 slice 5), via
# /_dbexport: used to show data survived an update or a rollback.
row_count() { # row_count <origin> <token>
  curl -s -m 120 -K <(printf 'header = "x-spike-token: %s"\n' "$2") "$1/_dbexport" 2>/dev/null | grep -c . || true
}
entry_build() { # entry_build <site>
  api GET "/storage/kv/namespaces/$KV_ID/values/$(site_key "$1")" | python3 "$WFP/kv_build.py"
}
# The site map key (= hostname) of <site>: the recorded one when site_vars has
# read this site's workspace (REC_SITE), else the computed one.
site_key() { # site_key <site>
  if [ "${REC_SITE:-}" = "$1" ] && [ -n "${REC_HOST:-}" ]; then echo "$REC_HOST"; else site_host "$1" "$SUB"; fi
}
compat_date() { sed -n 's/^compatibility_date = "\(.*\)"/\1/p' "$APP/wrangler.toml" | head -1; }

# The dispatcher config for one site, from the ONE template: only @SITE@
# differs between sites (the test in tests/render-test.sh checks it).
render_dispatcher() { # render_dispatcher <site> <kv namespace id>
  sed -e "s/@SITE@/$1/g" -e "s/@NAMESPACE@/$NAMESPACE/g" -e "s/@KV_ID@/$2/g" -e "s/@COMPAT@/$(compat_date)/g" "$WFP/dispatcher/wrangler.template.toml"
}
# The Workers Cache probe (CACHE_PROBE=1): render_cacheprobe <name> <true|false>.
# workers_dev false is the namespace copy, which has no workers.dev name.
render_cacheprobe() {
  local wd=$2
  sed -e "s/@NAME@/$1/g" -e "s/@WORKERS_DEV@/$wd/g" -e "s/@COMPAT@/$(compat_date)/g" "$WFP/cache-probe/wrangler.template.toml" \
    | { if [ "$wd" = false ]; then grep -v '^workers_dev'; else cat; fi; }
}
# The site map entry for an attacker probe: script, limits, and the outbound
# flag. CROSS_OUTBOUND=0 writes it false (an option to run the probes without
# the outbound Worker); unset or any other value writes true, unchanged.
probe_entry() { # probe_entry <script> <cpuMs> <subRequests>
  printf '{"script": "%s", "cpuMs": %s, "subRequests": %s, "outbound": %s}' \
    "$1" "$2" "$3" "$([ "${CROSS_OUTBOUND:-1}" = 0 ] && echo false || echo true)"
}

# The attacker probe (slice 4): render_cross <name> <bucket>.
render_cross() {
  sed -e "s/@NAME@/$1/g" -e "s/@BUCKET@/$2/g" -e "s/@COMPAT@/$(compat_date)/g" "$WFP/cross-probe/wrangler.template.toml"
}

wrangler_deploy() { # wrangler_deploy <dir> <logfile> <wrangler deploy args...>
  local dir=$1 log=$2; shift 2
  local i rc=0
  for i in $(seq 1 "${WRANGLER_RETRIES:-3}"); do
    if (cd "$dir" && "$WR" deploy "$@") > "$log" 2>&1; then return 0; else rc=$?; fi
    [ "$i" -lt "${WRANGLER_RETRIES:-3}" ] || break
    echo "  wrangler deploy ($*) failed (attempt $i of ${WRANGLER_RETRIES:-3}); retrying in ${WRANGLER_RETRY_S:-5}s (a re-deploy is idempotent)" >&2
    sleep "${WRANGLER_RETRY_S:-5}"
  done
  return "$rc"
}
render_outbound() {
  sed -e "s/@COMPAT@/$(compat_date)/g" "$WFP/outbound/wrangler.template.toml"
}

# The user Worker config: deploy/deploy.sh's b-dosql config, as a namespace
# script (no workers.dev name), with its own origin and media bucket.
render_user() { # render_user <site> <origin>
  local s=$1 origin=$2 mail_binding mail_vars http_allow
  mail_binding=$(SITE_ORIGIN="$origin" MAIL_FROM="${MAIL_FROM:-}" node "$APP/mail-from.mjs" --binding) || return 1
  mail_vars=$(SITE_ORIGIN="$origin" MAIL_FROM="${MAIL_FROM:-}" MAIL_FROM_NAME="${MAIL_FROM_NAME:-}" node "$APP/mail-from.mjs" --vars) || return 1
  http_allow=$(node "$APP/http-allow.mjs") || return 1
  cat <<TOML
# Generated by deploy/wfp for site $s (b-dosql in namespace $NAMESPACE). Do not edit.
name = "$(user_script "$s")"
main = "index.js"
compatibility_date = "$(compat_date)"
compatibility_flags = ["nodejs_compat"]
rules = [{ type = "Data", globs = ["**/*.zip"], fallthrough = false }]
$mail_binding
[assets]
directory = "build/public"
[cache]
enabled = true
[exports.default]
type = "worker"
[exports.default.cache]
enabled = false
[exports.Pages]
type = "worker"
[exports.Pages.cache]
enabled = true
[vars]
PHP_ENV = '{"USE_ZEND_ALLOC":"0"}'
SITE_ORIGIN = "$origin"
$mail_vars
HTTP_ALLOW_HOSTS = "$http_allow"
PHP_IN_DO = "on"
PHP_LOCATION = "${PHP_LOCATION:-enam}"
PHP_DO_POOL = "1"
DB_IN_DO = "on"
[images]
binding = "IMAGES"
[[r2_buckets]]
binding = "MEDIA"
bucket_name = "$(media_bucket "$s")"
[[durable_objects.bindings]]
name = "PHP_RUNTIME"
class_name = "PhpRuntime"
[[migrations]]
tag = "v1"
new_sqlite_classes = ["PhpRuntime"]
TOML
  # OBSERVABILITY=1 (default off): Workers Logs for this one site, to read a run the platform
  # terminates (#291: an alarm ended scriptThrewException with no catch firing). wrangler tail
  # cannot follow a namespace script. Turn it on for a throwaway or a diagnosis, not by default.
  if [ "${OBSERVABILITY:-0}" = 1 ]; then printf '\n[observability]\nenabled = true\nhead_sampling_rate = 1\n'; fi
}

# WOO_ACTIVE for the OPcache priming (#313), from the build inputs only: an explicit WOO_ACTIVE
# (0 or 1) wins; else 1 when woocommerce is in the site plugin set (IMPORT_PLUGINS or PLUGINS),
# else 0. Never from the local dev state.
woo_active_for_build() {
  case "${WOO_ACTIVE:-}" in 0|1) echo "$WOO_ACTIVE"; return 0 ;; "") ;; *) echo "WOO_ACTIVE must be 0 or 1, not $WOO_ACTIVE" >&2; return 2 ;; esac
  case " ${IMPORT_PLUGINS:-} ${PLUGINS:-} " in *" woocommerce "*) echo 1 ;; *) echo 0 ;; esac
}
# Build b-dosql (spikes/b2-wordpress), as deploy/deploy.sh does: PHP
# WebAssembly, WordPress, the precompiled OPcache (local wrangler dev).
build_dosql() {
  log "build b-dosql (spikes/b2-wordpress)"
  local woo; woo=$(woo_active_for_build) || return 2
  echo "OPcache priming: WOO_ACTIVE=$woo (explicit, or woocommerce in IMPORT_PLUGINS/PLUGINS)"
  ( cd "$APP"
    [ -d node_modules ] || npm ci --silent
    [ -f vendor/php_8_3.js ] || ./prepare.sh
    ./build.sh | tail -1
    WOO_ACTIVE=$woo DEV_ENV=dosql-local ./opcache.sh > build/opcache.log 2>&1 || { echo "opcache.sh failed:"; tail -25 build/opcache.log; exit 1; }
    tail -1 build/opcache.log ) || return 1
  # The subshell status is checked (#313): under "site update --all" (if "$fn") set -e is off, and
  # a failed opcache.sh used to fall through to the size check with the EMPTY opcache.zip that
  # build.sh starts, and that bundle was uploaded.
  bundle_size_check
}
# The Worker size limit is 64 MiB uncompressed (docs/plan-limits.md; measured:
# 72 MB refused). Four files make almost all of a b-dosql upload: build/site.zip
# (WordPress and the site's plugins), build/opcache.zip, and the PHP wasm with
# its loader. A store with WooCommerce and Rank Math measured 61.46 MiB of
# them (2026-11-11, skyphusion-labs/ggc#101): about 2.5 MiB from the limit, so
# one plugin bump could stop its next upload. Stop BEFORE an upload above
# BUNDLE_MAX_MIB (default 62), and say which file is how big. A missing file is
# an error, never a small bundle.
bundle_size_check() { # bundle_size_check [app dir]
  python3 - "${1:-$APP}" "${BUNDLE_MAX_MIB:-62}" <<'PY'
import os, sys
app, cap = sys.argv[1], float(sys.argv[2])
parts = ["build/site.zip", "build/opcache.zip", "vendor/php_8_3.wasm", "vendor/php_8_3.js"]
missing = [p for p in parts if not os.path.isfile(os.path.join(app, p))]
if missing:
    sys.exit("bundle size: missing " + ", ".join(missing) + " (build first)")
sizes = {p: os.path.getsize(os.path.join(app, p)) for p in parts}
mib = sum(sizes.values()) / 1048576
detail = ", ".join("%s %.2f MiB" % (os.path.basename(p), s / 1048576) for p, s in sizes.items())
if mib > cap:
    sys.exit("bundle size: %.2f MiB is over the %.0f MiB gate (Worker limit 64 MiB): %s" % (mib, cap, detail))
print("bundle size: %.2f MiB of the %.0f MiB gate (%s)" % (mib, cap, detail))
PY
}

# API calls: the token goes to curl in a config on a pipe, never in argv.
api() { # api <method> <path> [curl args...]: prints the body, then a line with the HTTP code
  local m=$1 p=$2; shift 2
  curl -s -m 60 -X "$m" -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") -w '\n%{http_code}' "$API$p" "$@"
}
api_code() { api "$@" | tail -1; }
# A script in the namespace: present, gone or unknown. The HTTP status of the
# single GET is NOT enough: after a DELETE it can answer 200 with success true
# and a record whose script id is null (a ghost, seen live 2026-11-06 on
# site-one), while the namespace list no longer has it and a second DELETE
# answers 10007 "This Worker does not exist". So: gone when the list does not
# have it AND the single GET is 404 or a ghost; present when either has it;
# unknown when the list cannot be read.
ns_script_state() { # ns_script_state <script>
  local t; t=$(mktemp -d)
  api GET "/workers/dispatch/namespaces/$NAMESPACE/scripts?per_page=1000" > "$t/list"
  api GET "/workers/dispatch/namespaces/$NAMESPACE/scripts/$1" > "$t/one"
  python3 - "$1" "$t/list" "$t/one" <<'PY'
import json, sys
name = sys.argv[1]
def read(p):
    lines = open(p).read().rsplit("\n", 1)
    body, code = (lines[0], lines[1].strip()) if len(lines) == 2 else ("", lines[0].strip())
    try:
        return code, json.loads(body)
    except ValueError:
        return code, None
lc, l = read(sys.argv[2]); oc, o = read(sys.argv[3])
if lc != "200" or not isinstance(l, dict) or not isinstance(l.get("result"), list):
    print("unknown"); sys.exit()
def ids(x):
    return {x.get("id"), (x.get("script") or {}).get("id")} if isinstance(x, dict) else set()
in_list = any(name in ids(x) for x in l["result"])
if oc == "404":
    one = "absent"
elif oc == "200" and isinstance(o, dict) and isinstance(o.get("result"), dict):
    one = "present" if name in ids(o["result"]) else "ghost"
else:
    one = "unknown"
if in_list or one == "present":
    print("present")
elif one in ("absent", "ghost"):
    print("gone")
else:
    print("unknown")
PY
  rm -rf "$t"
}
# A NEW KV namespace can refuse writes for a while: on 2026-11-06 the entry
# PUT right after the shared apply answered 404 10013 "namespace not found",
# while a GET of the namespace already answered (the second day one). So
# before a site writes its entry: a test write, retried on 404 or 5xx for
# KV_READY_S (180) s, then the test key deleted. Any other answer fails at once.
kv_wait_writable() { # kv_wait_writable <namespace id>
  local t0=$SECONDS c
  while :; do
    c=$(api_code PUT "/storage/kv/namespaces/$1/values/wfp-ready-probe" -H 'content-type: text/plain' --data 1) || c=000
    if [ "$c" = 200 ]; then
      c=$(api_code DELETE "/storage/kv/namespaces/$1/values/wfp-ready-probe") || c=000
      [ "$c" = 200 ] || { echo "site map: the test key was written but its DELETE answered HTTP $c" >&2; return 1; }
      echo "  site map writable after $((SECONDS - t0)) s"
      return 0
    fi
    case "$c" in
      404|5??|000) ;;
      *) echo "site map $1: a test write answered HTTP $c" >&2; return 1 ;;
    esac
    [ $((SECONDS - t0)) -lt "${KV_READY_S:-180}" ] || { echo "site map $1 still refuses writes after ${KV_READY_S:-180} s (HTTP $c)" >&2; return 1; }
    sleep "${KV_READY_STEP:-5}"
  done
}
# Wait for a new site to answer from its OWN user Worker, not from the
# platform or the dispatcher (the #92 trap: any answer is not "ready").
# Seen 2026-11-06 (the third day one): site two's first answer was a 404, and
# one second later the dispatcher answered "not deployed" (x-wfp-error
# not-deployed: the entry was read, but the namespace did not have the new
# script yet). The probe is GET /_dbping with no spike token: b-dosql answers
# it with its own 403 before and after the install.
#   ready:    2xx, 3xx, 401 or 403, with no x-wfp-error
#   retried:  no answer, 404, 5xx, x-wfp-error no-site or not-deployed
#   fails at once: x-wfp-error bad-entry or dispatch (a configuration fault)
# Bound SITE_WAIT (300) s, every SITE_WAIT_STEP (10) s; a timeout prints the last answer.
# The time wait_site waits for a new site to answer. Phase B's FIRST deploy
# must cover the Advanced Certificate issuance for a new Custom Domain, which
# can exceed 15 min (Cloudflare docs: a new hostname has no certificate until
# the pack is active, so TLS fails until then). Phase A has no certificate, so
# it stays short. SITE_WAIT overrides either.
site_wait_cap() { echo "${SITE_WAIT:-$([ "${WFP_CUSTOM_DOMAIN:-0}" = 1 ] && echo 1800 || echo 300)}"; }
wait_site() { # wait_site <origin>
  local t0=$SECONDS t code err body cap said_tls=0 said_dispatch=0
  cap=$(site_wait_cap)
  t=$(mktemp -d)
  while :; do
    code=$(curl -s -o "$t/b" -D "$t/h" -w '%{http_code}' -m 60 "$1/_dbping?nocache=$RANDOM$RANDOM" 2>/dev/null) || code=000
    err=$(tr -d '\r' < "$t/h" 2>/dev/null | awk -F': ' 'tolower($1) == "x-wfp-error" { print $2 }')
    body=$(head -c 80 "$t/b" 2>/dev/null | tr -s '\n\r\t' ' ')
    # bad-entry is a malformed site map entry: a fault at once. dispatch is any error from
    # the namespace script, and a brand-new site's FIRST cold boot can give one before it
    # answers (#294: fdprobe1111c answered 502 dispatch once, then served). So a dispatch
    # error is retried for WFP_DISPATCH_GRACE seconds (default 120) before it is a fault.
    case "$err" in
      bad-entry) echo "the dispatcher answered $code $err: a configuration fault, not a delay ($body)" >&2; rm -rf "$t"; return 1 ;;
      dispatch)
        if [ $((SECONDS - t0)) -ge "${WFP_DISPATCH_GRACE:-120}" ]; then
          echo "the dispatcher answered $code $err for ${WFP_DISPATCH_GRACE:-120} s: a fault in the site script, not a cold boot ($body)" >&2; rm -rf "$t"; return 1
        fi
        [ "${said_dispatch:-0}" = 1 ] || { echo "  the site script errored ($code $err); retrying for up to ${WFP_DISPATCH_GRACE:-120} s (a first cold boot)"; said_dispatch=1; } ;;
    esac
    if [ -z "$err" ] && [[ "$code" =~ ^(2..|3..|401|403)$ ]]; then
      echo "  the site answered HTTP $code after $((SECONDS - t0)) s"
      rm -rf "$t"; return 0
    fi
    # Phase B first deploy: a new Custom Domain's Advanced Certificate may still
    # be issuing, so TLS is not ready and curl reads 000 or a 52x edge code.
    # That is a delay, not a fault: say so once and keep waiting to the cap.
    if [ "${WFP_CUSTOM_DOMAIN:-0}" = 1 ] && [ "$said_tls" = 0 ] && [[ "$code" =~ ^(000|522|523|525|526)$ ]]; then
      echo "  waiting for TLS on $1 (the Advanced Certificate may still be issuing; up to ${cap}s)"
      said_tls=1
    fi
    if [ $((SECONDS - t0)) -ge "$cap" ]; then
      echo "the site did not answer in ${cap} s; last: HTTP $code${err:+, x-wfp-error $err}, body: $body" >&2
      [ "${WFP_CUSTOM_DOMAIN:-0}" = 1 ] && echo "  if the Advanced Certificate for $1 is still issuing, re-run up.sh once it is active: the data plane persists and the install completes on the re-run" >&2
      rm -rf "$t"; return 1
    fi
    sleep "${SITE_WAIT_STEP:-10}"
  done
}
# Which parts of a site exist, from the API only (no Terraform): one line
# each, "<part> <state>": dispatcher yes|no, script present|gone|unknown
# (ns_script_state), entry yes|no, bucket yes|no; any other HTTP answer is
# "unknown". Needs KV_ID and SUB. "site add" refuses unless every part is
# absent; "site remove" checks that every part is absent after.
site_footprint() { # site_footprint <name>
  local s=$1 c
  if [ "${WFP_CUSTOM_DOMAIN:-0}" = 1 ] || { [ "${REC_SITE:-}" = "$s" ] && [ "${REC_CD:-}" = true ]; }; then
    # Phase B: the per-site routing is the Custom Domain, not a per-site Worker.
    if api GET "/workers/domains" | grep -q "\"$(site_key "$s")\""; then echo "domain yes"; else echo "domain no"; fi
  else
    c=$(api_code GET "/workers/scripts/$(dispatcher_name "$s")")
    case "$c" in 200) echo "dispatcher yes" ;; 404) echo "dispatcher no" ;; *) echo "dispatcher unknown" ;; esac
  fi
  echo "script $(ns_script_state "$(user_script "$s")")"
  c=$(api_code GET "/storage/kv/namespaces/$KV_ID/values/$(site_key "$s")")
  case "$c" in 200) echo "entry yes" ;; 404) echo "entry no" ;; *) echo "entry unknown" ;; esac
  c=$(api_code GET "/r2/buckets/$(media_bucket "$s")")
  case "$c" in 200) echo "bucket yes" ;; 404) echo "bucket no" ;; *) echo "bucket unknown" ;; esac
}
footprint_absent() { # footprint_absent <footprint text>: 0 when every part is absent
  ! printf '%s\n' "$1" | grep -qvE '^(dispatcher no|domain no|script gone|entry no|bucket no)$'
}
footprint_present() { # footprint_present <footprint text>: 0 when every part is there
  ! printf '%s\n' "$1" | grep -qvE '^(dispatcher yes|domain yes|script present|entry yes|bucket yes)$'
}
# What a site's workspace RECORDS: its hostname, whether it has a Custom
# Domain, and that domain's zone. Prints "<hostname> <true|false> <zone_id|->",
# or nothing when the workspace records no hostname (a site that was never
# applied). Needs the site's workspace selected. For an existing site these
# win over the computed ones (site_host, WFP_CUSTOM_DOMAIN, the zone_id
# default): a site can be added with its own apex on its own zone (ggc.sh on
# the ggc.sh zone), and an update, import or remove that recomputed them
# would re-key its site map entry and replace its Custom Domain on another
# zone, which takes the site off its domain.
site_recorded() {
  local host cd=false zone=-
  host=$(tfr site output -raw hostname 2>/dev/null) || host=""
  case "$host" in *[!A-Za-z0-9.-]*|"") return 0 ;; esac
  if tfr site state list 2>/dev/null | grep -qxF 'cloudflare_workers_custom_domain.site[0]'; then
    cd=true
    zone=$(tfr site state show -no-color 'cloudflare_workers_custom_domain.site[0]' 2>/dev/null | sed -n 's/^ *zone_id *= *"\([0-9a-f]*\)"$/\1/p' | head -1)
    [ -n "$zone" ] || { echo "site_recorded: the Custom Domain in the state has no zone_id; stopping" >&2; return 1; }
  fi
  echo "$host $cd $zone"
}
# The -var arguments for an EXISTING site: the recorded values when there are
# some, else the computed ones (phase A, or WFP_CUSTOM_DOMAIN). Sets the
# globals REC_HOST, REC_CD and REC_VARS. Needs the site's workspace selected.
site_vars() { # site_vars <site> <workers.dev subdomain> <kv id>
  local rec zone
  rec=$(site_recorded) || return 1
  if [ -n "$rec" ]; then
    read -r REC_HOST REC_CD zone <<< "$rec"
  else
    REC_HOST=$(site_host "$1" "$2"); zone=-
    REC_CD=$([ "${WFP_CUSTOM_DOMAIN:-0}" = 1 ] && echo true || echo false)
  fi
  REC_SITE=$1
  REC_VARS=(-var "name=$1" -var "hostname=$REC_HOST" -var "kv_namespace_id=$3" -var "custom_domain=$REC_CD")
  [ "$zone" = - ] || REC_VARS+=(-var "zone_id=$zone")
}
# The sites: the Terraform workspaces of terraform/site, without "default".
list_sites() {
  tfr site init -input=false >/dev/null 2>&1 || return 1
  tfr site workspace list | tr -d ' *' | grep -v '^default$' | grep -v '^$' || true
}
# A site answers its OWN title through its dispatcher: HTTP 200 and the page
# <title> contains <want>. Used by cross.sh's setup-green gate (issue #35).
site_title_ok() { # site_title_ok <url> <want>
  local body code title
  body=$(curl -s -m 60 -w '\n%{http_code}' "$1" 2>/dev/null) || return 1
  code=${body##*$'\n'}; body=${body%$'\n'*}
  [ "$code" = 200 ] || return 1
  title=$(printf '%s' "$body" | sed -n 's/.*<title>\([^<]*\)<\/title>.*/\1/p' | head -1)
  case "$title" in *"$2"*) return 0 ;; *) return 1 ;; esac
}
# Wait for a re-uploaded site to run the new build (issue #35 slice 5). Poll
# /_build (the OBJECT's running version) until it equals <want>. Measured
# 2026-11-06: a re-upload flips it in about 1 s. If it has not flipped by
# BUILD_EVICT_AFTER s, call /_evict once (the fast-path for a busy object;
# abort() is unproven on our compat date, so this is best-effort), then keep
# polling to BUILD_WAIT s. Prints the last build seen; 0 when it flips.
wait_build() { # wait_build <origin> <token> <want>
  local t0=$SECONDS b evicted=0
  while :; do
    b=$(curl -s -m 30 -K <(printf 'header = "x-spike-token: %s"\n' "$2") "$1/_build" 2>/dev/null | python3 -c "import json,sys
try: print(json.load(sys.stdin).get(\"build\",\"\"))
except Exception: print(\"\")")
    [ "$b" = "$3" ] && { echo "  build $b live after $((SECONDS - t0)) s"; return 0; }
    if [ "$evicted" = 0 ] && [ $((SECONDS - t0)) -ge "${BUILD_EVICT_AFTER:-20}" ]; then
      echo "  the old build still runs after $((SECONDS - t0)) s; calling /_evict (best-effort)" >&2
      curl -s -o /dev/null -m 30 -K <(printf 'header = "x-spike-token: %s"\n' "$2") "$1/_evict" || true
      evicted=1
    fi
    [ $((SECONDS - t0)) -lt "${BUILD_WAIT:-60}" ] || { echo "the new build $3 did not go live in ${BUILD_WAIT:-60} s (last: ${b:-none})" >&2; return 1; }
    sleep "${BUILD_POLL_S:-3}"
  done
}
# Run <updater-fn> over the sites in order, STOP at the first failure: the
# sites after the failed one are NOT reached, so a bad version never rolls
# across the estate (issue #35 slice 5). Prints a summary; returns 1 if any
# failed.
update_all() { # update_all <updater-fn> <site>...
  local fn=$1; shift
  local rc=0 done_list="" failed="" left="" site
  for site in "$@"; do
    if [ "$rc" = 0 ]; then
      if "$fn" "$site"; then done_list="$done_list $site"; else rc=1; failed=" $site"; fi
    else left="$left $site"; fi
  done
  echo "update --all: updated:${done_list:- none}; failed:${failed:- none}; not reached:${left:- none}"
  return "$rc"
}
subdomain() {
  api GET /workers/subdomain | sed '$d' | python3 -c 'import json, sys; print(json.load(sys.stdin)["result"]["subdomain"])'
}

# Terraform: tfr <root> <args...> in deploy/wfp/terraform/<root>. WFP_STATE=r2
# keeps the state in the R2 state bucket (wp-on-cf-tfstate, key
# wfp-ref/<root>.tfstate; a site workspace adds its own prefix), as deploy/ does.
tfr() {
  local r=$1; shift
  if [ "${WFP_STATE:-local}" = r2 ] && [ ! -f "$WFP/terraform/$r/backend_override.tf" ]; then
    cat > "$WFP/terraform/$r/backend_override.tf" <<HCL
terraform {
  backend "s3" {
    bucket                      = "wp-on-cf-tfstate"
    key                         = "wfp-ref/$r.tfstate"
    region                      = "auto"
    endpoints                   = { s3 = "https://$ACCOUNT_ID.r2.cloudflarestorage.com" }
    use_path_style              = true
    use_lockfile                = true
    skip_s3_checksum            = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
  }
}
HCL
  fi
  (cd "$WFP/terraform/$r" && terraform "$@")
}
log() { printf '\n== %s\n' "$*"; }

# down_empty_bucket <site>: empty the site's media bucket before its workspace is
# destroyed. Uses the caller's VARS and the workspace already selected.
# Only the teardown key is applied (-target; it does not depend on the bucket or
# the entry), and only when the bucket exists: a down creates nothing else. If
# the empty FAILS, the key is applied away again (teardown=false) before this
# returns the failure, so a failed `site remove` does not leave a live R2 key in
# the account and the state. On success the key goes with the destroy that
# follows. R2_EMPTY overrides the empty script (tests).
down_empty_bucket() {
  local s=$1 B rc=0
  B=$(media_bucket "$s")
  if [ "$(api_code GET "/r2/buckets/$B")" != 200 ]; then
    echo "  bucket $B does not exist: nothing to empty"; return 0
  fi
  tfr site apply -input=false -auto-approve "${VARS[@]}" -var teardown=true -target=cloudflare_account_token.teardown >/dev/null || return 1
  R2_KEY_ID=$(tfr site output -raw teardown_access_key_id) R2_SECRET=$(tfr site output -raw teardown_secret_access_key) \
    "${R2_EMPTY:-$ROOT/deploy/variants/r2-empty.sh}" "$(tfr site output -raw r2_endpoint)" "$B" || rc=$?
  if [ "$rc" != 0 ]; then
    echo "  emptying $B failed (exit $rc): removing the teardown key before stopping" >&2
    tfr site apply -input=false -auto-approve "${VARS[@]}" -var teardown=false -target=cloudflare_account_token.teardown >/dev/null \
      || echo "site $s: DELETE THE TEARDOWN KEY: cloudflare_account_token.teardown is still in workspace $s" >&2
    return "$rc"
  fi
}
