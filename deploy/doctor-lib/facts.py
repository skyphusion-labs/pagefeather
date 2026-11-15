"""doctor facts (#652): what Workers Logs can tell about one site, as plain data. READ-ONLY.

Every value here comes from a Cloudflare API read. Nothing here writes. The wording lives in
words.py, so a new wording never changes a fact.

Rules this file keeps (issue #652):
  - A read that fails is "could not measure" (None), never zero.
  - Zero rows is "cannot see this site", never healthy.
  - Console lines only (OBSERVABILITY=1): failures cannot be counted, so no failure count is made.
  - The runtime line "Durable Object's isolate exceeded its memory limit and was reset." is not one
    line per failed request. Memory resets are a yes or no, never a number.
  - No query string, SQL text, client IP or token is ever kept. A row keeps the URL PATH only.

Every count and percentile comes from the calculations view: the server computes it over the whole
window in one call, so it is complete by construction (measured 2026-11-15: the invocations view
returns at most 100 invocations a call, and reading a busy hour row by row took over 10 minutes).
Rows are fetched only for the few examples doctor prints, and they are called examples.

Our JSON console lines (measured 2026-11-15): $metadata.message is null, and the fields are in the
returned row's source object. A FILTER or GROUP names a field by its bare key ("m", "kind", "event");
"source.m" as a filter key reads 0 (php-lock on pfa-sb1114l: "m" 4,751, "source.m" 0).

The token is read from CLOUDFLARE_API_TOKEN in this process and sent in a header. It is never on argv.
"""
import json
import time
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATASET = "cloudflare-workers"
OUTCOMES = ("ok", "exceededMemory", "exceededCpu", "exception", "canceled")
# $workers.executionModel values (measured 2026-11-15) and the name doctor uses for each.
MODELS = {"stateless": "worker", "durableObject": "durable_object"}
# Our structured console lines (spikes/b2-wordpress/index.js), by their field "m". Each one maps to the
# response header a site owner sees. One place, so the code is the record.
SIGNALS = (
    # (m value, field to split by or None, the header it matches, what the line means)
    ("isolate-reset", "kind", "x-isolate-reset", "a request died in a platform reset (memory or storage) and got a 503 or a write-loss answer"),
    ("isolate-reset-retry", "kind", "x-isolate-retry", "a GET or HEAD died in a reset and was sent once more"),
    ("overloaded", None, "x-overloaded", "the Durable Object queue was full and the request got a 503"),
    ("write-loss", None, "x-write-loss", "a write may have been saved before a reset; the user was told to check before a retry"),
    ("php-lock", "event", "x-php-lock / x-php-overflow", "requests waited for the one PHP runtime (queued, granted, shed, stale, overflow)"),
    ("boot", "origin", "x-boot", "a PHP runtime started (a cold start)"),
)
# Headers with no log line of their own. Doctor reads logs, so it says it cannot count these.
HEADER_ONLY = (
    ("x-d1-failures", "failed database statements in one request; logged only inside a write-loss line"),
)
SLOW_PATHS = 5
EXAMPLES = 5


