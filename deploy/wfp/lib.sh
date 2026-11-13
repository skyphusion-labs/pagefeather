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
# Semantic site search (#330, the vectorize-search descriptor of deploy/provision): the per-site
# Vectorize index, the same name and preset as wp-site-config.mjs searchIndexName and
# SEARCH_EMBED_PRESET, so the skyphusion-ai plugin finds the same index on either path.
search_index() { echo "wp-wfp-$1-search"; }
SEARCH_EMBED_PRESET="@cf/baai/bge-large-en-v1.5"
search_on() { [ -n "${WP_VECTORIZE_SEARCH:-}" ] && [ "${WP_VECTORIZE_SEARCH}" != off ]; }

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
# Turnstile (#340, the feature is #250/#308): opt-in. TURNSTILE_SITEKEY (public) goes in [vars];
# TURNSTILE_SECRET goes ONLY in the secrets JSON (site_secrets_json), read from the environment of
# the run. The site key must match the shape turnstile.mjs sanitizeSiteKey accepts, or render fails:
# it is written into the TOML. A site with neither stays as it was.
turnstile_vars() {
  [ -n "${TURNSTILE_SITEKEY:-}" ] || return 0
  [[ "$TURNSTILE_SITEKEY" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || { echo "TURNSTILE_SITEKEY is not a Turnstile site key ([A-Za-z0-9_-], 1 to 64, as turnstile.mjs sanitizeSiteKey)" >&2; return 1; }
  echo "TURNSTILE_SITEKEY = \"$TURNSTILE_SITEKEY\""
  local f v
  for f in TURNSTILE_WOO TURNSTILE_LOGIN TURNSTILE_COMMENTS; do
    v=${!f:-}
    case "$v" in "") ;; off) echo "$f = \"off\"" ;; *) echo "$f must be off or unset, not $v" >&2; return 1 ;; esac
  done
}
# The --secrets-file JSON of a user Worker: WP_SALT and SPIKE_TOKEN from the site workspace
# (tfr site output -json on stdin), plus TURNSTILE_SECRET when the run's environment has it (#340).
# Values go from stdin and the environment to the file only, never to argv or stdout.
site_secrets_json() { # site_secrets_json <out file>  (stdin: tfr site output -json)
  python3 -I -c 'import json, os, sys
o = {k: v["value"] for k, v in json.load(sys.stdin).items()}
s = {"WP_SALT": o["wp_salt"], "SPIKE_TOKEN": o["spike_token"]}
if os.environ.get("TURNSTILE_SECRET"):
    s["TURNSTILE_SECRET"] = os.environ["TURNSTILE_SECRET"]
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(s, f)' "$1"
}
# PHP_INI (#394): optional php.ini overrides for ONE site, a JSON object of name to value, e.g.
#   PHP_INI='{"opcache.memory_consumption":"48"}' deploy/wfp/site update <name>
# index.js passes it to PHP at every boot (setPhpIniEntries, after its own defaults, so it wins).
# It goes into [vars] as compact JSON with sorted keys. Refused (the render fails): not a JSON
# object, empty, more than 32 entries, a name outside [A-Za-z0-9_.] (1 to 64), a value that is not a
# string or an integer, or a string with a quote, a backslash or a control character (the TOML is a
# literal string) or over 256 characters. Like TURNSTILE_*, it is read from the run's environment
# only: an update that does not pass it renders the site WITHOUT it.
php_ini_var() {
  [ -n "${PHP_INI:-}" ] || return 0
  PHP_INI="$PHP_INI" python3 -I -c 'import json, os, re, sys
def bad(m):
    print("PHP_INI: " + m, file=sys.stderr); sys.exit(1)
try:
    o = json.loads(os.environ["PHP_INI"])
except ValueError:
    bad("not JSON")
if not isinstance(o, dict) or not o: bad("must be a non-empty JSON object")
if len(o) > 32: bad("more than 32 entries")
for k, v in o.items():
    if not re.fullmatch(r"[A-Za-z0-9_.]{1,64}", k): bad("bad name %r" % k)
    if isinstance(v, bool) or not isinstance(v, (str, int)): bad("the value of %s must be a string or an integer" % k)
    if isinstance(v, str) and (len(v) > 256 or re.search(r"[\x00-\x1f\x7f\x27\x22\\]", v)): bad("bad value for %s" % k)
print("PHP_INI = %s" % chr(39) + json.dumps(o, separators=(",", ":"), sort_keys=True) + chr(39))'
}
render_user() { # render_user <site> <origin>
  local s=$1 origin=$2 mail_binding mail_vars http_allow ts_vars
  mail_binding=$(SITE_ORIGIN="$origin" MAIL_FROM="${MAIL_FROM:-}" node "$APP/mail-from.mjs" --binding) || return 1
  mail_vars=$(SITE_ORIGIN="$origin" MAIL_FROM="${MAIL_FROM:-}" MAIL_FROM_NAME="${MAIL_FROM_NAME:-}" node "$APP/mail-from.mjs" --vars) || return 1
  http_allow=$(node "$APP/http-allow.mjs") || return 1
  ts_vars=$(turnstile_vars) || return 1
  # PHP_INI (#394) joins the Turnstile lines, so a site without it renders byte for byte as before.
  local php_ini; php_ini=$(php_ini_var) || return 1
  [ -z "$php_ini" ] || ts_vars=${ts_vars:+$ts_vars$'\n'}$php_ini
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
$ts_vars
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
  # Workers Logs for this one site (#291: wrangler tail cannot follow a namespace script). Privacy
  # first (the live store, 2026-11-13): the default invocation logs record each request's client IP,
  # full URL and user agent. So:
  #   OBSERVABILITY=1     events only: our own structured lines and uncaught exceptions, NO request
  #                       metadata (invocation_logs = false). For a diagnosis on a live site.
  #   OBSERVABILITY=full  the invocation logs too. For a throwaway only.
  #   unset or 0          an EXPLICIT enabled = false: without the block a re-upload left a site's
  #                       logging as it was, so "off" did not turn it off.
  case "${OBSERVABILITY:-0}" in
    0) printf '\n[observability]\nenabled = false\n' ;;
    1) printf '\n[observability]\nenabled = true\nhead_sampling_rate = 1\n[observability.logs]\nenabled = true\ninvocation_logs = false\n' ;;
    full) printf '\n[observability]\nenabled = true\nhead_sampling_rate = 1\n[observability.logs]\nenabled = true\ninvocation_logs = true\n' ;;
    *) echo "OBSERVABILITY must be 0, 1 (events only) or full (a throwaway only), not ${OBSERVABILITY}" >&2; return 1 ;;
  esac
  # WP_VECTORIZE_SEARCH (default off, metered): the token-free AI and SEARCH_INDEX bindings the
  # skyphusion-ai plugin reaches through the index.js op bridge (#330, #332). The index must exist
  # before the deploy; site.sh up makes it (ensure_search_index).
  if search_on; then printf '\n[ai]\nbinding = "AI"\n[[vectorize]]\nbinding = "SEARCH_INDEX"\nindex_name = "%s"\n' "$(search_index "$s")"; fi
}
# The site's search index, as Vectorize answers it (#338): present (200); gone (404, or 410 with
# error 3005 "vectorize.index.deleted", which is how v2 answers a DELETED index, measured on
# fdprobe1112e 2026-11-12); otherwise "unknown <code>", never read as gone.
search_index_state() { # search_index_state <site>
  local out code
  out=$(api GET "/vectorize/v2/indexes/$(search_index "$1")"); code=${out##*$'\n'}
  case "$code" in
    200) echo present ;;
    404) echo gone ;;
    410) if printf '%s' "${out%$'\n'*}" | python3 -I -c 'import json, sys
