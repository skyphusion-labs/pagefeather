#!/usr/bin/env bash
# Live round trip for `site update` on a throwaway dispatch namespace (#782).
# The lead runs this. It was not run when it was added. It makes real Cloudflare
# calls only when the lead runs it. Do not point it at a customer namespace.
#
# Environment (a missing or refused value exits 2, and nothing is created):
#   CLOUDFLARE_API_TOKEN   never printed, never written except a mode-600 header file
#   CLOUDFLARE_ACCOUNT_ID
#   WFP_NAMESPACE          must start with pfthrow-
#   WFP_KV_ID
#   WFP_SAAS_ZONE_ID
#   PF_ZONE_DOMAIN         each site's hostname is <name>.<this>
#   BDOSQL_BUNDLE_DIR      pre-built kind wp bundle
#   A_BUNDLE_DIR           pre-built kind a bundle
#   PF_HYPERDRIVE_ID       Hyperdrive config id for the kind a site
#   PF_PLACEMENT           optional, default azure:westus2
#
# Exit 0 only when every check passed. Exit 1 when a check differed or a
# command failed. Exit 2 when a check could not be measured and nothing differed.
# A difference wins over could-not-measure.
#
# Durable Object data is could-not-measure. See the data events below.
# The Analytics Engine dataset is not checked: site remove does not delete it.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
CLI="$ROOT/deploy/provision/cli.mjs"

DIFF=0
CNM=0
ADDED_WP=0
ADDED_A=0
REMOVED_WP=0
REMOVED_A=0
WORK=""
AUTH_HDR=""
WP_NAME=""
A_NAME=""
WP_HOST=""
A_HOST=""
PF_PLACEMENT="${PF_PLACEMENT:-azure:westus2}"

die_cnm() { echo "could-not-measure: $1" >&2; exit 2; }

# Invoked by the EXIT trap below, including after a failed command.
# shellcheck disable=SC2329
on_exit() {
  local rc=$?
  set +e
  if [ "$ADDED_WP" = 1 ] && [ "$REMOVED_WP" != 1 ] && [ -n "$WP_NAME" ]; then
    echo "cleanup: site remove --delete-data $WP_NAME" >&2
    WP_HOSTNAME="$WP_HOST" node "$CLI" remove "$WP_NAME" --delete-data || true
  fi
  if [ "$ADDED_A" = 1 ] && [ "$REMOVED_A" != 1 ] && [ -n "$A_NAME" ]; then
    echo "cleanup: site remove --delete-data $A_NAME" >&2
    WP_HOSTNAME="$A_HOST" node "$CLI" remove "$A_NAME" --delete-data || true
  fi
  [ -n "$AUTH_HDR" ] && rm -f "$AUTH_HDR"
  [ -n "$WORK" ] && rm -rf "$WORK"
  exit "$rc"
}
trap on_exit EXIT

need() {
  local name=$1
  if [ -z "${!name:-}" ]; then die_cnm "$name is unset"; fi
}

need CLOUDFLARE_API_TOKEN
need CLOUDFLARE_ACCOUNT_ID
need WFP_NAMESPACE
need WFP_KV_ID
need WFP_SAAS_ZONE_ID
need PF_ZONE_DOMAIN
need BDOSQL_BUNDLE_DIR
need A_BUNDLE_DIR
need PF_HYPERDRIVE_ID

case "$CLOUDFLARE_API_TOKEN" in
  *[[:space:]]*) die_cnm "CLOUDFLARE_API_TOKEN contains whitespace" ;;
esac
case "$WFP_NAMESPACE" in
  pfthrow-*) ;;
  *) echo "refusing: WFP_NAMESPACE must start with pfthrow-" >&2; exit 2 ;;
esac
case "$WFP_NAMESPACE" in
  *[!a-z0-9-]*) die_cnm "WFP_NAMESPACE has a character other than a letter, a digit, or a hyphen" ;;
esac
case "$CLOUDFLARE_ACCOUNT_ID" in
  *[!A-Za-z0-9]*) die_cnm "CLOUDFLARE_ACCOUNT_ID has an unexpected character" ;;