class Api(object):
    """POST and GET to the account API. base is .../client/v4/accounts/<account id>."""

    def __init__(self, base, token):
        self.base = base.rstrip("/")
        self._token = token
        self.calls = 0

    def _req(self, method, path, body=None):
        self.calls += 1
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Authorization", "Bearer " + self._token)
        if data is not None:
            req.add_header("content-type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            return {"success": False, "status": e.code}
        except (urllib.error.URLError, OSError, ValueError) as e:
            return {"success": False, "status": None, "why": type(e).__name__}

    def query(self, body):
        d = self._req("POST", "/workers/observability/telemetry/query", body)
        if not d.get("success"):
            return None
        return d.get("result") or {}

    def get(self, path):
        return self._req("GET", path)


def _leaf(key, op, value, typ="string"):
    return {"key": key, "operation": op, "type": typ, "value": value}


def _svc(service):
    return _leaf("$metadata.service", "eq", service)


def _events(service):
    return [_svc(service), _leaf("$metadata.type", "eq", "cf-worker-event")]


def _group_of(a):
    """The group value of one aggregate: groupKey (as the live API answers), or groups[0].value."""
    if "groupKey" in a:
        return a.get("groupKey")
    g = a.get("groups") or []
    return g[0].get("value") if g and isinstance(g[0], dict) else None


def calc(api, window, filters, calcs, group_key=None, order_by=None, limit=None):
    """One calculations call. calcs is [(alias, operator, number key or None)].
    Returns {alias: {group: {"value": v, "count": n}}} ("_all" when not grouped), or None when the
    read failed or the answer is not the expected shape."""
    cs = []
    for alias, op, key in calcs:
        c = {"operator": op, "alias": alias}
        if key:
            c["key"] = key
            c["keyType"] = "number"
        cs.append(c)
    params = {"datasets": [DATASET], "filters": filters, "calculations": cs}
    if group_key:
        params["groupBys"] = [{"type": "string", "value": group_key}]
    if order_by:
        params["orderBy"] = {"value": order_by, "order": "desc"}
    body = {"queryId": "doctor-calc", "timeframe": window, "view": "calculations", "parameters": params}
    if limit:
        body["limit"] = limit
    res = api.query(body)
    if res is None:
        return None
    got = res.get("calculations") or []
    out = dict((a, {}) for a, _, _ in calcs)
    for i, c in enumerate(got):
        alias = c.get("alias") or (calcs[i][0] if i < len(calcs) and len(got) == len(calcs) else None)
        if alias not in out:
            return None
        for a in c.get("aggregates") or []:
            k = _group_of(a) if group_key else "_all"
            if k is None:
                continue
            try:
                v = a.get("value")
                v = None if v is None else float(v)
                n = int(a["count"]) if a.get("count") is not None else None
            except (TypeError, ValueError):
                return None
            out[alias][str(k)] = {"value": v, "count": n}
    return out


def count_by(api, window, filters, group_key):
    """{group value: count}, or None when the read failed."""
    d = calc(api, window, filters, [("n", "count", None)], group_key)
    if d is None:
        return None
    return dict((k, int(v["value"] or 0)) for k, v in d["n"].items())


def count(api, window, filters):
    d = count_by(api, window, filters, None)
    return None if d is None else sum(d.values())


def candidates(site):
    """Service names to try, in order. deploy/wfp names the user Worker site-<name> (lib.sh
    user_script); deploy.sh names it after NAME (often wp-<name>). A full name is tried as given."""
    out = []
    for n in (site, "site-" + site, "wp-" + site):
        if n not in out:
            out.append(n)
    if site.startswith("site-") or site.startswith("wp-"):
        out = [site] + [n for n in out if n != site]
    return out


def resolve(api, window, site, forced=None):
    """Count rows per candidate name, split by row type. Pick the name with the most rows."""
    names = [forced] if forced else candidates(site)
    tried = []
    for n in names:
        by = count_by(api, window, [_svc(n)], "$metadata.type")
        tried.append({"service": n, "rows": None if by is None else sum(by.values()), "by_type": by})
    seen = [t for t in tried if t["rows"]]
    best = max(seen, key=lambda t: t["rows"]) if seen else None
    return best, tried


def settings_for(api, service, namespace):
    """The script's observability settings, read through deploy/wfp/obs_settings.py's path rule.
    {'read': False} when the read failed: never taken as off."""
    sys.path.insert(0, os.path.join(HERE, "..", "wfp"))
    import obs_settings  # noqa: E402  (reused for its settings path, #652 item 7)
    ns = namespace if service.startswith("site-") else "-"
    d = api.get(obs_settings.settings_path(ns, service))
    if not d.get("success"):
        return {"read": False, "namespace": ns}
    obs = (d.get("result") or {}).get("observability")
    if obs is None:
        return {"read": True, "namespace": ns, "enabled": False, "invocation_logs": False, "redact_query_string": None}
    logs = obs.get("logs") or {}
    return {"read": True, "namespace": ns, "enabled": obs.get("enabled") is True,
            "invocation_logs": logs.get("invocation_logs") is True,
            "redact_query_string": obs.get("redact_query_string")}


def _path_only(url):
    if not isinstance(url, str) or not url:
        return None
    try:
        p = urllib.parse.urlsplit(url).path
    except ValueError:
        return None
    return p or "/"


TIMING = [("cpu_p50", "median", "$workers.cpuTimeMs"), ("cpu_p95", "p95", "$workers.cpuTimeMs"),
          ("wall_p50", "median", "$workers.wallTimeMs"), ("wall_p95", "p95", "$workers.wallTimeMs")]


def timing(api, window, service):
    """CPU and wall p50 and p95 per execution model, computed by the server over every request
    record in the window. {model: {"requests", "cpu_ms": {p50, p95}, "wall_ms": {p50, p95}}} or None."""
    d = calc(api, window, _events(service), TIMING, "$workers.executionModel")
    if d is None:
        return None
    out = {}
    for model in sorted(set(k for a in d.values() for k in a)):
        name = MODELS.get(model, model)
        g = lambda a: (d[a].get(model) or {})
        ns = [g(a).get("count") for a, _, _ in TIMING if g(a).get("count") is not None]
        out[name] = {"requests": max(ns) if ns else None,
                     "cpu_ms": {"p50": g("cpu_p50").get("value"), "p95": g("cpu_p95").get("value")},
                     "wall_ms": {"p50": g("wall_p50").get("value"), "p95": g("wall_p95").get("value")}}
    return out


def outcomes_by_model(api, window, service, models):
    out = {}
    for model, name in MODELS.items():
        if name not in models:
            continue
        oc = count_by(api, window, _events(service) + [_leaf("$workers.executionModel", "eq", model)], "$workers.outcome")
        out[name] = oc
    return out


def slowest_paths(api, window, service):
    """The paths with the highest p95 wall time, from the server, or None when it cannot group so."""
    d = calc(api, window, _events(service), [("wall_p95", "p95", "$workers.wallTimeMs")],
             "$workers.event.path", order_by="wall_p95", limit=SLOW_PATHS)
    if d is None:
        return None
    rows = []
    for k, v in d["wall_p95"].items():
        p = _path_only(k)
        if p:
            rows.append({"path": p, "requests": v["count"], "wall_ms_p95": v["value"]})
    rows.sort(key=lambda r: -(r["wall_ms_p95"] or 0))
    return rows[:SLOW_PATHS]


def failure_examples(api, window, service):
    """A few failed requests, newest first, to print as EXAMPLES. One invocations call."""
    res = api.query({"queryId": "doctor-examples", "timeframe": window, "view": "invocations", "limit": EXAMPLES,
                     "parameters": {"datasets": [DATASET], "filters": _events(service) + [_leaf("$workers.outcome", "neq", "ok")]}})
    if res is None:
        return None
    out = []
    for evs in (res.get("invocations") or {}).values():
        for e in evs or []:
            m = e.get("$metadata") or {}
            w = e.get("$workers") or {}
            if m.get("type") != "cf-worker-event" or w.get("outcome") in (None, "ok"):
                continue
            ev = w.get("event") or {}
            path = ev.get("path") if isinstance(ev.get("path"), str) else (ev.get("request") or {}).get("url")
            out.append({"t": e.get("timestamp"), "outcome": w.get("outcome"),
                        "where": MODELS.get(w.get("executionModel"), w.get("executionModel")),
                        "path": _path_only(path), "wall_ms": w.get("wallTimeMs"),
                        "status": (ev.get("response") or {}).get("status")})
    out.sort(key=lambda r: -(r["t"] or 0))
    return out[:EXAMPLES]


def signals(api, window, service):
    """Counts of our own structured lines. The control first: if no line carries the field "m", the
    counts below cannot be read (a wrong key reads zero), so every signal is None, not 0."""
    base = [_svc(service), _leaf("$metadata.type", "eq", "cf-worker")]
    control = count(api, window, base + [_leaf("m", "exists", "")])
    out = {"structured_lines": control, "field_key": "m" if control else None, "items": []}
    for m, split, header, meaning in SIGNALS:
        item = {"m": m, "header": header, "meaning": meaning, "count": None, "split": None}
        if control:
            if split:
                by = count_by(api, window, base + [_leaf("m", "eq", m)], split)
                if by is not None:
                    item["count"] = sum(by.values())
                    item["split"] = by
            else:
                item["count"] = count(api, window, base + [_leaf("m", "eq", m)])
        out["items"].append(item)
    out["header_only"] = [{"header": h, "meaning": t} for h, t in HEADER_ONLY]
    return out


def gather(api, site, window, namespace="wp-wfp", forced=None):
    facts = {"site": site, "window": window, "complete": True}
    best, tried = resolve(api, window, site, forced)
    facts["tried"] = tried
    facts["read_failed"] = any(t["rows"] is None for t in tried)
    if best is None:
        facts["service"] = None
        facts["visibility"] = "cannot_see"
        # Settings of the name the site would have, to say WHY: logging off, or a quiet window.
        guess = forced or ("site-" + site if not site.startswith(("site-", "wp-")) else site)
        facts["settings"] = settings_for(api, guess, namespace)
        facts["settings_of"] = guess
        return facts
    svc = best["service"]
    facts["service"] = svc
    facts["settings"] = settings_for(api, svc, namespace)
    facts["settings_of"] = svc
    by = best["by_type"] or {}
    facts["console_lines"] = by.get("cf-worker", 0)
    facts["event_rows"] = by.get("cf-worker-event", 0)
    facts["visibility"] = "outcomes" if facts["event_rows"] else "console_only"
    facts["outcomes"] = facts["timing"] = facts["outcomes_by_model"] = facts["slowest_paths"] = facts["examples"] = None
    if facts["event_rows"]:
        oc = count_by(api, window, _events(svc), "$workers.outcome")
        facts["outcomes"] = None if oc is None else dict((k, oc.get(k, 0)) for k in sorted(set(OUTCOMES) | set(oc)))
        facts["timing"] = timing(api, window, svc)
        if facts["timing"] is not None:
            facts["outcomes_by_model"] = outcomes_by_model(api, window, svc, facts["timing"])
        facts["slowest_paths"] = slowest_paths(api, window, svc)
        if facts["outcomes"] and any(v for k, v in facts["outcomes"].items() if k != "ok"):
            facts["examples"] = failure_examples(api, window, svc)
        if facts["outcomes"] is None or facts["timing"] is None:
            facts["complete"] = False
    facts["signals"] = signals(api, window, svc)
    # Memory resets: yes, no, or unknown. Never a count of the runtime's reset line (#652 item 6), and
    # never a message substring: the answer comes from outcomes and our own reset lines (kind memory).
    def kind_memory(m):
        it = next((i for i in facts["signals"]["items"] if i["m"] == m), {})
        return None if it.get("split") is None else it["split"].get("memory", 0)
    em = (facts.get("outcomes") or {}).get("exceededMemory") if facts.get("outcomes") is not None else None
    known = [x for x in (em, kind_memory("isolate-reset"), kind_memory("isolate-reset-retry")) if x is not None]
    facts["memory_resets_seen"] = (any(x > 0 for x in known)) if known else None
    return facts


def window_ms(hours, now_ms=None):
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    return {"from": now - int(hours * 3600 * 1000), "to": now}
