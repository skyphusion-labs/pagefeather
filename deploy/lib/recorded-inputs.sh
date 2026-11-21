# shellcheck shell=bash
# #1108 part 3: a deploy.sh site records its inputs, as deploy/wfp records its own (#379, #558). Every apply writes this
# run's settings into the site's own Terraform state (variable and output deploy_inputs, base64 of JSON, so no HCL
# escaping). Before the next apply, inputs_check reads the record back and refuses a run whose inputs differ, printing
# each difference, unless REPLACE_INPUTS=1 (deploy/wfp's name for the same confirmation). A setting recorded last time
# and unset now is a difference: a rebuild never drops one silently (the #1108 data loss was MEDIA dropped this way).
# Secrets are never recorded: only the names below, none of which holds one. Test: deploy/tests/recorded-inputs-test.sh.
# #1285: a key in the record that this build does not know stops the deploy and names the key, unless
# REPLACE_INPUTS=1, which drops that key and names it. The check is deploy/lib/unknown_setting.py guard,
# the same function deploy/wfp uses. A known key stays a normal difference.
RECORDED_INPUTS="VARIANT LOCATION MEDIA WOO_ACTIVE SITE_ORIGIN PLACEMENT A_CLIENT A_CRON MYSQL MYSQL_HOST MYSQL_DATABASE MAIL_FROM MAIL_FROM_NAME MAIL_ALLOWED_TO OBSERVABILITY OPCACHE_A OPCACHE_REMOTE SITE_REMOTE RECYCLE_WASM_MIB PHP_OVERFLOW PHP_OVERFLOW_POOL PHP_OVERFLOW_DEPTH OBJECT_CACHE_L2 OBJECT_CACHE_VERSIONS WOO_HPOS_CACHE HTTP_ALLOW_HOSTS PDF_INVOICE REQUEST_FRAMES WOO_EXTRAS TURNSTILE_SITEKEY TURNSTILE_LOGIN TURNSTILE_LOSTPASSWORD TURNSTILE_WOO TURNSTILE_COMMENTS PLUGINS THEMES IMPORT_PLUGINS IMPORT_THEMES IMPORT_MU_PLUGINS SITE_TITLE CUSTOM_DOMAIN PHP_MEMORY_REUSE BOOT_GATE WP_CLI_ENDPOINT ACCESS_AUD ACCESS_TEAM"
RECORDED_INPUTS_LIB=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# deploy_inputs_value: this run's record, base64 of a JSON object of the names above that are SET (an empty value is
# set). Word lists (PLUGINS and the like) are kept as given.
deploy_inputs_value() {
  local n
  for n in $RECORDED_INPUTS; do [ "${!n+x}" = x ] && printf '%s\0%s\0' "$n" "${!n}"; done |
    python3 -I -c 'import base64, json, sys
p = sys.stdin.buffer.read().split(b"\0")[:-1]
d = {p[i].decode(): p[i + 1].decode() for i in range(0, len(p), 2)}
print(base64.b64encode(json.dumps(d, sort_keys=False).encode()).decode(), end="")'
}

# inputs_check <terraform dir> <site name>: return 0 when there is no record (a new site, or one deployed before
# #1108; it records now) or the record matches this run; 2, with each difference on stderr, otherwise. An unreadable
# record is a refusal, never a pass.
inputs_check() {
  local dir=$1 name=$2 rec cur err rc
  # No workspace: a new site, nothing recorded. Fail closed otherwise (the lead's review): only Terraform's "not found"
  # for the output (a site deployed before #1108) means no record; any other failure (a backend credential or state
  # error) refuses, so a broken read never passes as "nothing to compare".
  local wsl
  err=$(mktemp "${TMPDIR:-/tmp}/inputs-check.XXXXXX")
  # workspace list fails when the backend can not be reached (credentials, network): that is a refusal. Only a list
  # that succeeds and lacks the site's name means a new site.
  if ! wsl=$(cd "$dir" && terraform workspace list -no-color 2> "$err"); then
    echo "refused: site $name's recorded inputs could not be read (terraform workspace list failed: $(tr '\n' ' ' < "$err" | cut -c1-200)). Nothing was changed. (#1108)" >&2
    rm -f "$err"; return 2
  fi
  if ! printf '%s\n' "$wsl" | sed 's/^[* ]*//' | grep -qx "$name"; then
    rm -f "$err"; echo "site $name: no recorded inputs (a new site); this run records them" >&2; return 0
  fi
  if ! (cd "$dir" && terraform workspace select "$name" >/dev/null 2> "$err"); then
    echo "refused: site $name's workspace could not be selected ($(tr '\n' ' ' < "$err" | cut -c1-200)). Nothing was changed. (#1108)" >&2
    rm -f "$err"; return 2
  fi
  rec=$(cd "$dir" && terraform output -no-color -raw deploy_inputs 2> "$err"); rc=$?
  if [ "$rc" != 0 ]; then
    if grep -qE 'Output "deploy_inputs" not found|No outputs found' "$err"; then
      rm -f "$err"; echo "site $name: no recorded inputs (deployed before #1108); this run records them" >&2; return 0
    fi
    echo "refused: site $name's recorded inputs could not be read (terraform output failed: $(tr '\n' ' ' < "$err" | cut -c1-200)). Nothing was changed. (#1108)" >&2
    rm -f "$err"; return 2
  fi
  rm -f "$err"
  if [ -z "$rec" ]; then
    echo "site $name: no recorded inputs (an empty record); this run records them" >&2
    return 0
  fi
  cur=$(deploy_inputs_value)
  REC="$rec" CUR="$cur" REPLACE="${REPLACE_INPUTS:-0}" ORIGIN_MOVE="${ORIGIN_MOVE:-0}" NAME="$name" LIB="$RECORDED_INPUTS_LIB" KNOWN="$RECORDED_INPUTS" python3 -I -c '
import base64, io, json, os, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.environ["LIB"])
import unknown_setting
try:
    rec = json.loads(base64.b64decode(os.environ["REC"], validate=True))
    assert isinstance(rec, dict)
