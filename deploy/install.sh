# shellcheck shell=bash
# WordPress install and WooCommerce activation for deploy/deploy.sh and deploy/wfp/site.sh (#811, #759).
#
# The new Worker version reaches the site before the PHP Durable Object. An object still on
# the previous version refuses the spike token with 403 (measured 2026-11-16 on pf755e, about
# 60 s). One POST, then a note when the body is not JSON, used to exit 0, so a fresh site
# could ship uninstalled.
#
# install_wordpress <url>
# POST <url>/_install until the body is the envelope from spikes/b2-wordpress/index.js:
# JSON whose "out" is JSON with installed true or installed "already".
# Retry while the answer is 403, 5xx, no answer, or not JSON, for INSTALL_WAIT_S seconds
# (default 120, at most 600). INSTALL_INTERVAL_S (default 5, at most 60) is the pause.
# A JSON answer that does not say installed fails at once.
# On failure, print the last status and the body's first bytes. When the retries run out,
# and CLOUDFLARE_API_TOKEN, ACCOUNT_ID and NAME are set, also name the Worker's current
# deployment from the Cloudflare API (the script name, the deployment id and the version
# ids). That read uses the token deploy.sh already holds. The public 403 is not a source
# for a version. Never print the spike token, the admin password or the API token. They
# reach curl through -K and a process substitution, as before, never as -H on the command line.
# Returns 0 when installed, 1 when not.

