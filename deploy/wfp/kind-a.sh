# shellcheck shell=bash
# deploy/wfp kind a (#1319): an approach A site in the dispatch namespace. PHP runs in the site's user Worker and
# the data is the owner's MySQL, reached through a Hyperdrive config made for this one site. Sourced by lib.sh.
#
# What a kind a site adds to a b-dosql site's parts (site add makes them, site remove reads each back gone):
#   the Hyperdrive config wp-wfp-<name>   query caching OFF; made through the API (hd_create), never Terraform,
#                                         so the database password goes to Hyperdrive and is in no state file
#   the KV namespace wp-wfp-<name>-oc     the object cache (#666), in the site workspace (terraform/site)
# The database itself is the owner's: deploy/wfp never makes, changes or drops it.
#
# Measured on #1310 (2026-11-22), the facts this rests on:
#   - a Hyperdrive binding on a namespace user Worker binds and answers at a plain Worker's cost: 9 ms a query
#     placed in SEA, against a westus2 database;
#   - [placement] region is accepted on a namespace upload and reads back {"mode": "targeted"}, though Cloudflare
#     documents only mode smart for user Worker uploads;
#   - the namespace's outbound Worker passes Hyperdrive and refuses a raw connect(), so the site must reach MySQL
#     only through Hyperdrive (it does: index-a-lean.js connects with the binding's own details);
#   - a Cron Trigger on a namespace script never fires, so the render has no [triggers] (render-conf.sh RENDER_WFP)
#     and the cron object re-arms itself with Durable Object alarms, which do fire there.

# kind_check: KIND is unset, b-dosql or a. Prints the kind.
kind_check() {
  case "${KIND:-b-dosql}" in
    b-dosql|a) printf '%s\n' "${KIND:-b-dosql}" ;;
    *) echo "KIND must be b-dosql or a, not ${KIND}" >&2; return 2 ;;
  esac
}
hd_name() { echo "wp-wfp-$1"; }
oc_kv_title() { echo "wp-wfp-$1-oc"; }

# The account's Hyperdrive limit: 25 configs on Workers Paid, 10 on Free (Hyperdrive limits page, read 2026-11-22).
# One per kind a site, so the account holds about that many approach A sites, minus the configs it has already.
HYPERDRIVE_CONFIG_LIMIT=${HYPERDRIVE_CONFIG_LIMIT:-25}

# hd_configs: the account's Hyperdrive configs, one "<id> <name>" line each, from EVERY page (#1323: the list pages,
# 20 by default; one page counted at most 20, under the 25 limit). Exit 1 when any page cannot be read: a page that
# is not read is never counted as empty.
hd_configs() {
  local page=1 pages=1 out code body
  while [ "$page" -le "$pages" ]; do
    out=$(api GET "/hyperdrive/configs?per_page=100&page=$page") || return 1
    code=${out##*$'\n'}
    [ "$code" = 200 ] || { echo "the Hyperdrive config list cannot be read (page $page, HTTP $code)" >&2; return 1; }
    # "C <id> <name>" per config, then "P <total pages>". Anything else is an unread page.
    body=$(printf '%s' "${out%$'\n'*}" | python3 -I -c 'import json, sys
d = json.load(sys.stdin); r = d.get("result"); t = (d.get("result_info") or {}).get("total_pages", 1)
if d.get("success") is not True or not isinstance(r, list) or not isinstance(t, int) or not 1 <= t <= 100: sys.exit(1)
for c in r: print("C", c.get("id", ""), c.get("name", ""))
print("P", t)') || { echo "the Hyperdrive config list cannot be read (page $page)" >&2; return 1; }
    printf '%s\n' "$body" | sed -n 's/^C //p'
    pages=$(printf '%s\n' "$body" | sed -n 's/^P //p')
    page=$((page + 1))
  done
}
# hd_find <site>: the id of the site's config (by its name), or nothing. Exit 1 when the list cannot be read.
hd_find() {
  local l; l=$(hd_configs) || return 1
  printf '%s\n' "$l" | awk -v n="$(hd_name "$1")" '$2 == n { print $1 }' | head -1
}
# hd_state <site>: yes, no or unknown, for site_footprint.
hd_state() {
  local id; id=$(hd_find "$1" 2>/dev/null) || { echo unknown; return 0; }
  if [ -n "$id" ]; then echo yes; else echo no; fi
}
# oc_kv_state <site>: yes, no or unknown: the KV namespace wp-wfp-<site>-oc, by its title.
oc_kv_state() {
  local page=1 out code n
  while [ "$page" -le 50 ]; do
    out=$(api GET "/storage/kv/namespaces?per_page=100&page=$page") || { echo unknown; return 0; }
    code=${out##*$'\n'}; [ "$code" = 200 ] || { echo unknown; return 0; }
    n=$(printf '%s' "${out%$'\n'*}" | python3 -I -c 'import json, sys
d = json.load(sys.stdin); r = d.get("result")
if d.get("success") is not True or not isinstance(r, list): print("bad"); sys.exit(0)
print("yes" if any(isinstance(x, dict) and x.get("title") == sys.argv[1] for x in r) else ("end" if len(r) < 100 else "more"))' "$(oc_kv_title "$1")")
    case "$n" in yes) echo yes; return 0 ;; end) echo no; return 0 ;; more) page=$((page + 1)) ;; *) echo unknown; return 0 ;; esac
  done
  echo unknown
}

