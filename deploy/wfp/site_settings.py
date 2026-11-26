#!/usr/bin/env python3
"""The recorded per-site settings of a deploy/wfp site (#558).

lib.sh render_user reads a site's runtime settings from the run's environment only (PHP_INI,
LAZY_CACHE_MB, LAZY_ARENA, ...). A `site update` that did not export one dropped it: on
2026-11-14 ggc-test lost its PHP_INI opcache.memory_consumption 32 pin that way, and the update
said only "config changed". Now each good `site add` and `site update` records the run's settings
in the site's own media bucket, private outside uploads/ like _build/inputs.json (#379):

    _build/settings.json    {"v": 1, "settings": {NAME: value, ...}, "secrets": [NAME, ...]}

HTTP_ALLOW_HOSTS is the exception (#564). It has three states, so the record stores presence,
not a bare string: {"set": true, "value": "..."} when the run set it, including an empty value
(empty denies every host). Unset is absent from the record and means the default list. Merge
exports it only when it was set. A drop sets it back to unset, not to empty.

An update KEEPS a recorded setting the run does not set, uses the run's value when it sets one,
and drops one only when DROP_SETTINGS names it. A secret's VALUE is never recorded, only that the
site has it (TURNSTILE_SECRET): an update without it is refused unless DROP_SETTINGS names it.
A key this build does not know stops the update and names the key (#1285, deploy/lib/unknown_setting.py).
The record is not written again without that key. REPLACE_INPUTS=1 drops those keys and names each one.
A known key is kept as before.
OBSERVABILITY (#1050) is recorded for 0 and 1 only. 1 is events only (our own structured lines
and uncaught exceptions, no request metadata), so an update keeps a site's logs as they were; before
#1050 a remount that did not pass it turned the user Worker's logs off (cf759a, 2026-11-20). full
(the invocation logs: every request's URL, client IP and user agent; a throwaway only, #639) is
NEVER recorded: it stays on only when a run asks again, and a record that holds it is not kept.

    site_settings.py env-json                         this run's settings (stdout)
    site_settings.py get <bucket> <out.json>          exit 0 with the record, 3 when none
    site_settings.py put <bucket> <record.json>       write and read back
    site_settings.py merge <record.json>              the shell lines that keep the recorded
                                                      settings (stdout: export lines, a drop is
                                                      an empty value, except HTTP_ALLOW_HOSTS,
                                                      whose drop sets http_allow_mode=unset);
                                                      what it did (stderr);
                                                      exit 5 when a recorded secret is missing
    site_settings.py dropcheck <user config> <bindings.json> <secrets.json>
                                                      exit 6 when the live script binds a setting
                                                      this run's config or secrets drop, unless
                                                      DROP_SETTINGS names it (the guard for a site
                                                      with no record yet, and any miss of merge)
DROP_SETTINGS: names separated by spaces or commas; each must be a known setting or exit 2.
"""
import io
import json
import os
import re
import shlex
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
import snapshot  # noqa: E402
import unknown_setting  # noqa: E402

RECORD = "_build/settings.json"
# The env-only settings render_user reads (lib.sh), each rendered as a [vars] name of its own.
SETTINGS = ("PHP_INI", "LAZY_CACHE_MB", "LAZY_ARENA", "LAZY_ARENA_MB", "PHP_RECYCLE", "RECYCLE_WASM_MIB", "PHP_MEMORY_REUSE", "BOOT_GATE", "CRON_INTERVAL_MS",
            "TURNSTILE_SITEKEY", "TURNSTILE_WOO", "TURNSTILE_LOGIN", "TURNSTILE_COMMENTS",
            "TURNSTILE_REGISTER", "TURNSTILE_WOO_REGISTER", "TURNSTILE_LOSTPASSWORD",
            "MAIL_FROM", "MAIL_FROM_NAME", "MAIL_ALLOWED_TO", "PHP_LOCATION", "WP_VECTORIZE_SEARCH", "OPCACHE_SPLIT", "OPCACHE_REMOTE", "SITE_REMOTE",
            "REMOTE_FETCH_CAP", "REMOTE_HOLD_KIB", "SITE_FETCH_CAP", "SITE_HOLD_KIB", "SITE_RETRY_MS", "REQUEST_FRAMES", "PAGE_CACHE_PRODUCT_TTL", "WOO_EXTRAS",
            "OBJECT_CALL_DEADLINE_S", "OBJECT_START_BY_S", "OBJECT_DISCONNECT_SHED", "HTTP_ALLOW_HOSTS", "PDF_INVOICE", "PAGE_CACHE_TTL",
            "OBSERVABILITY", "SITE_TITLE", "DB_QUERY_TIMEOUT_MS", "DEMO_LOCK")
