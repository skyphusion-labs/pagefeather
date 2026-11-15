"""doctor facts (#652): what Workers Logs can tell about one site, as plain data. READ-ONLY.

Every value here comes from a Cloudflare API read. Nothing here writes. The wording lives in
words.py, so a new wording never changes a fact.

Rules this file keeps (issue #652):
  - A read that fails is "could not measure" (None), never zero.
  - Zero rows is "cannot see this site", never healthy.
  - Console lines only (OBSERVABILITY=1): failures cannot be counted, so no failure count is made.
  - The runtime line "Durable Object's isolate exceeded its memory limit and was reset." is not one
    line per failed request. It becomes a yes or no, never a number.
  - No query string, SQL text, client IP or token is ever kept. A row keeps the URL PATH only.

The token is read from CLOUDFLARE_API_TOKEN in this process and sent in a header. It is never on argv.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATASET = "cloudflare-workers"
OUTCOMES = ("ok", "exceededMemory", "exceededCpu", "exception", "canceled")
# Our structured console lines (spikes/b2-wordpress/index.js). The key is the field "m" of the JSON
# line. Each one maps to the response header a site owner sees. One place, so the code is the record.
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
PAGE_LIMIT = 100  # the invocations view returns at most 100 invocations a call (measured 2026-11-15)
MAX_SLICE_CALLS = 1500  # the budget of the sliced read; past it the read is marked NOT complete


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


def count_by(api, window, filters, group_key):
    """{group value: count} from the calculations view, or None when the read failed."""
    body = {"queryId": "doctor-count", "timeframe": window, "view": "calculations",
            "parameters": {"datasets": [DATASET], "filters": filters,
                           "calculations": [{"operator": "count"}]}}
    if group_key:
        body["parameters"]["groupBys"] = [{"type": "string", "value": group_key}]
    res = api.query(body)
    if res is None:
        return None
    out = {}
    for c in res.get("calculations") or []:
        for a in c.get("aggregates") or []:
            k = a.get("groupKey")
            if not group_key or k is None:
                k = "_all"
            try:
                out[str(k)] = out.get(str(k), 0) + int(a.get("value") or 0)
            except (TypeError, ValueError):
                return None
    return out


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


def _event_row(e):
    m = e.get("$metadata") or {}
    w = e.get("$workers") or {}
    ev = w.get("event") or {}
    path = ev.get("path") if isinstance(ev.get("path"), str) else None
    return {
        "t": e.get("timestamp"),
        "outcome": w.get("outcome"),
        "cpu_ms": w.get("cpuTimeMs"),
        "wall_ms": w.get("wallTimeMs"),
        "type": w.get("eventType"),
        "entrypoint": w.get("entrypoint"),
        "where": "durable_object" if (w.get("durableObjectId") or (w.get("entrypoint") not in (None, "", "default"))) else "worker",
        "path": _path_only(path) if path else _path_only((ev.get("request") or {}).get("url")),
        "status": (ev.get("response") or {}).get("status"),
    }


def invocation_rows(api, window, service):
    """Every cf-worker-event row in the window, by splitting the time window (measured 2026-11-15:
    the invocations view returns at most PAGE_LIMIT invocations a call, and paging by moving the
    window end read 1,666 of 3,771). A slice is read whole only when it returns fewer than
    PAGE_LIMIT invocations AND as many request records as the calculations view counts in it.
    Otherwise it is split in two. Returns (rows, complete): complete is False when a slice could
    not be read whole (more than a page in one millisecond, a failed read, or the call budget)."""
    rows = {}
    state = {"complete": True, "calls": 0}
    ev_type = [_svc(service), _leaf("$metadata.type", "eq", "cf-worker-event")]

    def read(t0, t1):
        if state["calls"] >= MAX_SLICE_CALLS:
            state["complete"] = False
            return
        state["calls"] += 2
        want = count(api, {"from": t0, "to": t1}, ev_type)
        if want is None:
            state["complete"] = False
            return
        if want == 0:
            return
        res = api.query({"queryId": "doctor-rows", "timeframe": {"from": t0, "to": t1},
                         "view": "invocations", "limit": PAGE_LIMIT,
                         "parameters": {"datasets": [DATASET], "filters": [_svc(service)]}})
        if res is None:
            state["complete"] = False
            return
        inv = res.get("invocations") or {}
        evs = [e for v in inv.values() for e in (v or []) if (e.get("$metadata") or {}).get("type") == "cf-worker-event"]
        if len(inv) >= PAGE_LIMIT or len(evs) < want:
            if t1 - t0 >= 1:
                mid = (t0 + t1) // 2
                read(t0, mid)
                read(mid + 1, t1)
                return
            state["complete"] = False  # one millisecond holds more than a page: keep what came back
        for e in evs:
            m = e.get("$metadata") or {}
            w = e.get("$workers") or {}
            rows[(m.get("requestId"), w.get("eventType"), w.get("entrypoint"), e.get("timestamp"))] = _event_row(e)

    read(window["from"], window["to"])
    return list(rows.values()), state["complete"]


def _pct(vals, p):
    v = sorted(x for x in vals if isinstance(x, (int, float)))
    if not v:
        return None
    i = min(len(v) - 1, max(0, int(round(p / 100.0 * len(v) + 0.5)) - 1))
    return v[i]


def summarize_rows(rows):
    out = {}
    for where in ("worker", "durable_object"):
        rs = [r for r in rows if r["where"] == where]
        oc = {}
        for r in rs:
            k = r["outcome"] or "unknown"
            oc[k] = oc.get(k, 0) + 1
        out[where] = {"rows": len(rs), "outcomes": oc,
                      "cpu_ms": {"p50": _pct([r["cpu_ms"] for r in rs], 50), "p95": _pct([r["cpu_ms"] for r in rs], 95)},
                      "wall_ms": {"p50": _pct([r["wall_ms"] for r in rs], 50), "p95": _pct([r["wall_ms"] for r in rs], 95)}}
    by_path = {}
    for r in rows:
        if r["path"] and isinstance(r["wall_ms"], (int, float)):
            by_path.setdefault(r["path"], []).append(r["wall_ms"])
    slow = sorted(({"path": p, "requests": len(v), "wall_ms_p95": _pct(v, 95)} for p, v in by_path.items()),
                  key=lambda x: -(x["wall_ms_p95"] or 0))[:5]
    out["slowest_paths"] = slow
    return out


# A field of our JSON console lines (measured 2026-11-15): $metadata.message is null for them, and the
# fields are in the event's source object. Never a message substring. The live read at 53d04bc showed
# the filter key is the bare field name ("m" read isolate-reset-retry, write-loss and boot on pf582s),
# so it is tried first; "source.m" is the fallback, and the control picks the one that reads.
FIELD_PREFIXES = ("", "source.")


def signals(api, window, service):
    """Counts of our own structured lines. The control first: if no line carries the field "m" under
    any spelling, the counts below cannot be read (a wrong key reads zero), so every signal is None, not 0."""
    base = [_svc(service), _leaf("$metadata.type", "eq", "cf-worker")]
    control, pre = None, None
    for p in FIELD_PREFIXES:
        c = count(api, window, base + [_leaf(p + "m", "exists", "")])
        if c is not None and (control is None or c > control):
            control = c
        if c:
            pre = p
            break
    out = {"structured_lines": control, "field_key": None if pre is None else pre + "m", "items": []}
    for m, split, header, meaning in SIGNALS:
        item = {"m": m, "header": header, "meaning": meaning, "count": None, "split": None}
        if pre is not None:
            if split:
                by = count_by(api, window, base + [_leaf(pre + "m", "eq", m)], pre + split)
                if by is not None:
                    item["count"] = sum(by.values())
                    item["split"] = by
            else:
                item["count"] = count(api, window, base + [_leaf(pre + "m", "eq", m)])
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
    if facts["event_rows"]:
        oc = count_by(api, window, [_svc(svc), _leaf("$metadata.type", "eq", "cf-worker-event")], "$workers.outcome")
        facts["outcomes"] = None if oc is None else dict((k, oc.get(k, 0)) for k in sorted(set(OUTCOMES) | set(oc)))
        rows, complete = invocation_rows(api, window, svc)
        # The server's own count is the denominator: fewer rows read than it counted is not complete.
        if rows is not None and len(rows) < facts["event_rows"]:
            complete = False
        facts["sample"] = None if rows is None else {"rows": len(rows), "of": facts["event_rows"], "complete": complete, **summarize_rows(rows)}
        if rows is None or not complete:
            facts["complete"] = False
    else:
        facts["outcomes"] = None
        facts["sample"] = None
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
