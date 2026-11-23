#!/usr/bin/env python3
"""A throwaway Vultr box for a heavy job, with a one-shot creds handoff (#1327). Stdlib only.

  box.py create  <run> <job-script> [--creds]   make the firewall (one sentinel rule: no inbound), then the box
  box.py release <run> <creds-file>             put the creds at the box's ONE presigned GET, wait for its read marker,
                                                delete them, read back 404 (a HEAD that still finds them FAILS)
  box.py status  <run>                          the box's markers in R2 (started, creds-read, done, FAILED)
  box.py fetch   <run> <out-dir>                download the box's outputs
  box.py destroy <run>                          delete the instance, then the firewall; read both back gone

The job script runs as root on Ubuntu 24.04 from cloud-init. It writes its outputs to /root/out/ (each file there is PUT
to R2 at the end) and may read /root/creds.env (present only with --creds, after release). The user-data carries ONLY
presigned urls: build_userdata refuses it if any creds value, or its base64, is in it (the user-data stays readable from
the Vultr API and the instance metadata for the box's whole life).

Environment: VULTR_API_KEY; BOX_CREDS_FILE (every value is checked against the user-data) and BOX_PUBLIC_KEYS (names of
its keys that are identifiers, exempt; #1405); BOX_R2_ENDPOINT, BOX_R2_BUCKET, BOX_R2_KEY_ID, BOX_R2_SECRET (an R2 S3 key for the results
bucket); BOX_REGION (lax), BOX_PLAN (vhf-3c-8gb). State (ids) goes to $BOX_STATE_DIR (default ~/scratch/box/<run>).
"""
import base64, json, os, sys, time, urllib.error, urllib.parse, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import presign as _presign  # noqa: E402

PREFIX = "box/"  # results and markers live under <bucket>/box/<run>/
MARKERS = ("started", "creds-read", "done", "FAILED")


class SecretInUserData(Exception):
    """A creds value (or its base64) is in the user-data. The message never repeats the value."""


class S3:
    """R2 by presigned urls only: the key never leaves this process; every request is a presigned url."""
    def __init__(self, endpoint, bucket, key_id, secret):
        self.ep, self.bucket, self.kid, self.sec = endpoint, bucket, key_id, secret

    def presign(self, method, key, expires_s):
        return _presign.presign(method, self.ep, self.bucket, key, self.kid, self.sec, expires_s)

    def _do(self, method, key, data=None):
        r = urllib.request.Request(self.presign(method, key, 300), data=data, method=method)
        try:
            with urllib.request.urlopen(r, timeout=120) as x:
                return x.status, x.read()
        except urllib.error.HTTPError as e:
            return e.code, b""

    def put(self, key, data): return self._do("PUT", key, data)[0]
    def get(self, key): return self._do("GET", key)
    def delete(self, key): return self._do("DELETE", key)[0]
    def head(self, key): return self._do("HEAD", key)[0]


def build_userdata(job_script, puts, get, secrets, outputs_note=True):
    """The cloud-init script: mark started, (if get) poll the presigned GET for creds.env, run the job, PUT /root/out/*.
    puts: {name: presigned PUT url} (markers and output files); get: the presigned GET for the creds, or None."""
    puts_decl = " ".join("[%s]=%s" % (n, _sh(u)) for n, u in sorted(puts.items()))
    lines = [
        "#!/bin/bash",
        "# deploy/box user-data (#1327): presigned urls only, no credential.",
        "exec > /root/box.log 2>&1",
        "# cloud-init runs user-data with no HOME; a set -u job that reads it would stop (#1405).",
        "export HOME=/root",
        "declare -A PUT=( %s )" % puts_decl,
        'put() { [ -n "${PUT[$2]:-}" ] || { echo "no put url for $2"; return 0; }; curl -fsS --retry 3 -T "$1" "${PUT[$2]}" > /dev/null || echo "put failed: $2"; }',
        'mark() { date -u +%FT%TZ > /root/.m; put /root/.m "$1"; }',
        "mkdir -p /root/out; mark started",
    ]
    if get:
        lines += [
            "GET_CREDS=%s" % _sh(get),
            'for i in $(seq 1 240); do curl -fsS -o /root/creds.env "$GET_CREDS" 2>/dev/null && [ -s /root/creds.env ] && break; rm -f /root/creds.env; sleep 15; done',
            '[ -s /root/creds.env ] || { echo "no creds.env"; mark FAILED; put /root/box.log box.log; exit 1; }',
            "chmod 600 /root/creds.env; mark creds-read",
        ]
    lines += [
        "echo %s | base64 -d > /root/job.sh" % _sh(base64.b64encode(job_script.encode()).decode()),
        "bash /root/job.sh; rc=$?; echo \"job rc $rc\"",
        "rm -f /root/creds.env",
        'for f in /root/out/*; do [ -f "$f" ] && put "$f" "out/$(basename "$f")"; done',
        "put /root/box.log box.log",
        '[ "$rc" = 0 ] && mark done || mark FAILED',
    ]
    ud = "\n".join(lines) + "\n"
    hay = ud + "\n" + job_script  # the job script rides base64-encoded, so read it in clear too
    for v in secrets:
        v = str(v)
        if len(v) < 6:
            continue
        b64 = base64.b64encode(v.encode()).decode()
        if v in hay or b64.rstrip("=") in hay:
            raise SecretInUserData("a creds value is in the user-data (refused; the creds go only by the presigned GET)")
    return ud