# #1050: the OBSERVABILITY values a record may hold. full carries client IPs: per run only.
RECORDABLE = {"OBSERVABILITY": ("0", "1")}
# Three states (#564): absent from the environment means the default list; present, including
# empty, means that exact list. The record holds {"set": true, "value": "..."} only when present.
# A bare string cannot say "empty" and "unset" apart, and empty denies every host.
PRESENCE = ("HTTP_ALLOW_HOSTS",)
# Measurement flags: never recorded, never kept, by design (the lead's ruling on #561). Silent
# persistence is the dangerous direction for them; silently going off is the safe one. A run that
# exports one turns it on for that upload; the next update without it turns it OFF, and says so.
#   HEADROOM_PROBE  GET /_headroom allocates until the isolate dies (#394): it KILLS the isolate.
#   MEM_LEDGER      "on" logs the isolate memory ledger on every request and cron leg: a steady
#                   log and CPU cost, for a diagnosis only.
#   WFP_PHP_ENV     a measurement build's PHP env (USE_ZEND_ALLOC=1 swaps PHP's allocator, #434).
#   FAULT_INJECT    "after-insert" kills the object after a request's INSERT on purpose (#730); "sql-fail" fails a
#                   request's chosen SQL statement as the memory ceiling does (#766). Throwaway only.
#   DISPATCH_PERF_LOG "on": the dispatcher logs each request's operator x-perf-id with its times (#605). Throwaway only.
# #1008: the four per-route headroom gates, "off" for a measurement arm only.
MEASUREMENT = ("HEADROOM_PROBE", "MEM_LEDGER", "WFP_PHP_ENV", "FAULT_INJECT", "EMAIL_FAULT", "DISPATCH_PERF_LOG",
               "APP_PASSWORD_HEADROOM", "PRODUCT_HEADROOM", "COMMENT_HEADROOM", "NAV_HEADROOM")
SECRETS = ("TURNSTILE_SECRET",)
# No log line carries data from SECRETS: a message about a secret is one fixed text, and which
# secret, and what happened, is in the exit code (5 a recorded secret is missing, 6 a live one would
# be dropped). The only place SECRETS reaches is the record itself (env-json): names, never values.
# The settings the live bindings can show dropped: rendered only when set. MAIL_FROM and PHP_LOCATION
# always render (a default); WP_VECTORIZE_SEARCH and OPCACHE_SPLIT render
# bindings (AI and the index; ASSETS), not a var: the record keeps those.
DROPPABLE_VARS = ("PHP_INI", "LAZY_CACHE_MB", "LAZY_ARENA", "LAZY_ARENA_MB", "PHP_RECYCLE", "RECYCLE_WASM_MIB", "PHP_MEMORY_REUSE", "BOOT_GATE", "CRON_INTERVAL_MS",
                  "TURNSTILE_SITEKEY", "TURNSTILE_WOO", "TURNSTILE_LOGIN", "TURNSTILE_COMMENTS",
                  "TURNSTILE_REGISTER", "TURNSTILE_WOO_REGISTER", "TURNSTILE_LOSTPASSWORD",
                  "MAIL_FROM_NAME", "OPCACHE_REMOTE", "SITE_REMOTE",
                  "REMOTE_FETCH_CAP", "REMOTE_HOLD_KIB", "SITE_FETCH_CAP", "SITE_HOLD_KIB", "SITE_RETRY_MS", "REQUEST_FRAMES", "PAGE_CACHE_PRODUCT_TTL", "WOO_EXTRAS",
                  "OBJECT_CALL_DEADLINE_S", "OBJECT_START_BY_S", "OBJECT_DISCONNECT_SHED", "PAGE_CACHE_TTL", "SITE_TITLE",
                  "DB_QUERY_TIMEOUT_MS", "DEMO_LOCK")  # each renders its var only when on (#563, #569, #667, #759, #1098, #1364)