# The latest deployment that is serving traffic. The API lists that deployment first
# (List Worker Deployments, read 2026-11-16). Writes $1/note, or leaves it empty.
# Names and ids only. A miss prints a status code and no body.
install_deployment_note() {
  local work=$1
  local token acct name api code port proto
  : > "$work/note"
  token=${CLOUDFLARE_API_TOKEN:-}
  acct=${ACCOUNT_ID:-}
  name=${NAME:-}
  [ -n "$token" ] && [ -n "$acct" ] && [ -n "$name" ] || return 0
  [[ "$acct" =~ ^[0-9a-fA-F]{32}$ ]] || return 0
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$ ]] || return 0
  api=${CF_API:-https://api.cloudflare.com/client/v4}
  proto=https
  case "$api" in
    https://api.cloudflare.com/client/v4) ;;
    http://127.0.0.1:*|http://localhost:*)
      [[ "$api" =~ ^http://(127\.0\.0\.1|localhost):[0-9]{1,5}$ ]] || return 0
      port=${api##*:}
      port=$((10#$port))
      [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || return 0
      proto=http
      ;;
    *) return 0 ;;
  esac
  : > "$work/cf.json"
  code=$(curl -s --proto "=$proto" --connect-timeout 10 -m 20 -o "$work/cf.json" -w '%{http_code}' \
    -K <(printf 'header = "Authorization: Bearer %s"\n' "$token") \
    "$api/accounts/$acct/workers/scripts/$name/deployments") || code=000
  [[ "$code" =~ ^[0-9]{3}$ ]] || code=000
  if [ "$code" != 200 ]; then
    echo "install: Worker deployment was not read (HTTP $code)" >&2
    return 0
  fi
  python3 -I "$work/note.py" "$work/cf.json" "$name" "$work/note" || true
  if ! [ -s "$work/note" ]; then
    echo "install: Worker deployment was not read (no deployment id)" >&2
  fi
}

install_wordpress() {
  local url=$1
  local wait_s interval_s curl_max
  wait_s=${INSTALL_WAIT_S:-120}
  interval_s=${INSTALL_INTERVAL_S:-5}
  curl_max=${INSTALL_CURL_MAX_S:-300}
  [[ "$wait_s" =~ ^[0-9]+$ ]] || { echo "INSTALL_WAIT_S must be a number of seconds, not ${wait_s}" >&2; return 1; }
  [[ "$interval_s" =~ ^[0-9]+$ ]] || { echo "INSTALL_INTERVAL_S must be a number of seconds, not ${interval_s}" >&2; return 1; }
  [[ "$curl_max" =~ ^[0-9]+$ ]] || { echo "INSTALL_CURL_MAX_S must be a number of seconds, not ${curl_max}" >&2; return 1; }
  wait_s=$((10#$wait_s))
  interval_s=$((10#$interval_s))
  curl_max=$((10#$curl_max))
  [ "$wait_s" -le 600 ] || { echo "INSTALL_WAIT_S must be at most 600 seconds, not ${wait_s}" >&2; return 1; }
  [ "$interval_s" -le 60 ] || { echo "INSTALL_INTERVAL_S must be at most 60 seconds, not ${interval_s}" >&2; return 1; }
  [ "$curl_max" -ge 1 ] && [ "$curl_max" -le 300 ] || { echo "INSTALL_CURL_MAX_S must be from 1 to 300 seconds, not ${curl_max}" >&2; return 1; }
  [ -n "${SPIKE_TOKEN:-}" ] || { echo "install: SPIKE_TOKEN is empty" >&2; return 1; }
  [ -n "${ADMIN_PASSWORD:-}" ] || { echo "install: ADMIN_PASSWORD is empty" >&2; return 1; }

  local dir start now elapsed remain sleep_for attempt status rc shown
  dir=$(mktemp -d "${TMPDIR:-/tmp}/pf-install.XXXXXX")
  # The checker redacts these. A builtin write, mode 600, so they are not in argv or the environment.
  (umask 077
    printf '%s\n' "$SPIKE_TOKEN" > "$dir/token"
    printf '%s\n' "$ADMIN_PASSWORD" > "$dir/password"
    printf '%s\n' "${CLOUDFLARE_API_TOKEN:-}" > "$dir/api-token")
  : > "$dir/note"
  cat > "$dir/note.py" <<'PY'
import json, re, sys
json_path, name, note_path = sys.argv[1:4]
uuid_re = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
name_re = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$")
line = ""
try:
    if name_re.fullmatch(name or ""):
        d = json.loads(open(json_path, "rb").read().decode("utf-8"))
        result = d.get("result") if isinstance(d, dict) else None
        deps = result.get("deployments") if isinstance(result, dict) else None
        if isinstance(d, dict) and d.get("success") is True and isinstance(deps, list) and deps:
            dep = deps[0]
            dep_id = dep.get("id") if isinstance(dep, dict) else None
            if isinstance(dep_id, str) and uuid_re.fullmatch(dep_id):
                vids = []
                versions = dep.get("versions") if isinstance(dep, dict) else None
                if isinstance(versions, list):
                    for item in versions:
                        vid = item.get("version_id") if isinstance(item, dict) else None
                        if isinstance(vid, str) and uuid_re.fullmatch(vid):
                            vids.append(vid.lower())
                        if len(vids) >= 20:
                            break
                line = "worker %s deployment %s" % (name, dep_id.lower())
                if vids:
                    line = line + " version " + ",".join(vids)
except (OSError, ValueError, UnicodeError, AttributeError):
    line = ""
try:
    open(note_path, "w").write(line)
except OSError:
    pass
PY
  cat > "$dir/check.py" <<'PY'
import json, re, sys
body_path, status, mode, elapsed, token_path, password_path, note_path, api_token_path = sys.argv[1:9]

def read_secret(path):
    try:
        s = open(path, "r").read()
    except OSError:
        return ""
    if s.endswith("\n"):
        s = s[:-1]
    return s

token = read_secret(token_path)
password = read_secret(password_path)
api_token = read_secret(api_token_path)
try:
    raw = open(body_path, "rb").read()
except OSError:
    raw = b""

def redact(s):
    for secret in (token, password, api_token):
        if secret and secret in s:
            s = s.replace(secret, "[redacted]")
    return s

def show_status(st):
    if st in ("000", "", "none"):
        return "none"
    return st

def body_prefix(buf):
    text = buf.decode("utf-8", "replace")
    text = "".join(ch if ch.isprintable() else " " for ch in text).strip()
    if not text:
        return "(empty)"
    return redact(text[:120])

# The note is the script name plus deployment and version ids. Anything else is dropped.
NOTE_RE = re.compile(
    r"^worker [A-Za-z0-9][A-Za-z0-9_-]{0,62} deployment "
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    r"( version [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    r"(,[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*)?$")

def deployment_clause(path):
    try:
        note = open(path, "r").read().strip()
    except OSError:
        return ""
    note = redact(note)
    if not NOTE_RE.fullmatch(note or ""):
        return ""
    return "; " + note

def inner_installed(buf):
    # None: the HTTP body is not JSON. False: JSON, but not installed.
    # A dict: the index.js envelope whose out says installed true or "already".
    try:
        d = json.loads(buf.decode("utf-8"))
    except (ValueError, UnicodeError):
        return None
    if not isinstance(d, dict):
        return False
    out = d.get("out")
    if not isinstance(out, str):
        return False
    try:
        inner = json.loads(out)
    except ValueError:
        return False
    if not isinstance(inner, dict):
        return False
    inst = inner.get("installed")
    if inst is True or inst == "already":
        return d
    return False

def retryable(st, parsed):
    if st in ("000", "", "none"):
        return True
    try:
        code = int(st)
    except ValueError:
        return True
    if code == 403 or 500 <= code <= 599:
        return True
    if parsed is None:
        return True
    return False

def fail(st, when):
    if when == "after":
        head = "install failed after %ss: " % elapsed
    else:
        head = "install failed: "
    sys.stderr.write(head + "last status %s; body: %s%s\n" % (
        show_status(st), body_prefix(raw), deployment_clause(note_path)))

if mode == "report-after":
    fail(status, "after")
    sys.exit(11)
if mode == "report-now":
    fail(status, "now")
    sys.exit(11)
parsed = inner_installed(raw)
if isinstance(parsed, dict) and not retryable(status, parsed):
    out = parsed.get("out") or ""
    sys.stdout.write(redact("%s %s ms\n" % (out[-80:], parsed.get("ms"))))
    sys.exit(0)
if retryable(status, parsed):
    sys.exit(10)
sys.exit(11)
PY
  start=$(date +%s)
  attempt=0
  status=none
  while true; do
    now=$(date +%s)
    elapsed=$((now - start))
    # The first try always runs. Later tries stop once the bound is reached. curl's own
    # cap stays INSTALL_CURL_MAX_S, so an install that is already running can finish.
    if [ "$attempt" -gt 0 ] && [ "$elapsed" -ge "$wait_s" ]; then
      break
    fi
    attempt=$((attempt + 1))
    : > "$dir/body"
    status=$(curl -s -S --connect-timeout 10 -m "$curl_max" -o "$dir/body" -w '%{http_code}' -X POST \
      -K <(printf 'header = "x-spike-token: %s"\nheader = "x-admin-password: %s"\n' "$SPIKE_TOKEN" "$ADMIN_PASSWORD") \
      "$url/_install") || status=000
    rc=0
    python3 -I "$dir/check.py" "$dir/body" "$status" check "$elapsed" "$dir/token" "$dir/password" "$dir/note" "$dir/api-token" || rc=$?
    if [ "$rc" -eq 0 ]; then rm -rf "$dir"; return 0; fi
    if [ "$rc" -eq 11 ]; then
      # JSON that is not installed. One report, with no deployment read: the answer was the new code.
      python3 -I "$dir/check.py" "$dir/body" "$status" report-now "$elapsed" "$dir/token" "$dir/password" "$dir/note" "$dir/api-token" || true
      rm -rf "$dir"
      return 1
    fi
    if [ "$rc" -ne 10 ]; then
      echo "install: could not read the answer (checker status $rc)" >&2
      rm -rf "$dir"
      return 1
    fi
    now=$(date +%s)
    elapsed=$((now - start))
    remain=$((wait_s - elapsed))
    if [ "$remain" -le 0 ]; then
      break
    fi
    sleep_for=$interval_s
    if [ "$sleep_for" -gt "$remain" ]; then sleep_for=$remain; fi
    shown=$status
    [ "$shown" = 000 ] && shown=none
    echo "install: status $shown is not installed yet; retrying" >&2
    if [ "$sleep_for" -gt 0 ]; then sleep "$sleep_for"; fi
  done
  now=$(date +%s)
  elapsed=$((now - start))
  # Only after the retries run out. The 403's headers are not kept.
  install_deployment_note "$dir"
  python3 -I "$dir/check.py" "$dir/body" "$status" report-after "$elapsed" "$dir/token" "$dir/password" "$dir/note" "$dir/api-token" || true
  rm -rf "$dir"
  return 1
}

# activate_woocommerce <url>
# POST <url>/_activate?plugin=woocommerce/woocommerce.php until the answer says active
# AND installed (#661). Retry on a cold isolate memory reset (#198).
# SPIKE_TOKEN must be set. Returns 0 when active and installed, 1 when not.
activate_woocommerce() {
  local url=$1
  local act_n act_out act_ok act_tries curl_max
  act_tries=${ACT_TRIES:-4}
  curl_max=${ACTIVATE_CURL_MAX_S:-300}
  [[ "$act_tries" =~ ^[0-9]+$ ]] || { echo "ACT_TRIES must be a number, not ${act_tries}" >&2; return 1; }
  [[ "$curl_max" =~ ^[0-9]+$ ]] || { echo "ACTIVATE_CURL_MAX_S must be a number of seconds, not ${curl_max}" >&2; return 1; }
  act_tries=$((10#act_tries))
  curl_max=$((10#curl_max))
  [ "$act_tries" -ge 1 ] && [ "$act_tries" -le 20 ] || { echo "ACT_TRIES must be from 1 to 20, not ${act_tries}" >&2; return 1; }
  [ "$curl_max" -ge 1 ] && [ "$curl_max" -le 300 ] || { echo "ACTIVATE_CURL_MAX_S must be from 1 to 300 seconds, not ${curl_max}" >&2; return 1; }
  [ -n "${SPIKE_TOKEN:-}" ] || { echo "activate: SPIKE_TOKEN is empty" >&2; return 1; }
  act_ok=0
  for act_n in $(seq 1 "$act_tries"); do
    act_out=$(curl -s -m "$curl_max" -X POST -K <(printf 'header = "x-spike-token: %s"\n' "$SPIKE_TOKEN") "$url/_activate?plugin=woocommerce/woocommerce.php")
    printf '%s\n' "$act_out" >&2
    if grep -q '\\"active\\":true' <<<"$act_out" && grep -q '\\"installed\\":true' <<<"$act_out"; then
      act_ok=1
      break
    fi
    echo "WooCommerce activation attempt $act_n/$act_tries did not report active AND installed; retrying" >&2
    sleep "$((act_n * 3))"
  done
  [ "$act_ok" = 1 ] || {
    echo "WooCommerce did not activate AND install after $act_tries attempts (a result: record it)" >&2
    return 1
  }
  return 0
}
