#!/bin/bash
# #504 (PR #840): WooCommerce registers no blocks on the admin screens that render none (php/woo-blocks-scope.php).
# dosql-local, a WooCommerce site; every comparison is ONE build with the plugin on and off (x-mem-off: wcscope, an
# operator switch). A fresh runtime before each measured request; 3 each; the median.
#   1. The peak (wasm1MiB) of a listed screen is at least MIN_SAVE_MIB under off: the profile GET, the profile save
#      (POST), and options-general.php.
#   2. Their HTML is byte-identical, on against off, with the values that change on every load blanked
#      (profile.php's suggested password, the userSettings time, the settings clock); a control shows off against off is identical too.
#   3. SCOPE: post-new.php and post.php (the editors, not listed) peak the same on and off (within 3 MiB).
#      On run 44031071550 the post-new.php medians were 2 MiB apart.
#      One arm spanned 3 MiB by itself.
#      A real scope miss saves at least 4 MiB. This band still fails that miss.
# PORT defaults to 8798, so it does not take the 8797 the lead's runs use.
set -u
cd "$(dirname "$0")/.." || exit 1
export PORT=${PORT:-8798} DEV_ENV=${DEV_ENV:-dosql-local}
B=http://localhost:$PORT; PW=${ADMIN_PASSWORD:-local-spike-password}; TOK=${SPIKE_TOKEN:-local-spike-token}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/woo-blocks-scope.XXXXXX"); export PERSIST_TO=$STATE
trap './run.sh --stop > /dev/null 2>&1; rm -rf "$STATE"' EXIT
DEV_LOCAL=1 DEV_VARS="PHP_RECYCLE:off" ./run.sh _ping > /dev/null || { echo "woo-blocks-scope: wrangler dev did not start"; tail -20 dev.log; exit 1; }
curl -sf -H "x-spike-token: $TOK" -X POST -H "x-admin-password: $PW" "$B/_install" > /dev/null || { echo "woo-blocks-scope: /_install failed"; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "x-spike-token: $TOK" -X POST "$B/_activate?plugin=woocommerce/woocommerce.php")" = 200 ] || { echo "woo-blocks-scope: activating WooCommerce failed"; exit 1; }
B=$B SPIKE_TOKEN=$TOK ADMIN_PASSWORD=$PW MIN_SAVE_MIB=${MIN_SAVE_MIB:-4} SAME_MIB=${SAME_MIB:-3} python3 -I - <<'PY'
import json, os, re, statistics, sys, time
sys.path.insert(0, os.path.join(os.getcwd(), "tests")); import break_lib as BL
o = BL.login()
OFF = {"x-mem-off": "wcscope"}
MIN = float(os.environ["MIN_SAVE_MIB"])
SAME = float(os.environ["SAME_MIB"])
fails = []
def check(name, cond, detail=""):
    print(("  ok   " if cond else "  FAIL ") + name + (("  (" + detail + ")") if detail else "")); cond or fails.append(name)
def fresh():
    BL.req(o, "/wp-login.php", headers={"x-runtime-recycle": "force"})
def peak_of(r):
    if r["code"] not in (200, 302): return None
    return json.loads((r["h"] or {}).get("x-perf") or "{}").get("wasm1MiB")
def get_peak(path, h):
    fresh(); return peak_of(BL.req(o, path, headers={"x-mem-ledger": "1", **h}, timeout=300))
form0 = BL.req(o, "/wp-admin/profile.php")["body"]
m = re.search(rb'name="_wpnonce"[^>]*value="([a-f0-9]+)"', form0)
uid = re.search(rb'name="user_id"[^>]*value="(\d+)"', form0)
email = re.search(rb'name="email"[^>]*value="([^"]*)"', form0)
if not (m and uid and email): sys.exit("woo-blocks-scope: the profile form was not found")
form = {"_wpnonce": m.group(1).decode(), "_wp_http_referer": "/wp-admin/profile.php", "from": "profile", "checkuser_id": uid.group(1).decode(),
        "user_id": uid.group(1).decode(), "email": email.group(1).decode(), "nickname": "admin", "display_name": "admin",
        "description": "woo-blocks-scope", "action": "update", "submit": "Update Profile"}