esac
case "$WFP_KV_ID" in
  *[!A-Za-z0-9]*) die_cnm "WFP_KV_ID has an unexpected character" ;;
esac
case "$WFP_SAAS_ZONE_ID" in
  *[!A-Za-z0-9]*) die_cnm "WFP_SAAS_ZONE_ID has an unexpected character" ;;
esac
case "$PF_HYPERDRIVE_ID" in
  *[!A-Za-z0-9-]*) die_cnm "PF_HYPERDRIVE_ID has an unexpected character" ;;
esac
case "$PF_ZONE_DOMAIN" in
  *[!a-z0-9.-]*|.*|*.|*..*) die_cnm "PF_ZONE_DOMAIN must be a hostname" ;;
esac
case "$PF_ZONE_DOMAIN" in
  *.*) ;;
  *) die_cnm "PF_ZONE_DOMAIN must be a hostname" ;;
esac
if ! printf '%s' "$PF_PLACEMENT" | grep -Eq '^(aws|gcp|azure):[a-z0-9-]{2,40}$'; then
  die_cnm "PF_PLACEMENT must be <aws|gcp|azure>:<region>"
fi
[ -d "$BDOSQL_BUNDLE_DIR" ] || die_cnm "BDOSQL_BUNDLE_DIR is not a directory"
[ -d "$A_BUNDLE_DIR" ] || die_cnm "A_BUNDLE_DIR is not a directory"
command -v node >/dev/null 2>&1 || die_cnm "node is not on PATH"
command -v python3 >/dev/null 2>&1 || die_cnm "python3 is not on PATH"
command -v curl >/dev/null 2>&1 || die_cnm "curl is not on PATH"
[ -f "$CLI" ] || die_cnm "the site CLI is not at $CLI"

# site update must not inherit a date from the operator's shell. Add still has
# its own default. Update reads the live script.
unset WFP_COMPAT

slug=$(printf '%s' "$WFP_NAMESPACE" | tr -cd 'a-z0-9')
slug=${slug:0:12}
[ -n "$slug" ] || die_cnm "WFP_NAMESPACE has no letters or digits for a site name"
WP_NAME="${slug}wp"
A_NAME="${slug}a"
WP_HOST="${WP_NAME}.${PF_ZONE_DOMAIN}"
A_HOST="${A_NAME}.${PF_ZONE_DOMAIN}"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/pf782-live.XXXXXX")
chmod 700 "$WORK"
AUTH_HDR="$WORK/auth"
umask 077
printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN" > "$AUTH_HDR"
chmod 600 "$AUTH_HDR"

cat > "$WORK/rt.py" <<'PY'
import json, sys

def split_body(raw):
    if "\n" not in raw:
        return raw, ""
    body, code = raw.rsplit("\n", 1)
    return body, code.strip()

def write(path, obj):
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
        f.write("\n")

def as_obj(body):
    if not body.strip():
        return None
    try:
        d = json.loads(body)
    except ValueError:
        return None
    if not isinstance(d, dict) or d.get("success") is False:
        return None
    return d