# HTTP_ALLOW_HOSTS is not droppable here: render_user always writes the var (the default list
# when unset), so the live bindings cannot show that a custom list became the default (#564).


# #394: the default-on remote packs, which a run turns off with the value 0 (lib.sh remote_pack_defaults).
OPT_OUT = ("OPCACHE_REMOTE", "SITE_REMOTE")


def drop_list(env=os.environ):
    names = [x for x in re.split(r"[\s,]+", env.get("DROP_SETTINGS", "") or "") if x]
    bad = [x for x in names if x not in SETTINGS + SECRETS + MEASUREMENT]  # a measurement flag: a no-op
    if bad:
        print("site settings: DROP_SETTINGS names an unknown setting: %s (known: %s, and the Turnstile secret)" % (" ".join(bad), " ".join(SETTINGS)), file=sys.stderr)
        sys.exit(2)
    return set(names)


def presence_lines(k, mode, value=""):
    """Shell lines for one presence setting. mode "set" exports value, even when it is empty.
    mode "unset" is the default list. The empty export is not the state: http_allow_mode is.
    site update cannot unset a local on bash 3.2 (that reveals the global), so the mode tells
    render and the recorder to take the variable out of the child environment."""
    if mode == "set":
        return ["export %s=%s" % (k, shlex.quote(value)), "http_allow_mode=set"]
    return ["export %s=''" % k, "http_allow_mode=unset"]


def recorded_presence(v):
    """(set, value) for a presence object, or None when the shape is not one."""
    if isinstance(v, dict) and isinstance(v.get("set"), bool):
        if not v["set"]:
            return False, ""
        val = v.get("value", "")
        if isinstance(val, str):
            return True, val
    return None


def env_json(env=os.environ):
    settings = {}
    for k in SETTINGS:
        if k in PRESENCE:
            # Present in the environment, including empty. Absent means the default list.
            if k in env:
                settings[k] = {"set": True, "value": env[k]}
            continue
        if env.get(k):
            if k in RECORDABLE and env[k] not in RECORDABLE[k]:
                continue
            settings[k] = env[k]
    return {"v": 1, "settings": settings, "secrets": [k for k in SECRETS if env.get(k)]}


