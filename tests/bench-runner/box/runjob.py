#!/usr/bin/env python3
"""Run one benchmark job on the runner. bench-runner.sh calls it.

Usage: runjob.py <job.json> <result.json> <repo-dir> <job-id> <branch> [--error <text>]

The job (written by tests/bench-runner/run.sh):
  {"id": "...", "n": 10, "branch": "...",
   "targets": [{"name", "url", "admin_password", "spike_token", "variant", "location"}]}
For each target: the database ping (/_d1ping, or /_dbping?db=object for
b-dosql; none for c1, whose SQLite is on the container disk), e2e.sh and
tests/a/bench.py, then deploy/summarize.py makes one object per target, the
same shape as deploy/results/. Passwords and tokens are not in the result.
"""
import json, os, re, subprocess, sys, tempfile, time, urllib.request, uuid

job_path, res_path, repo, job_id, branch = sys.argv[1:6]
error = sys.argv[7] if len(sys.argv) > 7 and sys.argv[6] == "--error" else None
VARIANTS = {"b-do", "b-dosql", "a", "c1"}


def sh(cmd, **kw):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=30, **kw).stdout.strip()
    except Exception as e:  # metadata only: never stop the job for it
        return "unknown (%s)" % e


runner = {
    "region": os.environ.get("RUNNER_REGION"),
    "plan": os.environ.get("RUNNER_PLAN"),
    "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "branch": branch,
    "git_sha": sh(["git", "-C", repo, "rev-parse", "HEAD"]),
    "curl": sh(["curl", "--version"]).splitlines()[0] if sh(["curl", "--version"]) else "unknown",
    "python": sys.version.split()[0],
}
out = {"job": job_id, "runner": runner, "targets": []}


def ping_path(variant):
    if variant == "b-dosql":
        return "/_dbping?db=object&n=200&"
    if variant == "c1":
        return None
    return "/_d1ping?"


def check(t):
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", str(t.get("name", ""))):
        return "bad name"
    if not re.fullmatch(r"https://[a-z0-9.-]+(:[0-9]{1,5})?", str(t.get("url", ""))):
        return "bad url (https://host only)"
    if t.get("variant") not in VARIANTS:
        return "bad variant"
    if not t.get("admin_password"):
        return "no admin_password"
    return None


def run_target(t, n):
    r = {"name": t.get("name"), "url": t.get("url"), "variant": t.get("variant")}
    bad = check(t)
    if bad:
        r["error"] = bad
        return r
    url, env = t["url"], dict(os.environ)
    for k in ("R2_KEY_ID", "R2_SECRET"):  # the scripts do not need the bucket key
        env.pop(k, None)
    env.update(SPIKE_TOKEN=t.get("spike_token") or "", ADMIN_PASSWORD=t["admin_password"], B=url, N=str(n), VARIANT=t["variant"])
    w = tempfile.mkdtemp(prefix="job-")
    t0 = time.time()
    p = ping_path(t["variant"])
    if p:
        with open(os.path.join(w, "ping"), "w") as f:
            for i in range(3):
                q = urllib.request.Request(url + p + "nocache=" + uuid.uuid4().hex[:8], headers={"x-spike-token": env["SPIKE_TOKEN"], "User-Agent": "wp-on-cf-bench-runner"})
                try:
                    f.write(urllib.request.urlopen(q, timeout=120).read().decode(errors="replace").strip() + "\n")
                except Exception as e:
                    f.write("ping failed: %s\n" % repr(e)[:160])
    e2e_exit = 0
    try:
        e = subprocess.run(["bash", os.path.join(repo, "spikes/b2-wordpress/e2e.sh"), url], env=env, capture_output=True, text=True, timeout=900)
        e2e_exit = e.returncode
        open(os.path.join(w, "e2e"), "w").write(e.stdout + e.stderr)
    except subprocess.TimeoutExpired:
        e2e_exit = 124
    try:
        b = subprocess.run([sys.executable, os.path.join(repo, "tests/a/bench.py")], env=env, capture_output=True, text=True, timeout=3600)
        open(os.path.join(w, "bench"), "w").write(b.stdout + b.stderr)
    except subprocess.TimeoutExpired:
        r["bench_error"] = "bench.py did not finish in 3600 s"
    summary = os.path.join(w, "summary.json")
    s = subprocess.run([sys.executable, os.path.join(repo, "deploy/summarize.py"), summary, t["name"], url, t.get("location") or "", str(e2e_exit), w],
                       env=env, capture_output=True, text=True, timeout=60)
    if s.returncode == 0 and os.path.exists(summary):
        r.update(json.load(open(summary)))
    else:
        r["error"] = "summarize.py failed: " + (s.stderr or s.stdout)[-300:]
    r["runner_seconds"] = round(time.time() - t0, 1)
    subprocess.run(["rm", "-rf", w])
    return r


def run_load(t, load):
    r = {"name": t.get("name"), "url": t.get("url"), "variant": t.get("variant")}
    bad = check(t)
    if bad:
        r["error"] = bad
        return r
    env = dict(os.environ)
    for k in ("R2_KEY_ID", "R2_SECRET"):
        env.pop(k, None)
    levels = str(load.get("levels", "1,5,10,25,50"))
    if not re.fullmatch(r"[0-9]{1,3}(,[0-9]{1,3}){0,9}", levels) or max(int(x) for x in levels.split(",")) > 100:
        r["error"] = "bad load levels"
        return r
    secs = max(10, min(int(load.get("seconds", 60)), 300))
    buyers = max(0.0, min(float(load.get("buyers", 0.2)), 1.0))
    env.update(B=t["url"], ADMIN_PASSWORD=t["admin_password"], LEVELS=levels, SECONDS=str(secs), BUYERS=str(buyers))
    t0 = time.time()
    try:
        p = subprocess.run([sys.executable, os.path.join(repo, "tests/load/load.py")], env=env, capture_output=True, text=True,
                           timeout=len(levels.split(",")) * (secs + 120) + 300)
        last = [l for l in p.stdout.splitlines() if l.startswith("{")]
        if last:
            r["load"] = json.loads(last[-1])
        else:
            r["error"] = "load.py: " + (p.stderr or p.stdout)[-300:]
    except subprocess.TimeoutExpired:
        r["error"] = "load.py did not finish"
    r["runner_seconds"] = round(time.time() - t0, 1)
    return r


try:
    job = json.load(open(job_path))
    n = int(job.get("n") or 10)
    n = max(1, min(n, 100))
    out["n"] = n
    if error:
        out["error"] = error
    else:
        for t in job.get("targets") or []:
            print("job %s: target %s" % (job_id, t.get("name")), flush=True)
            out["targets"].append(run_load(t, job["load"]) if job.get("load") else run_target(t, n))
        if job.get("load"):
            out["load"] = job["load"]
except Exception as e:
    out["error"] = "runner: %r" % e
out["runner"]["finished_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
json.dump(out, open(res_path, "w"), indent=1)