try: d = json.load(sys.stdin)
except ValueError: sys.exit(1)
sys.exit(0 if any(isinstance(e, dict) and e.get("code") == 3005 for e in (d.get("errors") or [])) else 1)'; then echo gone; else echo "unknown 410"; fi ;;
    *) echo "unknown $code" ;;
  esac
}
# The site's search index (#330): make it when absent (idempotent: an existing one is kept), with
# the bge-large preset (1024 dimensions, cosine). Exit 1 when it cannot be made or read back.
ensure_search_index() { # ensure_search_index <site>
  local n c st; n=$(search_index "$1")
  st=$(search_index_state "$1")
  case "$st" in present) echo "  search index $n exists"; return 0 ;; gone) ;; *) echo "search index $n: $st; stopping" >&2; return 1 ;; esac
  c=$(api_code POST "/vectorize/v2/indexes" -H 'content-type: application/json' --data "{\"name\":\"$n\",\"config\":{\"preset\":\"$SEARCH_EMBED_PRESET\"}}")
  case "$c" in 200|201) ;; *) echo "search index $n: create answered $c; stopping" >&2; return 1 ;; esac
  st=$(search_index_state "$1")
  [ "$st" = present ] || { echo "search index $n: not readable after the create ($st)" >&2; return 1; }
  echo "  search index $n made ($SEARCH_EMBED_PRESET)"
}
# Remove the site's search index when it has one, whatever WP_VECTORIZE_SEARCH says now (a site
# added with it on and removed with it off must not leave its index). Then it must read 404.
remove_search_index() { # remove_search_index <site>
  local n st; n=$(search_index "$1")
  st=$(search_index_state "$1")
  case "$st" in gone) echo "  search index $n: none"; return 0 ;; present) ;; *) echo "search index $n: $st; stopping" >&2; return 1 ;; esac
  api DELETE "/vectorize/v2/indexes/$n" > /dev/null || true
  st=$(search_index_state "$1")
  case "$st" in gone) echo "  search index $n is gone (404, or 410 vectorize.index.deleted)" ;; *) echo "  search index $n is NOT gone ($st): stopping" >&2; return 1 ;; esac
}