def merge(record, env=os.environ):
    drop = drop_list(env)
    settings = record.get("settings") or {}
    secrets = list(record.get("secrets") or [])
    # #1285: one function for both deploy paths. Hold its lines until this merge
    # returns 0. A later refusal (a missing secret) must not say a key was dropped,
    # because record_settings does not run and the record stays whole.
    held = io.StringIO()
    code, unknown = unknown_setting.guard(
        list(settings) + secrets, SETTINGS + SECRETS, env.get("REPLACE_INPUTS") == "1", held)
    if code != 0:
        sys.stderr.write(held.getvalue())
        return code
    skip = set(unknown)
    lines, rc = [], 0
    for k, v in sorted(settings.items()):
        if k in skip or k not in SETTINGS:
            # guard named this key. It is not kept, and it is not logged again.
            continue
        if k in PRESENCE:
            if k in drop:
                lines.extend(presence_lines(k, "unset"))
                print("  settings: %s DROPPED on purpose (DROP_SETTINGS)" % k, file=sys.stderr)
                continue
            parsed = recorded_presence(v)
            if parsed is None:
                print("  settings: the record has %s in a shape this run does not keep: ignored" % k, file=sys.stderr)
                continue
            is_set, val = parsed
            if k in env:
                # Present, including empty: this run's value wins.
                extra = " (it replaces the recorded value)" if is_set and env[k] != val else ""
                print("  settings: %s is set by this run%s" % (k, extra), file=sys.stderr)
            elif is_set:
                lines.extend(presence_lines(k, "set", val))
                print("  settings: %s kept from the record" % k, file=sys.stderr)
            continue
        if k in RECORDABLE and str(v) not in RECORDABLE[k]:
            print("  settings: the record has %s=%s, which is never kept (#1050): ignored" % (k, v), file=sys.stderr)
            continue
        if k in drop:
            lines.append("export %s=''" % k)
            print("  settings: %s DROPPED on purpose (DROP_SETTINGS)" % k, file=sys.stderr)
        elif env.get(k):
            print("  settings: %s is set by this run%s" % (k, "" if env[k] == v else " (it replaces the recorded value)"), file=sys.stderr)
        else:
            lines.append("export %s=%s" % (k, shlex.quote(str(v))))
            print("  settings: %s kept from the record" % k, file=sys.stderr)
    for k in record.get("secrets") or []:
        if k not in SECRETS:
            continue
        if k in drop:
            print("  settings: a recorded secret is DROPPED on purpose (DROP_SETTINGS)", file=sys.stderr)
        elif not env.get(k):
            print("  settings: a required secret is missing from this run: export it, or drop it on purpose with DROP_SETTINGS (deploy/wfp/README.md, #558); refused", file=sys.stderr)
            rc = 5
    # A drop is an empty value, never unset: the caller holds these as local -x (update --all runs
    # many sites), and every render function reads an empty value as not set.
    # HTTP_ALLOW_HOSTS is the exception: empty denies every host, so a drop is "unset" (the default).
    for k in sorted(drop - set(record.get("settings") or {}) - set(record.get("secrets") or [])):
        if k in PRESENCE:
            lines.extend(presence_lines(k, "unset"))
        else:
            lines.append("export %s=''" % k)
    if rc == 0:
        sys.stderr.write(held.getvalue())
    print("\n".join(lines))
    return rc


def rendered_vars(conf_text):
    out, on = set(), False
    for line in conf_text.splitlines():
        s = line.strip()
        if s.startswith("["):
            on = s == "[vars]"
            continue
        m = re.match(r"^([A-Za-z0-9_]+)\s*=", s)
        if on and m:
            out.add(m.group(1))
    return out



def default_http_allow_hosts():
    """The default allow list, from the one place that defines it (spikes/b2-wordpress/http-allow.mjs)."""
    src = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "spikes", "b2-wordpress", "http-allow.mjs")
    m = re.search(r"DEFAULT_HTTP_ALLOW_HOSTS = '([^']*)'", open(src).read())
    return m.group(1) if m else None


# #1385: the settings that describe how the bundle was BUILT (the remote packs, #394; the opcache split). A rollback
# re-deploys the saved build, which was built with its own values, and remote_assets_check fits this config to it:
# these follow the build, never the record. The run also defaults the remote packs on, so they can differ from an
# older record without any operator change.
BUILD_SHAPE = ("OPCACHE_SPLIT", "OPCACHE_REMOTE", "SITE_REMOTE")



# #1502: one [placement] assignment a kind a rollback puts back.
# Empty KIND_A_ROLLBACK_PLACEMENT leaves this run's block.
_PLACEMENT_LINE = re.compile(
    r'^(?:region = "(?:aws|gcp|azure):[a-z0-9-]{2,40}"|mode = "smart"|host = "[A-Za-z0-9.-]{1,253}:[0-9]{1,5}")$'
)