def sanitize(mode, body, code, path):
    http = int(code) if code.isdigit() else 0
    if mode == "bindings":
        d = as_obj(body)
        rows = d.get("result") if isinstance(d, dict) else None
        if http != 200 or not isinstance(rows, list):
            write(path, {"http": http, "ok": False})
            return
        out = []
        for b in rows:
            if not isinstance(b, dict) or not isinstance(b.get("name"), str):
                write(path, {"http": http, "ok": False})
                return
            if b.get("type") == "secret_text":
                # The value is never stored. The name check is a separate read.
                out.append({"name": b["name"], "type": "secret_text"})
            else:
                out.append(b)
        write(path, {"http": http, "ok": True, "bindings": out})
        return
    if mode == "secrets":
        d = as_obj(body)
        rows = d.get("result") if isinstance(d, dict) else None
        if http != 200 or not isinstance(rows, list):
            write(path, {"http": http, "ok": False})
            return
        names = []
        for s in rows:
            if isinstance(s, dict) and isinstance(s.get("name"), str) and s["name"]:
                names.append(s["name"])
        write(path, {"http": http, "ok": True, "names": names})
        return
    if mode == "placement":
        d = as_obj(body)
        if http != 200 or not isinstance(d, dict) or not isinstance(d.get("result"), dict):
            write(path, {"http": http, "ok": False})
            return
        pl = d["result"].get("placement") or {}
        keep = {}
        if isinstance(pl, dict):
            if isinstance(pl.get("mode"), str):
                keep["mode"] = pl["mode"]
            if isinstance(pl.get("region"), str):
                keep["region"] = pl["region"]
        write(path, {"http": http, "ok": True, "placement": keep})
        return
    if mode == "script":
        if http == 404:
            write(path, {"http": http, "ok": True, "present": False})
            return
        d = as_obj(body)
        if http != 200 or not isinstance(d, dict):
            write(path, {"http": http, "ok": False})
            return
        script = (d.get("result") or {}).get("script") if isinstance(d.get("result"), dict) else None
        present = isinstance(script, dict) and bool(script.get("id") or script.get("etag") or script.get("compatibility_date"))
        write(path, {"http": http, "ok": True, "present": present})
        return
    if mode == "kv":
        if http == 404:
            write(path, {"http": http, "ok": True, "present": False, "customHostnameId": None})
            return
        if http != 200:
            write(path, {"http": http, "ok": False})
            return
        try:
            d = json.loads(body) if body.strip() else {}
        except ValueError:
            write(path, {"http": http, "ok": False})
            return
        hid = d.get("customHostnameId") if isinstance(d, dict) else None
        if not isinstance(hid, str) or not hid:
            hid = None
        write(path, {"http": http, "ok": True, "present": True, "customHostnameId": hid})
        return
    if mode == "dns":
        d = as_obj(body)
        rows = d.get("result") if isinstance(d, dict) else None
        if http != 200 or not isinstance(rows, list):
            write(path, {"http": http, "ok": False})
            return
        write(path, {"http": http, "ok": True, "count": len(rows)})
        return
    if mode.startswith("titles:"):
        key = mode.split(":", 1)[1]
        d = as_obj(body)
        rows = d.get("result") if isinstance(d, dict) else None
        if http != 200 or not isinstance(rows, list):
            write(path, {"http": http, "ok": False})
            return
        names = []
        for row in rows:
            if isinstance(row, dict) and isinstance(row.get(key), str):
                names.append(row[key])
        write(path, {"http": http, "ok": True, "names": names, "more": len(rows) >= 100})
        return
    if mode == "status":
        write(path, {"http": http, "ok": http in (200, 404), "present": http == 200})
        return
    write(path, {"http": http, "ok": False})

def norm_binding(b):
    if b.get("type") == "secret_text":
        b = {"name": b.get("name"), "type": "secret_text"}
    return json.dumps(b, sort_keys=True, separators=(",", ":"))

def emit(kind, obj):
    print("@event " + kind + " " + json.dumps(obj, separators=(",", ":")))

def compare_bindings(site, before_path, after_path):
    before = json.load(open(before_path))
    after = json.load(open(after_path))
    if not before.get("ok") or not after.get("ok"):
        emit("binding", {"site": site, "name": "*", "result": "could-not-measure"})
        return 2
    def index(rows):
        out = {}
        for b in rows:
            name = b.get("name")
            if name in out:
                return None
            out[name] = norm_binding(b)
        return out
    bmap = index(before["bindings"])
    amap = index(after["bindings"])
    if bmap is None or amap is None:
        emit("binding", {"site": site, "name": "*", "result": "could-not-measure"})
        return 2
    rc = 0
    for name in sorted(set(bmap) | set(amap)):
        same = name in bmap and name in amap and bmap[name] == amap[name]
        emit("binding", {"site": site, "name": name, "same": same})
        if not same:
            rc = 1
    return rc