# a_inputs_check: the inputs of a kind a site add, before any step. The database is named by MYSQL_HOST,
# MYSQL_PORT (3306), MYSQL_DATABASE and MYSQL_USER; MYSQL_PASSWORD goes to Hyperdrive only. PLACEMENT is required
# (render-conf.sh placement_check, the same rule as deploy.sh): the Worker runs next to the database (#1054).
a_inputs_check() {
  local v
  # #1364: before the database checks, so a bad bound stops the add before any step.
  ( . "$WFP/../db-query-timeout.sh" && db_query_timeout_check ) || return 2
  for v in MYSQL_HOST MYSQL_DATABASE MYSQL_USER MYSQL_PASSWORD; do
    [ -n "${!v:-}" ] || { echo "KIND=a needs $v (the owner's MySQL database)" >&2; return 2; }
  done
  [[ "$MYSQL_HOST" =~ ^[A-Za-z0-9.-]{1,253}$ ]] || { echo "MYSQL_HOST must be a host name" >&2; return 2; }
  [[ "${MYSQL_PORT:-3306}" =~ ^[0-9]{1,5}$ ]] || { echo "MYSQL_PORT must be a port number" >&2; return 2; }
  [[ "$MYSQL_DATABASE" =~ ^[A-Za-z0-9_$-]{1,64}$ ]] || { echo "MYSQL_DATABASE must be a database name" >&2; return 2; }
  [[ "$MYSQL_USER" =~ ^[A-Za-z0-9_.@-]{1,80}$ ]] || { echo "MYSQL_USER must be a user name" >&2; return 2; }
  [ -n "${PLACEMENT:-}" ] || { echo "KIND=a needs PLACEMENT, the database region (for example azure:westus2), so the site runs next to it (#1054)" >&2; return 2; }
  ( . "$WFP/../render-conf.sh" >/dev/null 2>&1; placement_check ) || return 2
  # ALLOW_KIND_A_CUSTOM_DOMAIN=1: operator override for an apex Custom Domain on kind a
  # (ggc.sh Type A cutover, #1471). Default remains refuse.
  [ "${WFP_CUSTOM_DOMAIN:-0}" != 1 ] || [ "${ALLOW_KIND_A_CUSTOM_DOMAIN:-0}" = 1 ] || { echo "KIND=a runs on phase A (workers.dev) only for now: WFP_CUSTOM_DOMAIN=1 is refused (#1319); the operator override is ALLOW_KIND_A_CUSTOM_DOMAIN=1 (#1471)" >&2; return 2; }
  return 0
}
# hd_limit_check: refuse before any step when the account has no Hyperdrive config left for one more site.
hd_limit_check() {
  local l n; l=$(hd_configs) || return 2
  n=$(printf '%s\n' "$l" | grep -c . || true)
  if [ "$n" -ge "$HYPERDRIVE_CONFIG_LIMIT" ]; then
    echo "the account has $n Hyperdrive configs, its limit is $HYPERDRIVE_CONFIG_LIMIT (Workers Paid; HYPERDRIVE_CONFIG_LIMIT): no config is left for this site. Nothing was changed." >&2
    return 2
  fi
  echo "  Hyperdrive configs: $n of $HYPERDRIVE_CONFIG_LIMIT used; this site takes one"
}
# hd_create <site>: make the site's config, query caching off, then read it back. Prints the id.
# The body (with the password) goes to curl on stdin; the token in its mode-600 config. Neither is in argv.
hd_create() {
  local s=$1 out code id
  out=$(python3 -I -c 'import json, os, sys
print(json.dumps({"name": sys.argv[1], "caching": {"disabled": True}, "origin": {"scheme": "mysql",
  "host": os.environ["MYSQL_HOST"], "port": int(os.environ.get("MYSQL_PORT") or 3306), "database": os.environ["MYSQL_DATABASE"],
  "user": os.environ["MYSQL_USER"], "password": os.environ["MYSQL_PASSWORD"]}}))' "$(hd_name "$s")" \
    | api POST "/hyperdrive/configs" -H "Content-Type: application/json" --data-binary @-) || return 1
  code=${out##*$'\n'}
  id=$(printf '%s' "${out%$'\n'*}" | python3 -I -c 'import json, re, sys
try: d = json.load(sys.stdin)
except ValueError: sys.exit(1)
i = (d.get("result") or {}).get("id", "") if d.get("success") is True else ""
if not re.fullmatch(r"[0-9a-f]{32}", i or ""):
    print("; ".join(str(e.get("code")) + " " + str(e.get("message", ""))[:160] for e in d.get("errors") or []), file=sys.stderr); sys.exit(1)
print(i)') || { echo "site $s: the Hyperdrive config was NOT made (HTTP $code; the database refused the login, or the token has no Hyperdrive Edit)" >&2; return 1; }
  hd_readback "$s" "$id" || return 1
  printf '%s\n' "$id"
}
# hd_readback <site> <id>: the config is there, under the site's name, MySQL, with caching off.
hd_readback() {
  local out code
  out=$(api GET "/hyperdrive/configs/$2") || return 1
  code=${out##*$'\n'}
  [ "$code" = 200 ] || { echo "site $1: Hyperdrive config $2 does not read back (HTTP $code)" >&2; return 1; }
  printf '%s' "${out%$'\n'*}" | python3 -I -c 'import json, sys
r = json.load(sys.stdin).get("result") or {}
ok = r.get("name") == sys.argv[1] and (r.get("origin") or {}).get("scheme") == "mysql" and (r.get("caching") or {}).get("disabled") is True
sys.exit(0 if ok else 1)' "$(hd_name "$1")" || { echo "site $1: Hyperdrive config $2 reads back with another name, scheme or caching on" >&2; return 1; }
  echo "  Hyperdrive config $(hd_name "$1") ($2): MySQL, query caching off (read back)" >&2
}
# hd_delete <site>: delete the site's config (found by name, so a config left by a failed add goes too), then
# read it back 404. Nothing to delete is fine.
hd_delete() {
  local s=$1 id code
  id=$(hd_find "$s") || { echo "  the Hyperdrive config list cannot be read: stopping" >&2; return 1; }
  [ -n "$id" ] || { echo "  Hyperdrive config $(hd_name "$s"): none"; return 0; }
  code=$(api_code DELETE "/hyperdrive/configs/$id")
  case "$code" in 200|404) ;; *) echo "  Hyperdrive config $(hd_name "$s") ($id): the delete answered HTTP $code: stopping" >&2; return 1 ;; esac
  gone "Hyperdrive config $(hd_name "$s") ($id)" "/hyperdrive/configs/$id"
}

# kind_a_refuse <site>: after site_vars. update, restore and schedule are b-dosql's: they snapshot, load or
# restore the object's own SQLite, or arm its snapshot cron. A kind a site's data is the owner's MySQL, so each is
# refused before any step. site import is allowed for kind a: it runs deploy/import.sh with VARIANT=a (Hyperdrive
# /_sqlimport), not the SQLite path. site update for kind a (a rebuild and re-upload, no data step) is #1319's follow-up.
kind_a_refuse() {
  [ "${REC_KIND:-b-dosql}" = a ] || return 0
  echo "site $1 is kind a (approach A, the owner's MySQL): this command works on a b-dosql site's own database and is refused. Nothing was changed." >&2
  return 2
}