def restore_placement(text, env=os.environ):
    """Put the prior [placement] line back. Return (text, ok).
    ok is false only when a prior line was set and could not be written.
    An empty prior leaves this run's block."""
    line = (env.get("KIND_A_ROLLBACK_PLACEMENT") or "").strip()
    if not line:
        return text, True
    if not _PLACEMENT_LINE.match(line):
        print("site settings: the prior placement is not a placement line; the rollback keeps this run's", file=sys.stderr)
        return text, False
    lines = text.split("\n")
    start = None
    for i, raw in enumerate(lines):
        if raw.strip() == "[placement]":
            start = i
            break
    if start is None:
        print("site settings: ROLLBACK LEFT placement (no [placement] block to put the prior line into)", file=sys.stderr)
        return text, False
    out = []
    i = 0
    wrote = False
    while i < len(lines):
        out.append(lines[i])
        if i != start:
            i += 1
            continue
        i += 1
        while i < len(lines) and not lines[i].strip().startswith("["):
            st = lines[i].strip()
            if st and not st.startswith("#") and "=" in st:
                if not wrote:
                    out.append(line)
                    wrote = True
                i += 1
                continue
            out.append(lines[i])
            i += 1
        if not wrote:
            out.append(line)
            wrote = True
    print("  rollback: placement restored to the prior value", file=sys.stderr)
    return "\n".join(out), True


def rollback_conf(conf_in, record_path, conf_out, env=os.environ):
    """#1385: the config a rollback re-deploys. The update rendered conf_in from THIS run's settings; a
    rollback must put back the recorded ones, or a setting that broke the update stays live while the
    record goes back (and the next update sees nothing to do). Only the keys this run changed are
    touched (a setting it changed, or a measurement flag it set, which is never recorded). Each goes
    back to its recorded value in [vars], or its line is removed when the record has none. A key that
    has no [vars] line of its own cannot be put back here: it is named, and the exit is 4. With no
    record at all, the config is kept and every setting this run holds is named. Values are never printed.
    KIND_A_ROLLBACK_PLACEMENT, when set, is the prior [placement] line (region, mode, or host).
    An empty value leaves this run's block (#1502)."""
    import tomllib
    text = open(conf_in).read()
    def emit(body, code):
        if not isinstance(body, str):
            body = "\n".join(body)
        body, placed = restore_placement(body, env)
        open(conf_out, "w").write(body)
        if code == 0 and not placed:
            return 4
        return code

    rec = None
    if record_path and os.path.exists(record_path):
        rec = json.load(open(record_path))
    left = []
    if rec is None:
        left = sorted(k for k in SETTINGS + MEASUREMENT if k not in PRESENCE and k not in BUILD_SHAPE and env.get(k))
        code = 4 if left else 0
        if left:
            print("site settings: ROLLBACK LEFT A SETTING LIVE: %s (no recorded settings, so the rollback re-deploys this run's; set them back by hand)" % " ".join(left), file=sys.stderr)
        return emit(text, code)
    settings = rec.get("settings") or {}
    try:
        vars_ = tomllib.loads(text).get("vars") or {}
    except tomllib.TOMLDecodeError:
        print("site settings: the rendered config does not parse; the rollback cannot put the settings back", file=sys.stderr)
        return emit(text, 4)
    def want(k):
        if k in MEASUREMENT:
            return None
        if k in PRESENCE:
            parsed = recorded_presence(settings[k]) if k in settings else None
            return parsed[1] if parsed and parsed[0] else default_http_allow_hosts()
        v = settings.get(k)
        return None if v in (None, "") else str(v)
    def ran(k):
        if k in PRESENCE:
            v = vars_.get(k)
            return None if v is None else str(v)
        v = env.get(k)
        return None if v in (None, "") else str(v)
    lines = text.split("\n")
    def var_line(k):
        on = False
        for i, line in enumerate(lines):
            st = line.strip()
            if st.startswith("["):
                on = st == "[vars]"
                continue
            if on and re.match(r"^%s\s*=" % re.escape(k), st):
                return i
        return None
    for k in SETTINGS + MEASUREMENT:
        if k in BUILD_SHAPE or (k in PRESENCE and k not in vars_):
            continue  # follows the build; or a presence key this config does not render at all
        w, r = want(k), ran(k)
        if w == r:
            continue
        i = var_line(k)
        if i is None:
            left.append(k)
            continue
        if w is None:
            lines.pop(i)
            print("  rollback: %s restored to the recorded value (not set)" % k, file=sys.stderr)
        else:
            lines[i] = "%s = %s" % (k, json.dumps(w))
            print("  rollback: %s restored to the recorded value" % k, file=sys.stderr)
    code = 0
    if left:
        print("site settings: ROLLBACK LEFT A SETTING LIVE: %s (no [vars] line of its own to put back; set it back by hand)" % " ".join(sorted(left)), file=sys.stderr)
        code = 4
    return emit("\n".join(lines), code)