except Exception:
    print("refused: site %s has a recorded deploy_inputs that can not be read; nothing was changed (#1108)" % os.environ["NAME"], file=sys.stderr)
    sys.exit(2)
cur = json.loads(base64.b64decode(os.environ["CUR"]) or b"{}")
replace = os.environ["REPLACE"] == "1"
# #1285: hold the lines until this check exits 0. An origin refusal does not write
# the record, so it must not say an unknown key was dropped. A known key stays in
# rec for the difference check below.
held = io.StringIO()
code, unknown = unknown_setting.guard(list(rec), os.environ["KNOWN"].split(), replace, held)
if code:
    sys.stderr.write(held.getvalue())
    sys.exit(code)
for k in unknown:
    del rec[k]
diff = [(k, rec.get(k, ""), cur.get(k, "")) for k in list(dict.fromkeys(list(rec) + list(cur))) if rec.get(k) != cur.get(k)]
# #1262: the site ORIGIN (an explicit SITE_ORIGIN, else https://CUSTOM_DOMAIN, else the workers.dev default) never changes
# by REPLACE_INPUTS alone. WP_HOME follows SITE_ORIGIN at boot, but siteurl and every absolute URL in the content
# (uploads, links, menus) stay at the old origin in the database, and nothing here rewrites them. A move is asked for on
# purpose with ORIGIN_MOVE=1, and is then a job for the operator: siteurl, and a search-replace of the old origin.
def origin(d):
    if d.get("SITE_ORIGIN"):
        return d["SITE_ORIGIN"].lower()
    if d.get("CUSTOM_DOMAIN"):
        return "https://" + d["CUSTOM_DOMAIN"].lower()
    return "the workers.dev default"
o_rec, o_cur = origin(rec), origin(cur)
if o_rec != o_cur and os.environ.get("ORIGIN_MOVE", "0") != "1":
    print("refused: site %s would move from %s to %s. WordPress keeps siteurl and the absolute URLs in its content at the "
          "old origin, and the deploy never rewrites them. To move it on purpose, run with ORIGIN_MOVE=1 (and REPLACE_INPUTS=1), "
          "then set siteurl to the new origin and search-replace the old origin in the database. Nothing was changed. (#1262)"
          % (os.environ["NAME"], o_rec, o_cur), file=sys.stderr)
    sys.exit(2)
if not diff:
    sys.stderr.write(held.getvalue())
    sys.exit(0)
if o_rec != o_cur:
    print("ORIGIN_MOVE=1: site %s moves from %s to %s. Set siteurl and search-replace the old origin after this deploy; "
          "the deploy does not. (#1262)" % (os.environ["NAME"], o_rec, o_cur), file=sys.stderr)
print(("REPLACE_INPUTS=1: the recorded inputs are replaced:" if replace else
       "refused: this run'"'"'s inputs differ from the ones site %s recorded (REPLACE_INPUTS=1 replaces them on purpose):" % os.environ["NAME"]), file=sys.stderr)
for k, a, b in diff:
    print("  %s: recorded %r, this run %r" % (k, a, b), file=sys.stderr)
if not replace:
    print("  Nothing was changed. (#1108)", file=sys.stderr)
    sys.exit(2)
sys.stderr.write(held.getvalue())
sys.exit(0)
'
}