def save_peak(h):
    fresh(); return peak_of(BL.req(o, "/wp-admin/profile.php", form, headers={"x-mem-ledger": "1", **h}, timeout=300))
def pair(fn):
    on, off = [], []
    for _ in range(3):
        on.append(fn({})); off.append(fn(OFF))
    return on, off
def num(xs): return all(isinstance(v, (int, float)) for v in xs)
results = {}
for name, fn in (("profile GET", lambda h: get_peak("/wp-admin/profile.php", h)),
                 ("profile save", save_peak),
                 ("options-general.php", lambda h: get_peak("/wp-admin/options-general.php", h))):
    on, off = pair(fn); results[name] = (on, off)
    ok = num(on + off) and statistics.median(on) <= statistics.median(off) - MIN
    check("1. %s: the peak is at least %g MiB lower" % (name, MIN), ok, "on %s, off %s" % (on, off))
def body(path, h):
    r = BL.req(o, path, headers=h, timeout=300); return r["code"], r["body"]
# These values change on EVERY load (or every minute), plugin or not: the suggested new password on profile.php (data-pw, from
# wp_generate_password), the userSettings timestamp, and the settings page's clock (<code>Y-m-d H:i:s</code>). Only those are blanked; anything else must match.
VOLATILE = [(rb'data-pw="[^"]*"', b'data-pw=""'), (rb'"time":"\d+"', b'"time":""'),
            (rb'<code>\d{4}-\d\d-\d\d \d\d:\d\d:\d\d</code>', b'<code>CLOCK</code>'),
            # #1120 review: the settings page also prints NOW in each date and time format choice and in the custom
            # format's preview, so two loads across a minute differ (opcache-build run 44891720946: "4:55 am").
            (rb'(<span class="date-time-text[^"]*">)[^<]*(</span>)', rb'\1NOW\2'), (rb'(<span class="example">)[^<]*(</span>)', rb'\1NOW\2')]
def norm(b):
    for pat, rep in VOLATILE: b = re.sub(pat, rep, b)
    return b
def first_diff(a, b):
    if a == b: return ""
    i = next((k for k in range(min(len(a), len(b))) if a[k] != b[k]), min(len(a), len(b)))
    return ", first diff at %d: %r" % (i, a[max(0, i-40):i+40])
for path in ("/wp-admin/profile.php", "/wp-admin/options-general.php"):
    (c0, b0), (c1, b1), (c2, b2) = body(path, OFF), body(path, {}), body(path, OFF)
    n0, n1, n2 = norm(b0), norm(b1), norm(b2)
    check("2. control: %s off against off is identical once the volatile values are blanked" % path,
          c0 == c2 == 200 and n0 == n2, "%d vs %d bytes%s" % (len(n0), len(n2), first_diff(n0, n2)))
    check("2. %s: the HTML is byte-identical, on against off (the same values blanked)" % path,
          c1 == c2 == 200 and n1 == n2, "%d vs %d bytes%s" % (len(n1), len(n2), first_diff(n1, n2)))
pid = json.loads(BL.rest(o, "/wp/v2/posts", {"title": "scope edit %d" % time.time(), "status": "draft", "content": "x"})["body"])["id"]
for name, path in (("post-new.php", "/wp-admin/post-new.php"), ("post.php", "/wp-admin/post.php?post=%d&action=edit" % pid)):
    on, off = pair(lambda h: get_peak(path, h)); results[name] = (on, off)
    ok = num(on + off) and abs(statistics.median(on) - statistics.median(off)) <= SAME
    check("3. %s (an editor, not listed): the same peak on and off, within %g MiB" % (name, SAME), ok, "on %s, off %s" % (on, off))
print("@event woo-blocks-scope " + json.dumps({k: {"on": v[0], "off": v[1]} for k, v in results.items()}))
print("woo-blocks-scope: %d failing" % len(fails))
sys.exit(1 if fails else 0)
PY
