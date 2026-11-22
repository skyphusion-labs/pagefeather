#!/usr/bin/env python3
"""The alarm reproduction record (#291, #390), READ-ONLY. Cloudflare support (case 02430361, 2026-11-16) asked, if
an alarm fault recurs, for: the object id, the getAlarm() value, the UTC time the alarm was set, and the matching
analytics rows. This prints those four for one site, plus the site map's limits against what a cron tick spends
(support: the namespace's cpuMs and subRequests limits apply to alarm invocations).

  CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... SPIKE_TOKEN=<the site's> \\
    [WFP_KV_ID=<the site map's KV namespace id> HOSTNAME=<the site's map key>] \\
    python3 -I deploy/wfp/alarm-record.py <site name> <base url> [hours, default 2] [--rows]

The invocation rows are summarized by type and status; --rows prints every alarm and non-success row too.

Reads only: GET <base>/_purgestate (the site's object: getAlarm(), alarmSet, alarmFatal, cronRun), GET of the account's Durable Object
namespaces (to find site-<name>'s), GraphQL durableObjectsInvocationsAdaptiveGroups (by that namespace id) and
durableObjectsPeriodicGroups, and GET of the site map entry. Writes nothing anywhere. Each section prints one `@event <name> {json}` line; a section that could
not be read prints `@event <name> {"could_not_measure": ...}`, never a guess. Test: deploy/wfp/tests/alarm-record-test.py.
"""
import datetime as D
import json
import os
import sys
import urllib.error
import urllib.request

# The invocations are filtered by the object's NAMESPACE id, not scriptName: a kind a site's rows carry scriptName
# "__unknown__" (alarm and http alike; live, 2026-11-22, pfcw1), so a scriptName filter found none of them.
GQL_INV = """query($a: String!, $s: Time!, $e: Time!, $n: String!) { viewer { accounts(filter: {accountTag: $a}) {
  inv: durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: {datetime_geq: $s, datetime_lt: $e, namespaceId: $n}, orderBy: [datetimeMinute_ASC]) {
    sum { requests errors wallTime } dimensions { datetimeMinute type status objectId } } } } }"""
# durableObjectsPeriodicGroups has no scriptName filter (live, 2026-11-16: "unknown arg scriptName"); it is filtered by
# the object ids the invocation query found.
GQL_CPU = """query($a: String!, $s: Time!, $e: Time!, $o: [String!]) { viewer { accounts(filter: {accountTag: $a}) {
  cpu: durableObjectsPeriodicGroups(limit: 10000, filter: {datetimeMinute_geq: $s, datetimeMinute_lt: $e, objectId_in: $o}, orderBy: [datetimeMinute_ASC]) {
    sum { cpuTime } dimensions { datetimeMinute objectId } } } } }"""