def compare_secrets(site, before_path, after_path):
    before = json.load(open(before_path))
    after = json.load(open(after_path))
    if not before.get("ok") or not after.get("ok"):
        emit("secret", {"site": site, "name": "*", "result": "could-not-measure"})
        return 2
    bset = sorted(set(before["names"]))
    aset = set(after["names"])
    rc = 0
    for name in bset:
        present = name in aset
        emit("secret", {"site": site, "name": name, "present": present})
        if not present:
            rc = 1
    for name in sorted(aset - set(bset)):
        emit("secret", {"site": site, "name": name, "present": False})
        rc = 1
    return rc

def main():
    cmd = sys.argv[1]
    if cmd == "sanitize":
        mode, path = sys.argv[2], sys.argv[3]
        body, code = split_body(sys.stdin.read())
        sanitize(mode, body, code, path)
        return 0
    if cmd == "compare-bindings":
        return compare_bindings(sys.argv[2], sys.argv[3], sys.argv[4])
    if cmd == "compare-secrets":
        return compare_secrets(sys.argv[2], sys.argv[3], sys.argv[4])
    return 2

if __name__ == "__main__":
    sys.exit(main())
PY

API="https://api.cloudflare.com/client/v4"
ACCT="$CLOUDFLARE_ACCOUNT_ID"

cf_get() {
  local url=$1 mode=$2 out=$3
  local curl_rc py_rc
  set +e
  curl -sS --proto '=https' --max-time 60 -H @"$AUTH_HDR" -w '\n%{http_code}' "$url" \
    | python3 -I "$WORK/rt.py" sanitize "$mode" "$out"
  curl_rc=${PIPESTATUS[0]}
  py_rc=${PIPESTATUS[1]}
  set -e
  [ "$curl_rc" -eq 0 ] && [ "$py_rc" -eq 0 ]
}

mark_py() {
  local rc=$1
  if [ "$rc" -eq 1 ]; then DIFF=1; elif [ "$rc" -eq 2 ]; then CNM=1; elif [ "$rc" -ne 0 ]; then DIFF=1; fi
}

run_py() {
  local rc
  set +e
  python3 -I "$WORK/rt.py" "$@"
  rc=$?
  set -e
  mark_py "$rc"
}

base_script() {
  printf '%s/accounts/%s/workers/dispatch/namespaces/%s/scripts/%s' "$API" "$ACCT" "$WFP_NAMESPACE" "$1"
}

# One page of a list. Prints names, one per line, and sets LIST_MORE=1 when the page is full.
list_page_names() {
  local url=$1 key=$2
  local f="$WORK/page.json"
  if ! cf_get "$url" "titles:$key" "$f"; then
    return 1
  fi
  python3 -I - "$f" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
if not d.get("ok"):
    sys.exit(1)
for n in d["names"]:
    print(n)
if d.get("more"):
    sys.exit(3)
sys.exit(0)
PY
}

# Exit 0 if the name is absent, 1 if present, 2 if a page could not be read.
list_absent() {
  local url_prefix=$1 key=$2 want=$3
  local page=1 rc
  while [ "$page" -le 50 ]; do
    set +e
    list_page_names "${url_prefix}&page=${page}" "$key" > "$WORK/names.txt"
    rc=$?
    set -e
    if [ "$rc" -eq 1 ]; then return 2; fi
    if grep -Fxq -- "$want" "$WORK/names.txt"; then return 1; fi
    if [ "$rc" -ne 3 ]; then return 0; fi
    page=$((page + 1))
  done
  return 2
}

event_gone() {
  local site=$1 part=$2 gone=$3
  python3 -I -c 'import json,sys; print("@event gone " + json.dumps({"site":sys.argv[1],"part":sys.argv[2],"gone":sys.argv[3]=="true"},separators=(",",":")))' "$site" "$part" "$gone"
  if [ "$gone" != true ]; then DIFF=1; fi
}

event_cnm() {
  local site=$1 part=$2
  python3 -I -c 'import json,sys; print("@event gone " + json.dumps({"site":sys.argv[1],"part":sys.argv[2],"result":"could-not-measure"},separators=(",",":")))' "$site" "$part"
  CNM=1
}