def _sh(s):
    return "'" + str(s).replace("'", "'\\''") + "'"


def release(st, run, creds_bytes, wait_s=3600, poll_s=15, _skip_delete_for_test=False):
    """Put the creds at <run>/creds.env, wait for <run>/creds-read, then delete the creds and read back 404.
    The creds are deleted whether or not the box read them. ok only when read AND the HEAD after is 404."""
    k = "%s/creds.env" % run
    out = {"put": st.put(k, creds_bytes), "read": False}
    end = time.time() + wait_s
    while time.time() < end:
        if st.head("%s/creds-read" % run) == 200:
            out["read"] = True
            break
        time.sleep(poll_s)
    if not _skip_delete_for_test:
        out["delete"] = st.delete(k)
    out["head_after"] = st.head(k)
    out["ok"] = out["read"] and out["head_after"] == 404
    return out


class Vultr:
    def __init__(self, key, base="https://api.vultr.com/v2"):
        self.key, self.base = key, base

    def call(self, method, path, body=None):
        r = urllib.request.Request(self.base + path, data=None if body is None else json.dumps(body).encode(), method=method,
                                   headers={"Authorization": "Bearer " + self.key, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(r, timeout=60) as x:
                b = x.read().decode()
                return x.status, (json.loads(b) if b.strip() else {})
        except urllib.error.HTTPError as e:
            return e.code, {}


def create(api, label, user_data, region, plan, os_id=2284, v6_wait_s=60, v6_poll_s=5):
    st, plans = api.call("GET", "/plans?type=all&per_page=500")
    p = next((x for x in plans.get("plans") or [] if x.get("id") == plan), None)
    if st != 200 or not p or region not in (p.get("locations") or []):
        raise SystemExit("plan %s is not offered in %s now (GET /plans: %s); read /regions/%s/availability before concluding why" % (plan, region, st, region))
    st, fw = api.call("POST", "/firewalls", {"description": label + " sentinel"})
    if st not in (200, 201):
        raise SystemExit("firewall create: HTTP %s" % st)
    fwid = fw["firewall_group"]["id"]
    # One rule that admits nothing real (an empty Vultr firewall group allows everything).
    api.call("POST", "/firewalls/%s/rules" % fwid, {"ip_type": "v4", "protocol": "tcp", "subnet": "192.0.2.1", "subnet_size": 32, "port": "1", "notes": "sentinel"})
    _, rules = api.call("GET", "/firewalls/%s/rules" % fwid)
    if len(rules.get("firewall_rules") or []) != 1:
        api.call("DELETE", "/firewalls/" + fwid)
        raise SystemExit("the sentinel rule did not read back; the firewall is deleted and no box was made")
    st, inst = api.call("POST", "/instances", {"region": region, "plan": plan, "os_id": os_id, "label": label, "hostname": label,
                                               "firewall_group_id": fwid, "backups": "disabled", "tags": [label], "enable_ipv6": False,
                                               "user_data": base64.b64encode(user_data.encode()).decode()})
    if st not in (200, 201, 202):
        api.call("DELETE", "/firewalls/" + fwid)
        raise SystemExit("instance create: HTTP %s (the firewall is deleted)" % st)
    iid = inst["instance"]["id"]
    # The sentinel rule is IPv4. No inbound must hold on IPv6 too, so the box gets no v6 address at all: asked for above
    # (enable_ipv6 false) and read back here. A box that has one is destroyed before it can matter.
    v6 = None
    for _ in range(int(v6_wait_s / max(v6_poll_s, 0.01)) + 1):
        st, b = api.call("GET", "/instances/" + iid)
        if st == 200 and "v6_main_ip" in (b.get("instance") or {}):
            v6 = (b["instance"].get("v6_main_ip") or "").strip()
            break
        time.sleep(v6_poll_s)
    if v6 is None or (v6 and v6 != "::"):
        d = destroy(api, iid, fwid, settle_s=v6_poll_s)
        raise SystemExit("the box %s an IPv6 address (%s); it is destroyed (ok=%s) and the run stops"
                         % ("has" if v6 else "did not report", "v6_main_ip set" if v6 else "no read-back", d["ok"]))
    return {"instance": iid, "firewall": fwid, "hourly_usd": p.get("hourly_cost"), "v6_main_ip": v6 or ""}


def destroy(api, instance_id, firewall_id, settle_s=20):
    out = {"instance_delete": api.call("DELETE", "/instances/" + instance_id)[0] if instance_id else None}
    time.sleep(settle_s)  # Vultr detaches the firewall from a deleted instance a few seconds later
    out["firewall_delete"] = api.call("DELETE", "/firewalls/" + firewall_id)[0] if firewall_id else None
    _, i = api.call("GET", "/instances?per_page=500")
    _, f = api.call("GET", "/firewalls?per_page=500")
    out["instance_left"] = any(x.get("id") == instance_id for x in i.get("instances") or [])
    out["firewall_left"] = any(x.get("id") == firewall_id for x in f.get("firewall_groups") or [])
    out["ok"] = not out["instance_left"] and not out["firewall_left"]
    return out


def _env_s3():
    e = os.environ
    return S3(e["BOX_R2_ENDPOINT"], e["BOX_R2_BUCKET"], e["BOX_R2_KEY_ID"], e["BOX_R2_SECRET"])


def _state(run):
    d = os.environ.get("BOX_STATE_DIR") or os.path.expanduser("~/scratch/box/" + run)
    os.makedirs(d, mode=0o700, exist_ok=True)
    return d


def creds_values(path, public=""):
    """The values of a creds file that the user-data check must refuse, and the public keys it did not find.
    Fail closed: every value is checked, unless its key is named in `public` (BOX_PUBLIC_KEYS: space-separated names of
    known identifiers, such as MYSQL_USER MYSQL_DATABASE ACCOUNT_ID MYSQL_HOST). No name pattern decides it, because a
    secret can sit under any name (a DATABASE_URL with a password in it). Returns (values, listed keys absent from the file)."""
    pub = set(public.split())
    vals, seen = [], set()
    for line in open(path):
        line = line.strip()
        if line.startswith("export "):
            line = line[7:].lstrip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            k = k.strip(); seen.add(k)
            if k not in pub:
                vals.append(v.strip().strip("'\""))
    return vals, sorted(pub - seen)


def main(argv):
    if len(argv) < 3:
        print(__doc__, file=sys.stderr); return 2
    cmd, run = argv[1], argv[2]
    if not run.replace("-", "").isalnum():
        print("run must be letters, digits and dashes", file=sys.stderr); return 2
    st, d, key = _env_s3(), _state(run), "%s%s" % (PREFIX, run)
    if cmd == "create":
        job = open(argv[3]).read(); want_creds = "--creds" in argv[4:]
        exp = 6 * 86400 - 60
        names = list(MARKERS) + ["box.log"] + ["out/" + n for n in os.environ.get("BOX_OUTPUTS", "").split() if n]
        puts = {n: st.presign("PUT", "%s/%s" % (key, n), exp) for n in names}
        get = st.presign("GET", "%s/creds.env" % key, exp) if want_creds else None
        creds_vals = []
        if os.environ.get("BOX_CREDS_FILE"):
            creds_vals, absent = creds_values(os.environ["BOX_CREDS_FILE"], os.environ.get("BOX_PUBLIC_KEYS", ""))
            if absent:
                print("note: BOX_PUBLIC_KEYS names %s, not in BOX_CREDS_FILE" % " ".join(absent), file=sys.stderr)
        secrets = [os.environ["BOX_R2_SECRET"], os.environ["VULTR_API_KEY"]] + creds_vals
        ud = build_userdata(job, puts, get, secrets)
        r = create(Vultr(os.environ["VULTR_API_KEY"]), "pfbox-" + run, ud, os.environ.get("BOX_REGION", "lax"), os.environ.get("BOX_PLAN", "vhf-3c-8gb"))
        json.dump(r, open(os.path.join(d, "ids.json"), "w"))
        print("created", r, "user-data bytes", len(ud)); return 0
    if cmd == "release":
        r = release(st, key, open(argv[3], "rb").read())
        print("release", {k: v for k, v in r.items()}); return 0 if r["ok"] else 1
    if cmd == "status":
        for m in MARKERS: print(m, st.head("%s/%s" % (key, m)) == 200)
        return 0
    if cmd == "fetch":
        od = argv[3]; os.makedirs(od, exist_ok=True)
        for n in ["box.log"] + ["out/" + x for x in os.environ.get("BOX_OUTPUTS", "").split() if x]:
            code, body = st.get("%s/%s" % (key, n))
            if code == 200: open(os.path.join(od, n.replace("/", "_")), "wb").write(body)
            print(n, code)
        return 0
    if cmd == "destroy":
        ids = json.load(open(os.path.join(d, "ids.json")))
        r = destroy(Vultr(os.environ["VULTR_API_KEY"]), ids["instance"], ids["firewall"])
        print("destroy", r); return 0 if r["ok"] else 1
    print(__doc__, file=sys.stderr); return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
