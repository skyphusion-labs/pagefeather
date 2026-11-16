# shellcheck shell=bash
# WordPress install for deploy/deploy.sh (#811).
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
# On failure, print the last status, the body's first bytes, and the Worker version from the
# response header x-worker-version (the build that answered; "(none)" when it did not send one).
# Never print the spike token or the admin password. They reach curl through -K and a process
# substitution, as before, never as -H on the command line.
# Returns 0 when installed, 1 when not.

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
  (umask 077; printf '%s\n' "$SPIKE_TOKEN" > "$dir/token"; printf '%s\n' "$ADMIN_PASSWORD" > "$dir/password")
  cat > "$dir/check.py" <<'PY'
import json, re, sys
body_path, status, hdr_path, mode, elapsed, token_path, password_path = sys.argv[1:8]

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
try:
    raw = open(body_path, "rb").read()
except OSError:
    raw = b""

def redact(s):
    for secret in (token, password):
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

def worker_version(path):
    # Only a version token is printed. A header that carries a secret is dropped.
    try:
        text = open(path, "r", errors="replace").read()
    except OSError:
        return "(none)"
    val = ""
    for line in text.splitlines():
        if ":" not in line:
            continue
        name, rest = line.split(":", 1)
        if name.strip().lower() == "x-worker-version":
            val = rest.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,79}", val or ""):
        return "(none)"
    if (token and token in val) or (password and password in val):
        return "(none)"
    return val

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

def fail(st, after):
    head = "install failed: "
    if after is not None:
        head = "install failed after %ss: " % after
    sys.stderr.write(head + "last status %s; body: %s; worker version: %s\n" % (
        show_status(st), body_prefix(raw), worker_version(hdr_path)))

if mode == "report":
    fail(status, elapsed)
    sys.exit(11)
parsed = inner_installed(raw)
if isinstance(parsed, dict) and not retryable(status, parsed):
    out = parsed.get("out") or ""
    sys.stdout.write(redact("%s %s ms\n" % (out[-80:], parsed.get("ms"))))
    sys.exit(0)
if retryable(status, parsed):
    sys.exit(10)
fail(status, None)
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
    : > "$dir/hdr"
    status=$(curl -s -S --connect-timeout 10 -m "$curl_max" -D "$dir/hdr" -o "$dir/body" -w '%{http_code}' -X POST \
      -K <(printf 'header = "x-spike-token: %s"\nheader = "x-admin-password: %s"\n' "$SPIKE_TOKEN" "$ADMIN_PASSWORD") \
      "$url/_install") || status=000
    rc=0
    python3 -I "$dir/check.py" "$dir/body" "$status" "$dir/hdr" check "$elapsed" "$dir/token" "$dir/password" || rc=$?
    if [ "$rc" -eq 0 ]; then rm -rf "$dir"; return 0; fi
    if [ "$rc" -eq 11 ]; then rm -rf "$dir"; return 1; fi
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
  python3 -I "$dir/check.py" "$dir/body" "$status" "$dir/hdr" report "$elapsed" "$dir/token" "$dir/password" || true
  rm -rf "$dir"
  return 1
}