add_site() {
  local kind=$1 name=$2 host=$3
  shift 3
  local out rc
  out=$(mktemp "$WORK/add.XXXX")
  set +e
  WP_HOSTNAME="$host" node "$CLI" add --kind "$kind" "$name" "$@" >"$out" 2>"$WORK/add.err"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    echo "site add $name failed (exit $rc)" >&2
    cat "$WORK/add.err" >&2
    rm -f "$out"
    return 1
  fi
  local got
  got=$(python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("hostname",""))' "$out")
  rm -f "$out"
  if [ "$got" != "$host" ]; then
    echo "site add $name reported hostname ${got:-<empty>}, expected $host" >&2
    return 1
  fi
  echo "added $kind $name at $host"
}

update_site() {
  local name=$1 host=$2
  shift 2
  local rc
  set +e
  WP_HOSTNAME="$host" node "$CLI" update "$name" "$@"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    echo "site update $name failed (exit $rc)" >&2
    return 1
  fi
}

remove_site() {
  local name=$1 host=$2
  local rc
  set +e
  WP_HOSTNAME="$host" node "$CLI" remove "$name" --delete-data
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    echo "site remove $name failed (exit $rc)" >&2
    return 1
  fi
}

read_bindings() {
  local script=$1 dest=$2
  cf_get "$(base_script "$script")/bindings" bindings "$dest"
}

read_secrets() {
  local script=$1 dest=$2
  # Names only. GET .../scripts/{script}/secrets returns name and type, and this
  # script drops every field except the name before the file is written.
  cf_get "$(base_script "$script")/secrets" secrets "$dest"
}

# POST /_dbimport is the documented write into the PhpRuntime Durable Object
# (docs/approach-b.md, spikes/b2-wordpress/index.js). It needs the x-spike-token
# header. site add generates SPIKE_TOKEN and does not print it. The secrets API
# returns names only. This script does not invent another route.
# Kind a has no Durable Object (deploy/provision/cli.mjs). Its database is MySQL
# through Hyperdrive. POST /_sqlimport writes that MySQL, not object storage.
record_data_gap() {
  python3 -I - "$1" "$2" "$3" <<'PY'
import json, sys
site, kind, route = sys.argv[1:]
why = {
  "wp": "POST /_dbimport writes the PhpRuntime Durable Object, and it needs the SPIKE_TOKEN secret. site add does not print that secret, and the secrets API returns names only.",
  "a": "kind a has no Durable Object. PHP runs in the Worker. The database is MySQL through Hyperdrive.",
}[kind]
obj = {"site": site, "kind": kind, "result": "could-not-measure", "why": why}
if route:
    obj["route"] = route
print("@event data " + json.dumps(obj, separators=(",", ":")))
PY
  CNM=1
}

check_pair_after() {
  local site=$1 script=$2
  local before_b="$WORK/$site-b-before.json" after_b="$WORK/$site-b-after.json"
  local before_s="$WORK/$site-s-before.json" after_s="$WORK/$site-s-after.json"
  if [ -f "$before_b" ] && read_bindings "$script" "$after_b"; then
    run_py compare-bindings "$site" "$before_b" "$after_b"
  else
    CNM=1
    echo "@event binding {\"site\":\"$site\",\"name\":\"*\",\"result\":\"could-not-measure\"}"
  fi
  if [ -f "$before_s" ] && read_secrets "$script" "$after_s"; then
    run_py compare-secrets "$site" "$before_s" "$after_s"
  else
    CNM=1
    echo "@event secret {\"site\":\"$site\",\"name\":\"*\",\"result\":\"could-not-measure\"}"
  fi
}

check_placement() {
  local site=$1 script=$2
  local f="$WORK/$site-placement.json"
  if ! cf_get "$(base_script "$script")/settings" placement "$f"; then
    CNM=1
    echo "@event placement {\"site\":\"$site\",\"result\":\"could-not-measure\"}"
    return
  fi
  local rc
  set +e
  python3 -I - "$f" "$site" "$PF_PLACEMENT" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
site, want = sys.argv[2], sys.argv[3]
pl = d.get("placement") or {}
region = pl.get("region")
# GET .../settings has answered placement {} while the worker was placed
# (deploy/provision/ops.mjs, #1063). An empty region is not a measured difference.
if not d.get("ok") or not region:
    print("@event placement " + json.dumps({"site": site, "result": "could-not-measure"}, separators=(",", ":")))
    sys.exit(2)
same = region == want and pl.get("mode", "targeted") == "targeted"
print("@event placement " + json.dumps({"site": site, "region": region, "same": same}, separators=(",", ":")))
sys.exit(0 if same else 1)
PY
  rc=$?
  set -e
  mark_py "$rc"
}