def utc(ms):
    """Epoch milliseconds to an ISO UTC string; None stays None."""
    if ms is None:
        return None
    return D.datetime.fromtimestamp(int(ms) / 1000, D.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def do_namespace_id(namespaces, script):
    """The id of script's PhpRuntime Durable Object namespace, from GET /workers/durable_objects/namespaces; None when
    the account lists none for it (could not measure, never another site's)."""
    for n in namespaces or []:
        if n.get("script") == script and n.get("class") == "PhpRuntime":
            return n.get("id")
    return None


def alarm_only_minutes(inv_rows, cpu_rows):
    """The CPU of minutes whose ONLY object invocations were alarms (a cron tick with no request beside it), per
    object and minute: [{minute, objectId, cpu_ms, alarms}]. cpuTime is in microseconds."""
    kinds = {}
    for r in inv_rows:
        d = r["dimensions"]
        k = (d["datetimeMinute"], d["objectId"])
        kinds.setdefault(k, {"alarm": 0, "other": 0})["alarm" if d["type"] == "alarm" else "other"] += r["sum"]["requests"]
    out = []
    for r in cpu_rows:
        d = r["dimensions"]
        k = (d["datetimeMinute"], d["objectId"])
        c = kinds.get(k)
        if c and c["alarm"] > 0 and c["other"] == 0:
            out.append({"minute": d["datetimeMinute"], "objectId": d["objectId"], "cpu_ms": round(r["sum"]["cpuTime"] / 1000, 1), "alarms": c["alarm"]})
    return out


def verdict(cpu_ms_limit, ticks):
    """Is the map's cpuMs below what a cron tick spends? None limit: unset (the platform default applies)."""
    if not ticks:
        return {"verdict": "could not measure: no minute with only alarm invocations in the window"}
    worst = max(t["cpu_ms"] / max(t["alarms"], 1) for t in ticks)
    if cpu_ms_limit is None:
        return {"verdict": "no cpuMs in the map entry", "worst_tick_cpu_ms": worst}
    return {"verdict": "BELOW a tick: a #291 cause" if cpu_ms_limit < worst else "above every measured tick",
            "cpuMs": cpu_ms_limit, "worst_tick_cpu_ms": worst, "headroom_ms": round(cpu_ms_limit - worst, 1)}


# A client with no User-Agent is refused at Cloudflare's edge on these hosts (error code 1010, a browser-signature
# block: live, 2026-11-16), before the site sees the token. seed.py sends its own for the same reason.
UA = {"User-Agent": "pagefeather-alarm-record"}


def summarize(inv_rows):
    """Invocations per (type, status): {"alarm/success": {"requests": n, "errors": n}, ...}."""
    out = {}
    for r in inv_rows:
        d = r["dimensions"]
        k = "%s/%s" % (d["type"], d["status"])
        t = out.setdefault(k, {"requests": 0, "errors": 0})
        t["requests"] += r["sum"].get("requests", 0); t["errors"] += r["sum"].get("errors", 0)
    return out


def classify_403(body):
    """Which layer refused /_purgestate: the site (index.js answers 'forbidden': missing or wrong SPIKE_TOKEN) or
    Cloudflare's edge (error code 1010: the client's signature), or something else."""
    b = (body or b"").decode("utf-8", "replace").strip()
    if b == "forbidden":
        return "the site refused the token (index.js: x-spike-token missing or not this site's SPIKE_TOKEN)"
    if "1010" in b:
        return "Cloudflare's edge refused the client (error code 1010, browser signature), before the site; the token was not checked"
    return "an unknown 403: " + b[:80]


def event(name, obj):
    print("@event %s %s" % (name, json.dumps(obj, sort_keys=True)))
    sys.stdout.flush()


def http_json(url, headers=None, data=None, timeout=60):
    req = urllib.request.Request(url, data=data, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def gql(q, variables, tok):
    d = http_json("https://api.cloudflare.com/client/v4/graphql", {"Authorization": "Bearer " + tok, "Content-Type": "application/json"},
                  json.dumps({"query": q, "variables": variables}).encode())
    if d.get("errors"):
        raise RuntimeError(json.dumps(d["errors"])[:400])
    rows = []
    for acc in d["data"]["viewer"]["accounts"]:
        for v in acc.values():
            rows += v
    return rows


def main(argv):
    rows_flag = "--rows" in argv
    argv = [a for a in argv if a != "--rows"]
    if len(argv) < 3:
        sys.exit(__doc__)
    site, base = argv[1], argv[2].rstrip("/")
    hours = float(argv[3]) if len(argv) > 3 else 2.0
    script = "site-" + site
    now = D.datetime.now(D.timezone.utc).replace(microsecond=0)
    start = now - D.timedelta(hours=hours)
    event("window", {"site": site, "script": script, "from": start.isoformat().replace("+00:00", "Z"), "to": now.isoformat().replace("+00:00", "Z")})
    # 2 and 3: getAlarm() and when it was set, from the object itself.
    try:
        ps = http_json(base + "/_purgestate", {"x-spike-token": os.environ["SPIKE_TOKEN"]})
        st = ps.get("alarmSet") or None
        event("alarm", {"now": utc(ps.get("now")), "getAlarm": utc(ps.get("alarm")),
                        "set": ({"at": utc(st.get("at")), "setAt": utc(st.get("setAt")), "by": st.get("by")} if st else
                                "not recorded (a build from before alarmSet, #291)"),
                        "alarmFatal": ps.get("alarmFatal"), "cronRun": ps.get("cronRun")})
    except urllib.error.HTTPError as e:
        event("alarm", {"could_not_measure": "HTTP %s" % e.code, "why": classify_403(e.read()) if e.code == 403 else None})
    except Exception as e:  # noqa: BLE001 (a read that failed is reported, never guessed)
        event("alarm", {"could_not_measure": str(e)[:300]})
    # 1 and 4: the object id and the analytics rows.
    tok, acct = os.environ.get("CLOUDFLARE_API_TOKEN", ""), os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    v = {"a": acct, "s": start.isoformat().replace("+00:00", "Z"), "e": now.isoformat().replace("+00:00", "Z")}
    inv = cpu = None
    try:
        nsl = http_json("https://api.cloudflare.com/client/v4/accounts/%s/workers/durable_objects/namespaces?per_page=1000" % acct,
                        {"Authorization": "Bearer " + tok}).get("result")
        v["n"] = do_namespace_id(nsl, script)
        if not v["n"]:
            raise RuntimeError("no PhpRuntime Durable Object namespace for %s among %d listed" % (script, len(nsl or [])))
        inv = gql(GQL_INV, v, tok)
        event("objects", {"namespaceId": v["n"], "objectIds": sorted({r["dimensions"]["objectId"] for r in inv if r["dimensions"]["objectId"]})})
        event("invocations", summarize(inv))
        for r in (inv if rows_flag else []):
            d = r["dimensions"]
            if d["type"] == "alarm" or d["status"] != "success":
                event("invocation", {"minute": d["datetimeMinute"], "type": d["type"], "status": d["status"], "objectId": d["objectId"],
                                     "requests": r["sum"]["requests"], "errors": r["sum"]["errors"], "wall_ms": round(r["sum"]["wallTime"] / 1000, 1)})
    except Exception as e:  # noqa: BLE001
        event("objects", {"could_not_measure": str(e)[:300]})
    try:
        ids = sorted({r["dimensions"]["objectId"] for r in (inv or []) if r["dimensions"]["objectId"]})
        if not ids:
            raise RuntimeError("no object id from the invocation query")
        cpu = gql(GQL_CPU, {"a": v["a"], "s": v["s"], "e": v["e"], "o": ids}, tok)
    except Exception as e:  # noqa: BLE001
        event("tick_cpu", {"could_not_measure": "durableObjectsPeriodicGroups: " + str(e)[:300]})
    ticks = alarm_only_minutes(inv, cpu) if inv is not None and cpu is not None else []
    if cpu is not None:
        event("tick_cpu", {"alarm_only_minutes": ticks})
    # The map's limits (support: they apply to alarm invocations).
    limit = None
    kv, host = os.environ.get("WFP_KV_ID", ""), os.environ.get("HOSTNAME", "")
    if kv and host:
        try:
            entry = http_json("https://api.cloudflare.com/client/v4/accounts/%s/storage/kv/namespaces/%s/values/%s" % (acct, kv, host),
                              {"Authorization": "Bearer " + tok})
            limit = entry.get("cpuMs")
            event("map", {"hostname": host, "cpuMs": limit, "subRequests": entry.get("subRequests"), "script": entry.get("script")})
        except Exception as e:  # noqa: BLE001
            event("map", {"could_not_measure": str(e)[:300]})
    else:
        event("map", {"could_not_measure": "WFP_KV_ID and HOSTNAME not set"})
    if cpu is not None:
        event("cpu_verdict", verdict(limit, ticks))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