def dropcheck(conf_path, bindings_path, secrets_path, env=os.environ):
    drop = drop_list(env)
    try:
        live = json.load(open(bindings_path))
        live = live.get("result") if isinstance(live, dict) else live
    except (OSError, ValueError):
        live = None
    if not isinstance(live, list):
        print("site settings: the live bindings cannot be read, so a dropped setting cannot be ruled out; refused", file=sys.stderr)
        return 6
    plain = {b.get("name") for b in live if isinstance(b, dict) and b.get("type") == "plain_text"}
    secret = {b.get("name") for b in live if isinstance(b, dict) and b.get("type") == "secret_text"}
    now_vars = rendered_vars(open(conf_path).read())
    now_secrets = set(json.load(open(secrets_path)))
    # A measurement flag going off is allowed, and said: it is never kept.
    for k in MEASUREMENT:
        if k in plain and k not in now_vars:
            print("site settings: %s was on and is now OFF: measurement flags are never kept" % k, file=sys.stderr)
    # #394: OPCACHE_REMOTE=0 or SITE_REMOTE=0 set by this run is the opt-out from the default remote
    # packs: on purpose, so not a drop. (DROP_SETTINGS would empty it, and an empty value is the default.)
    opted_out = {k for k in OPT_OUT if env.get(k) == "0"}
    lost = sorted(k for k in DROPPABLE_VARS if k in plain and k not in now_vars and k not in drop and k not in opted_out)
    lost_secret = any(k in secret and k not in now_secrets and k not in drop for k in SECRETS)
    if lost or lost_secret:
        what = " ".join(lost + (["a required secret"] if lost_secret else []))
        print("site settings: the live site has %s, and this update would DROP it: export it, or drop it on purpose with DROP_SETTINGS=\"%s\"; refused" % (what, " ".join(lost + (["TURNSTILE_SECRET"] if lost_secret else []))), file=sys.stderr)
        return 6
    return 0


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "env-json":
        print(json.dumps(env_json(), sort_keys=True)); return 0
    if cmd == "get":
        st, b = snapshot.s3("GET", "/%s/%s" % (argv[2], RECORD))
        if st == 404:
            return 3
        if st != 200:
            print("site settings: cannot read %s/%s (HTTP %s)" % (argv[2], RECORD, st), file=sys.stderr); return 1
        try:
            d = json.loads(b)
        except ValueError:
            print("site settings: %s/%s is not JSON" % (argv[2], RECORD), file=sys.stderr); return 1
        json.dump(d, open(argv[3], "w")); return 0
    if cmd == "put":
        body = open(argv[3], "rb").read()
        st, _ = snapshot.s3("PUT", "/%s/%s" % (argv[2], RECORD), body)
        g, b = snapshot.s3("GET", "/%s/%s" % (argv[2], RECORD))
        if st not in (200, 201) or g != 200 or b != body:
            print("site settings: the record did not store (PUT %s, read back %s)" % (st, g), file=sys.stderr); return 1
        return 0
    if cmd == "merge":
        return merge(json.load(open(argv[2])))
    if cmd == "dropcheck":
        return dropcheck(argv[2], argv[3], argv[4])
    if cmd == "rollback-conf":
        return rollback_conf(argv[2], argv[3], argv[4])
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