readback_gone() {
  local site=$1 name=$2 host=$3 script=$4 hid=$5
  local f rc
  f="$WORK/gone.json"
  if cf_get "$(base_script "$script")" script "$f"; then
    if python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("ok") and d.get("present") is False else 1)' "$f"; then
      event_gone "$site" "script" true
    else
      if python3 -I -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("ok") else 1)' "$f"; then
        event_gone "$site" "script" false
      else
        event_cnm "$site" "script"
      fi
    fi
  else
    event_cnm "$site" "script"
  fi
  local kvurl
  kvurl="$API/accounts/$ACCT/storage/kv/namespaces/$WFP_KV_ID/values/$(python3 -I -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$host")"
  if cf_get "$kvurl" kv "$f"; then
    if python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("ok") and d.get("present") is False else 1)' "$f"; then
      event_gone "$site" "registry entry" true
    else
      if python3 -I -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("ok") else 1)' "$f"; then
        event_gone "$site" "registry entry" false
      else
        event_cnm "$site" "registry entry"
      fi
    fi
  else
    event_cnm "$site" "registry entry"
  fi
  if cf_get "$API/accounts/$ACCT/r2/buckets/wp-wfp-$name-media" status "$f"; then
    if python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("ok") and d.get("present") is False else (2 if not d.get("ok") else 1))' "$f"; then
      event_gone "$site" "media bucket" true
    else
      rc=$?
      if [ "$rc" -eq 2 ]; then event_cnm "$site" "media bucket"; else event_gone "$site" "media bucket" false; fi
    fi
  else
    event_cnm "$site" "media bucket"
  fi
  if cf_get "$API/accounts/$ACCT/vectorize/v2/indexes/wp-wfp-$name-search" status "$f"; then
    if python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("ok") and d.get("present") is False else (2 if not d.get("ok") else 1))' "$f"; then
      event_gone "$site" "search index" true
    else
      rc=$?
      if [ "$rc" -eq 2 ]; then event_cnm "$site" "search index"; else event_gone "$site" "search index" false; fi
    fi
  else
    event_cnm "$site" "search index"
  fi
  set +e
  list_absent "$API/accounts/$ACCT/storage/kv/namespaces?per_page=100" title "wp-wfp-$name-oc"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then event_gone "$site" "object cache" true
  elif [ "$rc" -eq 1 ]; then event_gone "$site" "object cache" false
  else event_cnm "$site" "object cache"; fi
  set +e
  list_absent "$API/accounts/$ACCT/queues?per_page=100" queue_name "wp-wfp-$name-email"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then event_gone "$site" "email queue" true
  elif [ "$rc" -eq 1 ]; then event_gone "$site" "email queue" false
  else event_cnm "$site" "email queue"; fi
  set +e
  list_absent "$API/accounts/$ACCT/queues?per_page=100" queue_name "wp-wfp-$name-email-dlq"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then event_gone "$site" "email dlq" true
  elif [ "$rc" -eq 1 ]; then event_gone "$site" "email dlq" false
  else event_cnm "$site" "email dlq"; fi
  local dnsurl
  dnsurl="$API/zones/$WFP_SAAS_ZONE_ID/dns_records?type=AAAA&name=$(python3 -I -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$host")&per_page=100"
  if cf_get "$dnsurl" dns "$f"; then
    if python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("ok") and d.get("count")==0 else (2 if not d.get("ok") else 1))' "$f"; then
      event_gone "$site" "dns record" true
    else
      rc=$?
      if [ "$rc" -eq 2 ]; then event_cnm "$site" "dns record"; else event_gone "$site" "dns record" false; fi
    fi
  else
    event_cnm "$site" "dns record"
  fi
  if [ "$hid" = cnm ]; then
    event_cnm "$site" "custom hostname"
  elif [ -n "$hid" ]; then
    if cf_get "$API/zones/$WFP_SAAS_ZONE_ID/custom_hostnames/$hid" status "$f"; then
      if python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("ok") and d.get("present") is False else (2 if not d.get("ok") else 1))' "$f"; then
        event_gone "$site" "custom hostname" true
      else
        rc=$?
        if [ "$rc" -eq 2 ]; then event_cnm "$site" "custom hostname"; else event_gone "$site" "custom hostname" false; fi
      fi
    else
      event_cnm "$site" "custom hostname"
    fi
  else
    event_gone "$site" "custom hostname" true
  fi
}

