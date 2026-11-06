# shellcheck shell=bash
# Variant c1: WordPress and WooCommerce in one Cloudflare Container
# (spikes/c1-woo-container, docs/approach-c1.md). Workers Paid only.
#
# deploy.sh sources this file after `terraform apply` and calls the steps in
# order (c1_main does all of them):
#   c1_build    WordPress, WooCommerce and the plugin suite into build/
#   c1_config   the Wrangler config from the Terraform outputs (sets CONF, PUBLIC_HOST)
#   c1_deploy   wrangler deploy with the secrets in the same version (sets URL,
#               SPIKE_TOKEN, ADMIN_PASSWORD)
#   c1_wait     wait for the container rollout to complete (ROLLOUT_TIMEOUT,
#               default 600 s; a fixed ROLLOUT_WAIT if the API cannot be read),
#               stop the container once, wait for the first 200 (sets FIRST_START_S)
#   c1_check    the Store object is from this deploy, and the running container
#               has its settings (the drop-in is there exactly when
#               OBJECT_CACHE=apcu) and runs PHP-FPM, whose ping answers;
#               CHECK_WAIT (default 600 s)
#   c1_measure  e2e.sh, the page benchmark, one cold start -> deploy/results/
# The steps use ROOT, TF, NAME, ACCOUNT_ID, LOCATION, log and out from deploy.sh,
# and share the variables they set.
#
# Options: INSTANCE_TYPE (default standard-1), PHP_WORKERS (default from the
# instance type), IDLE_SECONDS (default 900), OBJECT_CACHE (apcu or none,
# default apcu), REPLICA_PATH (default store), QUEUE_RUNNER (local or
# loopback, default local), CRON_SECONDS (default 10), AS_TIME_LIMIT (default 5), PUBLIC_HOST (default
# <NAME>.<account subdomain>.workers.dev), ROLLOUT_TIMEOUT (default 600 s),
# ROLLOUT_POLL_S (default 10 s), ROLLOUT_WAIT (the fallback, default 60 s),
# START_TIMEOUT (default 900 s), BENCH, N; mail: MAIL_FROM, MAIL_FROM_NAME,
# MAIL_ALLOWED_TO, MAIL_CHECK (deploy/README.md, Mail for c1).

C1="$ROOT/spikes/c1-woo-container"
INSTANCE_TYPE=${INSTANCE_TYPE:-standard-1}
# PHP workers at 256 MB each. basic (1 GiB) dropped a connection with 4
# (docs/approach-c1.md); standard-1 (4 GiB) and standard-2 (6 GiB) were
# measured with 4 and 8.
case "$INSTANCE_TYPE" in basic) c1_w=2 ;; standard-1|standard) c1_w=4 ;; standard-2) c1_w=8 ;; *) c1_w=2 ;; esac
PHP_WORKERS=${PHP_WORKERS:-$c1_w}
IDLE_SECONDS=${IDLE_SECONDS:-900}
OBJECT_CACHE=${OBJECT_CACHE:-apcu}
REPLICA_PATH=${REPLICA_PATH:-store}
QUEUE_RUNNER=${QUEUE_RUNNER:-local}
CRON_SECONDS=${CRON_SECONDS:-10}
AS_TIME_LIMIT=${AS_TIME_LIMIT:-5}

c1_build() {
  log "build (c1)"
  (cd "$C1" && { [ -d node_modules ] || npm ci --silent; } && ./build.sh | tail -1)
}