# WOO_ACTIVE for the OPcache priming (#313), from the build inputs only: an explicit WOO_ACTIVE
# (0 or 1) wins; else 1 when woocommerce is in the site plugin set (IMPORT_PLUGINS or PLUGINS),
# else 0. Never from the local dev state.
woo_active_for_build() {
  case "${WOO_ACTIVE:-}" in 0|1) echo "$WOO_ACTIVE"; return 0 ;; "") ;; *) echo "WOO_ACTIVE must be 0 or 1, not $WOO_ACTIVE" >&2; return 2 ;; esac
  case " ${IMPORT_PLUGINS:-} ${PLUGINS:-} " in *" woocommerce "*) echo 1 ;; *) echo 0 ;; esac
}
# A site update must not ship a build the live site cannot run (#377). On 2026-11-12 a plain
# `site update ggc-test` (no content inputs, no WOO_ACTIVE) replaced the store's build with stock
# WordPress and an OPcache without WooCommerce (615 files, not 2131): every request answered 503
# "The site restarted". Two refusals, before any snapshot, build or upload:
#   - the live Store API answers 200 (WooCommerce is active) and this build would not prime it;
#     an answer that is neither 200 nor 404 needs an explicit WOO_ACTIVE (it cannot tell);
#   - the live build id ends in a content id (-c<8 hex>, build.sh: made with PLUGINS or
#     IMPORT_CONTENT) and this run has no content input. ALLOW_PLAIN_BUILD=1 replaces them on
#     purpose. A build id set by hand (BUILD_ID_OVERRIDE) carries no content id; the Store API
#     refusal still holds there.
# update_inputs_check <live build id> <Store API code> <woo 0|1> <content inputs 0|1>
update_inputs_check() {
  local live=$1 code=$2 woo=$3 content=$4
  case "$code" in
    200) [ "$woo" = 1 ] || { echo "WooCommerce is active on the live site (Store API 200), but this build would not prime it (WOO_ACTIVE=$woo): the OPcache would ship without WooCommerce and the store would run out of memory on every request (#313). Pass the site's content inputs (IMPORT_PLUGINS with woocommerce) or WOO_ACTIVE=1." >&2; return 2; } ;;
    404) ;;
    *) [ -n "${WOO_ACTIVE:-}" ] || { echo "the Store API check answered $code, neither 200 nor 404, so it cannot tell whether WooCommerce is active: set WOO_ACTIVE=0 or 1" >&2; return 2; } ;;
  esac
  if [[ "$live" =~ -c[0-9a-f]{8}(-wooprimed)?$ ]] && [ "$content" = 0 ] && [ "${ALLOW_PLAIN_BUILD:-0}" != 1 ]; then
    echo "the live build $live was made with content inputs (PLUGINS or IMPORT_CONTENT), and this run has none: it would ship stock WordPress without the site's theme, plugins and mu-plugins. Pass the same content inputs, or ALLOW_PLAIN_BUILD=1 to drop them on purpose." >&2
    return 2
  fi
}
# A site update builds from this tree. A dirty tree makes a -dirty build that nobody can rebuild or
# read back: ggc's live build a0889bfcf082-dirty (2026-11-12) left no record of what it held, so its
# content inputs could not be checked before the update replaced it (#377). Refused unless
# ALLOW_DIRTY=1. tree_clean_check [git dir]
tree_clean_check() {
  local d=${1:-$ROOT} st
  st=$(git -C "$d" status --porcelain 2>/dev/null) || { echo "cannot read the git status of $d" >&2; return 2; }
  [ -z "$st" ] || [ "${ALLOW_DIRTY:-0}" = 1 ] || { echo "the tree $d has uncommitted changes, so the build would be -dirty (not reproducible). Commit or stash them, or ALLOW_DIRTY=1 on purpose:" >&2; echo "$st" | head -10 >&2; return 2; }
}
# 1 when this run has a content input (the rule content-id.py uses), else 0.
content_inputs_set() { if [ -n "${PLUGINS:-}${IMPORT_CONTENT:-}" ]; then echo 1; else echo 0; fi; }
# The HTTP code of the site's Store API index (200: WooCommerce active, 404: not), 000 on no answer.
store_api_code() { curl -s -o /dev/null -m 60 -w '%{http_code}' "$1/?rest_route=/wc/store/v1" 2>/dev/null || true; }
# The recorded build inputs of a site (#379, build_inputs.py): _build/inputs.json and the content
# tree _build/<content id>.tar.gz in the site's own media bucket (private outside uploads/).
# use_recorded_inputs <bucket> <work dir>, called by update_one, which declares the inputs
# (PLUGINS, IMPORT_THEMES, IMPORT_PLUGINS, IMPORT_MU_PLUGINS, WOO_ACTIVE, IMPORT_CONTENT) local -x,
# so a recorded value set here stays inside that one update (update --all runs many).
#   no record:                    nothing changes; this run's inputs are recorded after the update
#   a record, a run with no input: the recorded inputs are set and the content tree is fetched
#   a record, different inputs:    refused (2) unless REPLACE_INPUTS=1; the differences are printed
# Sets REC_TREE to the recorded tree key when this run uses it, else "".
use_recorded_inputs() {
  local b=$1 w=$2 rec="$2/inputs.json" rc=0
  REC_TREE=""
  python3 -I "$WFP/build_inputs.py" get "$b" "$rec" || rc=$?
  case "$rc" in
    0) ;;
    3) echo "  no recorded build inputs yet (a site from before #379): this run's inputs are recorded after the update"; return 0 ;;
    *) echo "cannot read the recorded build inputs of $b; refused" >&2; return 2 ;;
  esac
  if [ "$(content_inputs_set)" = 0 ] && [ -z "${WOO_ACTIVE:-}" ]; then
    local tree; tree=$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1])).get("tree", ""))' "$rec")
    if [ -n "$tree" ]; then
      [[ "$tree" =~ ^_build/c[0-9a-f]{8}\.tar\.gz$ ]] || { echo "the recorded content tree key is not _build/c<8 hex>.tar.gz: $tree; refused" >&2; return 2; }
      python3 -I "$WFP/build_inputs.py" tree-get "$b" "$tree" "$w" > /dev/null || { echo "cannot fetch the recorded content tree $b/$tree; refused" >&2; return 2; }
      REC_TREE=$tree
    fi
    eval "$(python3 -I "$WFP/build_inputs.py" exports "$rec" "$w/wp-content")"
    echo "  using the recorded build inputs: WOO_ACTIVE=${WOO_ACTIVE:-} PLUGINS='${PLUGINS:-}' IMPORT_THEMES='${IMPORT_THEMES:-}' IMPORT_PLUGINS='${IMPORT_PLUGINS:-}' IMPORT_MU_PLUGINS='${IMPORT_MU_PLUGINS:-}' tree ${tree:-none}"
    return 0
  fi
  rc=0; python3 -I "$WFP/build_inputs.py" compare "$rec" > "$w/diff" || rc=$?
  case "$rc" in
    0) echo "  this run's inputs equal the recorded ones" ;;
    4) if [ "${REPLACE_INPUTS:-0}" = 1 ]; then echo "  REPLACE_INPUTS=1: the recorded inputs are replaced:"; cat "$w/diff"
       else echo "this run's build inputs differ from the recorded ones; refused (REPLACE_INPUTS=1 replaces them on purpose):" >&2; cat "$w/diff" >&2; return 2; fi ;;
    *) echo "cannot compare with the recorded build inputs; refused" >&2; return 2 ;;
  esac
}
# record_build_inputs <bucket> <build id> <work dir>: after a good upload, record this run's inputs.
# The content tree is packed from IMPORT_CONTENT and stored under its content id, unless this run
# used that same recorded tree (REC_TREE).
record_build_inputs() {
  local b=$1 id=$2 w=$3 cid key=""
  # The same two trees build-id.sh hashes, so the recorded content id equals the build id's.
  cid=$(cd "$APP" && python3 -I content-id.py build/wordpress/wp-content build/public/wp-content) || return 1
  if [ -n "${IMPORT_CONTENT:-}" ] && [ -n "$cid" ]; then
    key="_build/$cid.tar.gz"
    if [ "${REC_TREE:-}" != "$key" ]; then
      python3 -I "$WFP/build_inputs.py" pack "$IMPORT_CONTENT" "$w/tree.tar.gz" || return 1
      python3 -I "$WFP/build_inputs.py" tree-put "$b" "$key" "$w/tree.tar.gz" || return 1
    fi
  fi
  python3 -I "$WFP/build_inputs.py" env-json "$cid" "$key" "$id" > "$w/record.json" || return 1
  python3 -I "$WFP/build_inputs.py" put "$b" "$w/record.json" || return 1
  echo "  build inputs recorded in $b/_build/inputs.json (content ${cid:-none}, tree ${key:-none})"
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
    # WOO_ACTIVE reaches build.sh too, so the build id says whether it is primed (#377).
    WOO_ACTIVE=$woo ./build.sh | tail -1
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
# The clock and the sleep of wait_site, as two functions a test can redefine after it sources
# this file (#319): the test then drives a fake clock by request count, so a loaded box cannot
# move a case across a bound. The defaults are the real ones: $SECONDS and sleep.
wait_now() { echo "$SECONDS"; }
wait_sleep() { sleep "$1"; }
wait_site() { # wait_site <origin>
  local t0 t code err body cap said_tls=0 said_dispatch=0
  t0=$(wait_now)
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
        if [ $(($(wait_now) - t0)) -ge "${WFP_DISPATCH_GRACE:-120}" ]; then
          echo "the dispatcher answered $code $err for ${WFP_DISPATCH_GRACE:-120} s: a fault in the site script, not a cold boot ($body)" >&2; rm -rf "$t"; return 1
        fi
        [ "${said_dispatch:-0}" = 1 ] || { echo "  the site script errored ($code $err); retrying for up to ${WFP_DISPATCH_GRACE:-120} s (a first cold boot)"; said_dispatch=1; } ;;
    esac
    if [ -z "$err" ] && [[ "$code" =~ ^(2..|3..|401|403)$ ]]; then
      echo "  the site answered HTTP $code after $(($(wait_now) - t0)) s"
      rm -rf "$t"; return 0
    fi
    # Phase B first deploy: a new Custom Domain's Advanced Certificate may still
    # be issuing, so TLS is not ready and curl reads 000 or a 52x edge code.
    # That is a delay, not a fault: say so once and keep waiting to the cap.
    if [ "${WFP_CUSTOM_DOMAIN:-0}" = 1 ] && [ "$said_tls" = 0 ] && [[ "$code" =~ ^(000|522|523|525|526)$ ]]; then
      echo "  waiting for TLS on $1 (the Advanced Certificate may still be issuing; up to ${cap}s)"
      said_tls=1
    fi
    if [ $(($(wait_now) - t0)) -ge "$cap" ]; then
      echo "the site did not answer in ${cap} s; last: HTTP $code${err:+, x-wfp-error $err}, body: $body" >&2
      [ "${WFP_CUSTOM_DOMAIN:-0}" = 1 ] && echo "  if the Advanced Certificate for $1 is still issuing, re-run up.sh once it is active: the data plane persists and the install completes on the re-run" >&2
      rm -rf "$t"; return 1
    fi
    wait_sleep "${SITE_WAIT_STEP:-10}"
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
  # The search index (#330): a part when WP_VECTORIZE_SEARCH is on, or whenever one exists.
  case "$(search_index_state "$s")" in present) echo "search yes" ;; gone) ! search_on || echo "search no" ;; *) echo "search unknown" ;; esac
}
# Who wrote a site's map entry (#294): "core" when it is the provisioning core's (cli.mjs or the
# provisioning Worker: its entry has a "kind" field, and this package's Terraform entry never
# does), "workspace" for any other entry, "none" when there is none, "unknown" when it cannot be
# read. deploy/wfp/site remove refuses a core site BEFORE any change: it has parts this package
# does not make or know (a per-site KV namespace, descriptor resources), so a remove here could
# only ever be half of one.
entry_by_core() { # entry_by_core <name>; needs KV_ID and SUB
  local out code
  out=$(api GET "/storage/kv/namespaces/$KV_ID/values/$(site_key "$1")")
  code=${out##*$'\n'}
  case "$code" in
    404) echo none; return 0 ;;
    200) ;;
    *) echo unknown; return 0 ;;
  esac
  printf '%s' "${out%$'\n'*}" | python3 -I -c 'import json, sys
try: d = json.loads(sys.stdin.read())
except ValueError: print("unknown"); sys.exit(0)
print("core" if isinstance(d, dict) and "kind" in d else "workspace")'
}
footprint_absent() { # footprint_absent <footprint text>: 0 when every part is absent
  ! printf '%s\n' "$1" | grep -qvE '^(dispatcher no|domain no|script gone|entry no|bucket no|search no)$'
}
footprint_present() { # footprint_present <footprint text>: 0 when every part is there
  ! printf '%s\n' "$1" | grep -qvE '^(dispatcher yes|domain yes|script present|entry yes|bucket yes|search yes)$'
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
  # Loud on failure (#338): a silent exit 1 here hid a missing state credential.
  tfr site init -input=false >/dev/null 2>&1 || {
    echo "list_sites: terraform init of deploy/wfp/terraform/site failed (WFP_STATE=${WFP_STATE:-local}; with r2 it needs the R2 state credentials AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY loaded)" >&2
    return 1
  }
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