hostname_id_of() {
  local host=$1
  local f="$WORK/entry.json"
  local url
  url="$API/accounts/$ACCT/storage/kv/namespaces/$WFP_KV_ID/values/$(python3 -I -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$host")"
  if ! cf_get "$url" kv "$f"; then
    return 2
  fi
  python3 -I -c 'import json,sys
d=json.load(open(sys.argv[1]))
if not d.get("ok"):
    sys.exit(2)
hid=d.get("customHostnameId") or ""
if hid and not hid.isalnum():
    sys.exit(2)
print(hid)' "$f"
}

echo "namespace $WFP_NAMESPACE"
echo "sites $WP_NAME (wp) and $A_NAME (a, placement $PF_PLACEMENT)"

if add_site wp "$WP_NAME" "$WP_HOST"; then ADDED_WP=1; else DIFF=1; fi
if add_site a "$A_NAME" "$A_HOST" --hyperdrive "$PF_HYPERDRIVE_ID" --placement "$PF_PLACEMENT"; then ADDED_A=1; else DIFF=1; fi

if [ "$DIFF" -ne 0 ]; then
  echo "add failed; tearing down and stopping" >&2
  if [ "$ADDED_WP" = 1 ] && remove_site "$WP_NAME" "$WP_HOST"; then REMOVED_WP=1; fi
  if [ "$ADDED_A" = 1 ] && remove_site "$A_NAME" "$A_HOST"; then REMOVED_A=1; fi
  exit 1
fi

record_data_gap "$WP_NAME" wp "POST /_dbimport"
record_data_gap "$A_NAME" a ""

WP_SCRIPT="site-$WP_NAME"
A_SCRIPT="site-$A_NAME"

read_bindings "$WP_SCRIPT" "$WORK/$WP_NAME-b-before.json" || true
read_secrets "$WP_SCRIPT" "$WORK/$WP_NAME-s-before.json" || true
read_bindings "$A_SCRIPT" "$WORK/$A_NAME-b-before.json" || true
read_secrets "$A_SCRIPT" "$WORK/$A_NAME-s-before.json" || true

if ! update_site "$WP_NAME" "$WP_HOST"; then DIFF=1; fi
if ! update_site "$A_NAME" "$A_HOST" --placement "$PF_PLACEMENT"; then DIFF=1; fi

check_pair_after "$WP_NAME" "$WP_SCRIPT"
check_pair_after "$A_NAME" "$A_SCRIPT"
check_placement "$A_NAME" "$A_SCRIPT"

WP_HID=$(hostname_id_of "$WP_HOST") || WP_HID=cnm
A_HID=$(hostname_id_of "$A_HOST") || A_HID=cnm

if remove_site "$WP_NAME" "$WP_HOST"; then REMOVED_WP=1; else DIFF=1; fi
if remove_site "$A_NAME" "$A_HOST"; then REMOVED_A=1; else DIFF=1; fi

readback_gone "$WP_NAME" "$WP_NAME" "$WP_HOST" "$WP_SCRIPT" "$WP_HID"
readback_gone "$A_NAME" "$A_NAME" "$A_HOST" "$A_SCRIPT" "$A_HID"

if [ "$DIFF" -ne 0 ]; then exit 1; fi
if [ "$CNM" -ne 0 ]; then exit 2; fi
exit 0