# Mail (issue #104): MAIL_FROM must be on a domain that is onboarded and
# enabled for Cloudflare Email Sending, or every mail would fail at the first
# order. The same API as `wrangler email sending list` (Wrangler 4.107):
# GET /zones?name=<the domain or a parent> for the zone, then
# GET /zones/<id>/email/sending/subdomains, whose result has {name, enabled}.
# MAIL_CHECK=0 skips it (only for the negative live test). C1_CF_API is the
# API base, for the tests. Exit 0 (ok, or no MAIL_FROM) or 1.
c1_mail_check() {
  if [ -z "${MAIL_FROM:-}" ]; then
    echo "mail: MAIL_FROM is not set: no send_email binding, and every wp_mail() fails loudly (c1_mail_not_configured, issue #104)"
    return 0
  fi
  if [ "${MAIL_CHECK:-1}" = 0 ]; then
    echo "mail: MAIL_CHECK=0: the sending domain of $MAIL_FROM is NOT checked" >&2
    return 0
  fi
  C1_CF_API=${C1_CF_API:-https://api.cloudflare.com/client/v4} python3 - "$MAIL_FROM" <<'PY'
import json, os, sys, urllib.request, urllib.parse
addr = sys.argv[1]
domain = addr.split("@", 1)[1].lower()
api, token, acct = os.environ["C1_CF_API"], os.environ.get("CLOUDFLARE_API_TOKEN", ""), os.environ.get("ACCOUNT_ID", "")
def get(path):
    req = urllib.request.Request(api + path, headers={"Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, {}
    except (OSError, ValueError) as e:
        return 0, {"error": str(e)}
labels = domain.split(".")
zone = None
for i in range(len(labels) - 1):
    cand = ".".join(labels[i:])
    q = "/zones?" + urllib.parse.urlencode({"name": cand, **({"account.id": acct} if acct else {})})
    code, d = get(q)
    if code != 200:
        print("mail: cannot read the zones (HTTP %s): the sending domain of %s is not checked; the deploy stops (MAIL_CHECK=0 skips this)" % (code, addr), file=sys.stderr)
        sys.exit(1)
    if d.get("result"):
        zone = d["result"][0]
        break
if not zone:
    print("mail: no zone on this account holds %s: it cannot send mail (Cloudflare DNS is needed)" % domain, file=sys.stderr)
    sys.exit(1)
code, d = get("/zones/%s/email/sending/subdomains" % zone["id"])
if code != 200:
    print("mail: cannot read the Email Sending domains of zone %s (HTTP %s); the deploy stops (MAIL_CHECK=0 skips this)" % (zone.get("name"), code), file=sys.stderr)
    sys.exit(1)
subs = {str(s.get("name", "")).lower(): s for s in (d.get("result") or [])}
s = subs.get(domain)
if not s:
    print("mail: %s is not onboarded for Email Sending in zone %s (onboarded: %s); see deploy/README.md, Mail" % (domain, zone.get("name"), ", ".join(sorted(subs)) or "none"), file=sys.stderr)
    sys.exit(1)
if not s.get("enabled"):
    print("mail: %s is onboarded but not enabled for Email Sending" % domain, file=sys.stderr)
    sys.exit(1)
print("mail: %s can send (zone %s, Email Sending enabled)" % (addr, zone.get("name")))
PY
}

c1_config() {
  local replica media endpoint compat sub
  c1_mail_check || return 1
  replica=$(out replica_bucket); media=$(out media_bucket); endpoint=$(out r2_endpoint)
  echo "replica bucket $replica, media bucket $media"
  # The site address goes into the Worker vars (WordPress uses it as its home
  # URL), so it must be known before the deploy: ask the API for the account's
  # workers.dev subdomain.
  if [ -z "${PUBLIC_HOST:-}" ]; then
    # The token goes to curl in a config on a pipe, not in the arguments (ps).
    sub=$(curl -sf -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/subdomain" \
      | python3 -c 'import json, sys; print(json.load(sys.stdin)["result"]["subdomain"])')
    PUBLIC_HOST="$NAME.$sub.workers.dev"
  fi
  # Next to wrangler.toml, so the relative paths are the same.
  CONF="$C1/wrangler.deploy.$NAME.toml"
  compat=$(sed -n 's/^compatibility_date = "\(.*\)"/\1/p' "$C1/wrangler.toml" | head -1)
  NAME=$NAME PUBLIC_HOST=$PUBLIC_HOST REPLICA=$replica MEDIA_BUCKET=$media R2_ENDPOINT=$endpoint \
    COMPAT=$compat MAIL_FROM=${MAIL_FROM:-} MAIL_FROM_NAME=${MAIL_FROM_NAME:-} MAIL_ALLOWED_TO=${MAIL_ALLOWED_TO:-} ADMIN_EMAIL=${ADMIN_EMAIL:-} INSTANCE_TYPE=$INSTANCE_TYPE PHP_WORKERS=$PHP_WORKERS IDLE_SECONDS=$IDLE_SECONDS OBJECT_CACHE=$OBJECT_CACHE REPLICA_PATH=$REPLICA_PATH QUEUE_RUNNER=$QUEUE_RUNNER CRON_SECONDS=$CRON_SECONDS AS_TIME_LIMIT=$AS_TIME_LIMIT SEED_SHA256=${SEED_SHA256:-} \
    "$ROOT/deploy/variants/c1-config.sh" > "$CONF"
}

# The secrets go in the same version (--secrets-file): a container that starts
# between a deploy and a later `secret bulk` would install WordPress with no
# admin password and no salt.
c1_deploy() {
  local secrets dep rc=0
  log "deploy (c1, $INSTANCE_TYPE, $PHP_WORKERS PHP workers, object cache $OBJECT_CACHE, replica path $REPLICA_PATH, queue runner $QUEUE_RUNNER)"
  secrets=$(mktemp); chmod 600 "$secrets"
  (cd "$TF" && terraform workspace select "$NAME" >/dev/null && terraform output -json) | python3 -c '
import json, sys
o = {k: v["value"] for k, v in json.load(sys.stdin).items()}
json.dump({"WP_SALT": o["wp_salt"], "ADMIN_PASSWORD": o["admin_password"], "SPIKE_TOKEN": o["spike_token"],
           "LITESTREAM_ACCESS_KEY_ID": o["litestream_access_key_id"],
           "LITESTREAM_SECRET_ACCESS_KEY": o["litestream_secret_access_key"]}, open(sys.argv[1], "w"))' "$secrets" || rc=$?
  [ "$rc" = 0 ] && { dep=$(cd "$C1" && npx wrangler deploy --config "$CONF" --secrets-file "$secrets" --containers-rollout immediate 2>&1) || rc=$?; }
  rm -f "$secrets"
  [ "$rc" = 0 ] || { echo "${dep:-}" | tail -30; return 1; }
  URL=$(echo "$dep" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
  echo "$dep" | grep -E 'Total Upload|Current Version' || true
  [ "$URL" = "https://$PUBLIC_HOST" ] || { echo "deployed to '$URL', but PUBLIC_HOST is $PUBLIC_HOST: WordPress would link to the wrong host" >&2; return 1; }
  SPIKE_TOKEN=$(out spike_token); ADMIN_PASSWORD=$(out admin_password)
}

# Print the seconds until GET / answers 200. ?nocache= keeps the edge page
# cache out of the answer.
c1_up() {
  local t0=$SECONDS code
  while :; do
    code=$(curl -s -o /dev/null -m 120 -w '%{http_code}' "$URL/?nocache=$RANDOM$RANDOM" || true)
    [ "$code" = 200 ] && { echo $((SECONDS - t0)); return 0; }
    [ $((SECONDS - t0)) -lt "${START_TIMEOUT:-900}" ] || { echo "no 200 from $URL/ after ${START_TIMEOUT:-900} s (last $code)" >&2; return 1; }
    sleep 5
  done
}

# One read of the container rollout of this deploy (issue #106). Prints one
# line: "done ...", "failed ...", "waiting ...", "none ..." (no rollout for
# the application's version yet), "no-app ..." or "api-error ...". A new
# application at version 1 with no rollout at all is "done": its first
# version has no rollout object.
# The application is <NAME>-store: the list finds its id, and GET
# /applications/<id> gives its version (the one this deploy made; the list's
# version is stale). The rollout to follow is the newest one whose
# target_version is that version. Fields as in Wrangler 4.107's client models
# (packages/containers-shared: Application.version, ApplicationRollout.status
# pending|progressing|completed|reverted|replaced, target_version, progress).
# The live API (read 2026-11-06) is a superset: {result: [...]} with the
# rollouts newest first, older ones "replaced", and progress.version_distribution.
# The token needs only "Workers Containers Write", which a deploy needs anyway.
# C1_API is the containers API base, for the tests.
c1_rollout_state() {
  local api=$1 t code_a code_g code_r id
  t=$(mktemp -d)
  code_a=$(curl -s -m 30 -o "$t/apps" -w '%{http_code}' -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") "$api/applications?name=$NAME-store" || true)
  id=$(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except (OSError, ValueError):
    d = {}
items = d.get("result", []) if isinstance(d, dict) else d
apps = [a for a in (items or []) if isinstance(a, dict) and a.get("name") == sys.argv[2]]
print(apps[0].get("id", "") if len(apps) == 1 else "")' "$t/apps" "$NAME-store" 2>/dev/null)
  # The list finds the id only. Its version is stale: on 2026-11-06 the list
  # said version 1 for 8 minutes and more after the application moved to
  # version 2, while GET /applications/<id> was current (wp-c1-live). So the
  # version, and the health, come from the single GET.
  code_g=000; code_r=000
  if [ "$code_a" = 200 ] && [ -n "$id" ]; then
    code_g=$(curl -s -m 30 -o "$t/app" -w '%{http_code}' -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") "$api/applications/$id" || true)
    code_r=$(curl -s -m 30 -o "$t/rollouts" -w '%{http_code}' -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") "$api/applications/$id/rollouts?limit=10" || true)
  fi
  python3 -c '
import json, sys
name, code_a, code_g, code_r, d = sys.argv[1:6]
def load(f):
    try:
        x = json.load(open(f))
    except (OSError, ValueError):
        return []
    x = x.get("result", []) if isinstance(x, dict) else x
    return [i for i in (x or []) if isinstance(i, dict)]
if code_a != "200":
    print("api-error applications HTTP", code_a); sys.exit()
apps = [a for a in load(d + "/apps") if a.get("name") == name]
if len(apps) != 1:
    print("no-app", name, "found", len(apps)); sys.exit()
if code_g != "200":
    print("api-error application HTTP", code_g); sys.exit()
try:
    app = json.load(open(d + "/app"))
except (OSError, ValueError):
    app = {}
if isinstance(app, dict) and isinstance(app.get("result"), dict):
    app = app["result"]
v = app.get("version") if isinstance(app, dict) else None
if v is None:
    print("api-error application has no version"); sys.exit()
if code_r != "200":
    print("api-error rollouts HTTP", code_r); sys.exit()
all_rs = load(d + "/rollouts")
# A new application places its first version with no rollout object at all
# (measured 2026-11-06 on wp-c1-live: version 1, rollouts []). Only then:
# at a later version an empty list can mean "not created yet", so it waits.
if not all_rs and v == 1:
    h = (app.get("health") or {}).get("instances") or {}
    print("done first version 1, placed with no rollout (a new application); instances healthy %s, starting %s, failed %s (an instance starts on the first request)" % (h.get("healthy"), h.get("starting"), h.get("failed")))
    sys.exit()
rs = [r for r in all_rs if r.get("target_version") == v]
if not rs:
    print("none for version", v); sys.exit()
r = max(rs, key=lambda r: str(r.get("created_at", "")))
p = r.get("progress") or {}
detail = "version %s, step %s of %s, instances %s of %s" % (v, p.get("current_step"), p.get("total_steps"), p.get("updated_instances"), p.get("total_instances"))
vd = p.get("version_distribution") or {}
if "target_version_percentage" in vd:
    detail += ", %s %% on the new version" % vd["target_version_percentage"]
st = r.get("status")
if st == "completed":
    print("done", detail)
elif st == "reverted":
    print("failed reverted", detail)
else:
    print("waiting", st, detail)' "$NAME-store" "$code_a" "$code_g" "$code_r" "$t"
  rm -rf "$t"
}

# Wait for the container rollout of this deploy (issue #106): until it is
# completed (return 0), reverted, replaced with no newer version for
# ROLLOUT_REPLACED_POLLS reads (6), or not done in ROLLOUT_TIMEOUT s (600;
# return 1). If the API cannot be read 3 times in a row, return 2: the caller
# then falls back to the fixed wait. A fixed 60 s was too short: on
# 2026-11-06 a rollout took about 90 s, so the deploy check met the previous
# image (issue #99, arms 3b and 3c).
c1_rollout() {
  local api=${C1_API:-https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/containers}
  local t0=$SECONDS st last="" errs=0 rep=0
  while :; do
    st=$(c1_rollout_state "$api")
    [ "$st" = "$last" ] || echo "rollout: $st"
    last=$st
    case "$st" in
      done*) echo "container rollout completed after $((SECONDS - t0)) s"; return 0 ;;
      failed*) echo "the container rollout ended as ${st#failed }: the new image is not running" >&2; return 1 ;;
      api-error*|no-app*) errs=$((errs + 1)); [ "$errs" -lt 3 ] || return 2 ;;
      # "replaced": a newer rollout took over. The version is read again on
      # each poll, so a newer version normally shows next (seen live: version
      # 2 replaced, then version 3 done). A replaced rollout never completes,
      # so if the version stays, fail after ROLLOUT_REPLACED_POLLS reads (6)
      # instead of waiting ROLLOUT_TIMEOUT.
      "waiting replaced"*)
        errs=0; rep=$((rep + 1))
        [ "$rep" -lt "${ROLLOUT_REPLACED_POLLS:-6}" ] || { echo "the rollout of this version was replaced and no newer version appeared in $rep reads (last: $st)" >&2; return 1; } ;;
      *) errs=0; rep=0 ;;
    esac
    [ $((SECONDS - t0)) -lt "${ROLLOUT_TIMEOUT:-600}" ] || { echo "the container rollout did not complete in ${ROLLOUT_TIMEOUT:-600} s (last: $st)" >&2; return 1; }
    sleep "${ROLLOUT_POLL_S:-10}"
  done
}

# A container that starts before the rollout of a deploy ends runs the old
# image (seen on the spike, on ggc, and on wp-c1-perf, issue #99). Wait for the
# rollout, then stop the container once: the next request starts one from the
# new image. On a new site there is no container yet and the stop does
# nothing. The first container of a new site installs WordPress and
# WooCommerce (php/install.php); later containers restore the database from
# the replica.
c1_wait() {
  local rc=0
  log "rollout: wait for the container rollout, then stop the container once"
  c1_rollout || rc=$?
  if [ "$rc" = 2 ]; then
    echo "cannot read the container rollout (API): waiting a fixed ${ROLLOUT_WAIT:-60} s instead"
    sleep "${ROLLOUT_WAIT:-60}"
  elif [ "$rc" != 0 ]; then
    return 1
  fi
  # The answer says if a container was running (and was stopped) or not
  # (skipped). The token goes to curl in a config on a pipe, not in argv.
  local stop sb scode
  # A body that is not the Store object's JSON is named as such, with its HTTP
  # status: on a new workers.dev name the first requests can get no Worker
  # answer yet (seen 2026-11-06 on wp-c1-new: "stop: {}", then the first 200
  # after 98 s). The deploy check after this still finds an old container.
  sb=$(mktemp)
  scode=$(curl -s -m 60 -o "$sb" -w '%{http_code}' -X POST -K <(printf 'header = "x-spike-token: %s"\n' "$SPIKE_TOKEN") "$URL/_store-stop" || true)
  stop=$(python3 -c 'import json, sys
try:
    d = json.load(open(sys.argv[1]))
except (OSError, ValueError):
    d = None
if not isinstance(d, dict):
    body = open(sys.argv[1], "rb").read()[:80].decode("utf-8", "replace").replace("\n", " ")
    print("stop: no answer from the Store object (HTTP %s, %d bytes: %r): nothing stopped" % (sys.argv[2], len(body), body))
elif d.get("skipped"):
    print("no container was running: nothing to stop")
else:
    print("stop: %s" % json.dumps(d))' "$sb" "$scode") || true
  rm -f "$sb"
  echo "$stop"
  # A container that did not stop in 30 s (still_running) is very likely stuck:
  # seen 2026-11-06 (issue #93), an instance that answered no request survived a
  # deploy, a stop and a kill. Waiting 900 s for it helps nobody: stop here.
  if [[ "$stop" == *'"still_running": true'* ]]; then
    echo "the container did not stop in 30 s: it is probably stuck (issue #93)." >&2
    echo "Recover: deploy once with a changed container setting (for example INSTANCE_TYPE), which rolls out a new instance, then deploy again." >&2
    echo "If that stop also answers still_running: send no traffic to the site for about 15 minutes, so the Store object can move to the new version, then deploy again (seen 2026-11-06, issue #105)." >&2
    return 1
  fi
  log "wait for WordPress"
  FIRST_START_S=$(c1_up)
  echo "first answer 200 after $FIRST_START_S s"
}

# A container can run the new image with the environment of the deploy before
# (seen twice on 2026-11-05 on wp-c1-perf: the drop-in did not match
# OBJECT_CACHE). The container gets its environment from the Store Durable
# Object, and a request on the new Worker can reach an object that still runs
# the code of the deploy before, "typically for seconds to minutes"
# (developers.cloudflare.com/durable-objects/platform/known-issues/). Two
# steps:
# 1. Wait (up to CHECK_WAIT, default 600 s) until /_store-info says the object
#    was built by this Worker version.
# 2. Then _stats.php must show the drop-in that OBJECT_CACHE asks for. If not,
#    the container is from the old object: stop it (the stop resets the object
#    too) and check the next one, once.
# Still wrong: fail, so no measurement runs on the wrong settings.
c1_info() {
  curl -s -m 60 -K <(printf 'header = "x-spike-token: %s"\n' "$SPIKE_TOKEN") "$URL$1" | python3 -c 'import json, sys
try:
    d = json.load(sys.stdin)
except ValueError:
    d = {}
k = sys.argv[1]
print(str(d.get(k)).lower() if k in d else "unknown", d.get("do_version") or "-", d.get("worker_version") or "-")' "$2"
}
c1_check() {
  local want cur got sapi t0=$SECONDS try code
  # A container that answers a static file (no WordPress) is not stuck (#93).
  code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$URL/_boot.txt" || true)
  [ "$code" = 200 ] || { echo "the container does not answer a static file (/_boot.txt: $code): probably stuck (issue #93)" >&2; return 1; }
  echo "container answers a static file (/_boot.txt: 200)"
  want=false; [ "$OBJECT_CACHE" = apcu ] && want=true
  while :; do
    cur=$(c1_info /_store-info current)
    [ "${cur%% *}" = true ] && break
    [ $((SECONDS - t0)) -lt "${CHECK_WAIT:-600}" ] || { echo "the Store object is not from this deploy after ${CHECK_WAIT:-600} s (current do worker: $cur)" >&2; return 1; }
    sleep 15
  done
  echo "Store object is from this deploy after $((SECONDS - t0)) s ($cur)"
  for try in 1 2; do
    got=$(c1_info "/_stats.php?what=info" drop_in); got=${got%% *}
    # The image: PHP-FPM (fpm-fcgi) since issue #99. A container that answers
    # cli-server runs an older image (php -S), which can happen right after a
    # deploy; it is stopped like a container with old settings.
    sapi=$(c1_info "/_stats.php?what=info" sapi); sapi=${sapi%% *}
    if [ "$got" = "$want" ] && [ "$sapi" = fpm-fcgi ]; then
      echo "container settings ok on try $try (object cache drop-in: $got, PHP: $sapi)"
      # Only now, with this deploy's container: nginx answers static files
      # while PHP is stuck (issue #99), and the FPM ping needs a free PHP-FPM
      # child. Probed before this point, it could reach the previous container
      # (php -S has no ping, so WordPress answered with a 301) and fail a good
      # deploy (seen 2026-11-06, arm 3b).
      code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$URL/_fpm-ping" || true)
      [ "$code" = 200 ] || { echo "PHP does not answer (/_fpm-ping: $code): probably stuck (issue #93)" >&2; return 1; }
      echo "PHP answers (/_fpm-ping: 200)"
      return 0
    fi
    echo "try $try: drop-in $got (want $want, OBJECT_CACHE=$OBJECT_CACHE), PHP $sapi (want fpm-fcgi): the container is older than the object; stop it" >&2
    [ "$try" = 2 ] && break
    # The stop answers still_running true when the container did not stop in
    # 30 s; then the object is not reset (durability), and the check fails.
    if curl -s -m 60 -X POST -K <(printf 'header = "x-spike-token: %s"\n' "$SPIKE_TOKEN") "$URL/_store-stop" | grep -q '"still_running":true'; then
      echo "the container did not stop in 30 s; the Store object was not reset" >&2; return 1
    fi
    START_TIMEOUT=300 c1_up > /dev/null || return 1
  done
  echo "the container does not have this deploy's settings" >&2
  return 1
}

# e2e.sh, uncached page times, then one cold start: stop the container and time
# until a new container restored the database and answers. _boot.txt holds an
# id that each container start writes, so a new id proves a new container.
c1_measure() {
  local stamp res w e2e_exit=0 boot0 b t0 cold=null
  log "measure"
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  res="$ROOT/deploy/results/$NAME-$stamp.json"
  w=$(mktemp -d)
  SPIKE_TOKEN=$SPIKE_TOKEN ADMIN_PASSWORD=$ADMIN_PASSWORD "$ROOT/spikes/b2-wordpress/e2e.sh" "$URL" > "$w/e2e" 2>&1 || e2e_exit=$?
  B=$URL ADMIN_PASSWORD=$ADMIN_PASSWORD N=${N:-10} python3 "$ROOT/tests/a/bench.py" > "$w/bench" 2>&1 || true
  boot0=$(curl -s -m 30 "$URL/_boot.txt" || true)
  curl -s -m 60 -X POST -K <(printf 'header = "x-spike-token: %s"\n' "$SPIKE_TOKEN") "$URL/_store-stop" > /dev/null || true
  t0=$SECONDS
  while [ $((SECONDS - t0)) -lt 300 ]; do
    b=$(curl -s -m 120 "$URL/_boot.txt" || true)
    if [ -n "$b" ] && [ "$b" != "$boot0" ] && [ ${#b} -eq 36 ]; then
      if START_TIMEOUT=300 c1_up > /dev/null; then cold=$((SECONDS - t0)); fi
      break
    fi
    sleep 2
  done
  printf '{"instance_type": "%s", "php_workers": %s, "object_cache": "%s", "replica_path": "%s", "queue_runner": "%s", "idle_seconds": %s, "first_start_s": %s, "cold_start_s": %s}\n' \
    "$INSTANCE_TYPE" "$PHP_WORKERS" "$OBJECT_CACHE" "$REPLICA_PATH" "$QUEUE_RUNNER" "$IDLE_SECONDS" "${FIRST_START_S:-null}" "$cold" > "$w/extra"
  VARIANT=c1 python3 "$ROOT/deploy/summarize.py" "$res" "$NAME" "$URL" "$LOCATION" "$e2e_exit" "$w"
  rm -rf "$w"
}

c1_main() {
  c1_build
  c1_config
  c1_deploy
  c1_wait
  c1_check
  [ "${BENCH:-1}" = 0 ] || c1_measure
  echo "$URL  (admin; password: cd deploy/terraform && terraform workspace select $NAME && terraform output -raw admin_password)"
}
