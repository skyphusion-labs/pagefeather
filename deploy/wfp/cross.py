#!/usr/bin/env python3
"""Decide the slice 4 isolation verdicts from the attacker's probe responses
(issue #35). isolation.sh runs the live side; this module's verdict() is the
decision, tested offline in tests/cross-test.py.

verdict(probe, b, a_bindings) -> list of {test, result, reason}, where
result is one of:
  pass            A is isolated from B, as the docs say
  our-defect      A reached B THROUGH a binding we gave A (our configuration;
                  fixed in the open)
  platform        A reached B with NO such binding, or a limit was not
                  enforced against the docs: a possible Cloudflare platform
                  isolation gap. The caller sends it to the lead ONLY, puts it
                  in no public artifact, does not retry, and stops.
  inconclusive    a probe could not be read (never counted as pass)

probe: the attacker's JSON per endpoint (r2, r2_fetch, do, secret, cpu, sub).
b: B's known markers {"bucket_key", "do_marker", "wp_salt_hash"}.
a_bindings: the binding names A holds (from bindings.py), to tell our-defect
from a platform gap: a reach is our-defect only when A holds a binding to B.
"""


def _err(x):
    return not isinstance(x, dict) or "error" in x or x.get("status") == 500


def verdict(probe, b, a_bindings):
    out = []
    has_b_bucket = any("wp-wfp-%s-media" % b["site"] in x for x in a_bindings)
    has_b_do = any("script_name=site-%s" % b["site"] in x for x in a_bindings)

    # 1. R2: A's own list must not contain B's key.
    r = probe.get("r2")
    if _err(r) or "keys" not in r:
        out.append({"test": "r2", "result": "inconclusive", "reason": "A's bucket list unreadable: %s" % r})
    elif b["bucket_key"] in r["keys"]:
        out.append({"test": "r2", "result": "our-defect" if has_b_bucket else "platform",
                    "reason": "A's MEDIA list contains B's object %s" % b["bucket_key"]})
    else:
        out.append({"test": "r2", "result": "pass", "reason": "A's MEDIA list has only its own keys: %s" % r["keys"]})

    # 1b. A fetch() to B's bucket URL must not return B's bytes.
    rf = probe.get("r2_fetch")
    if _err(rf) or "status" not in rf:
        out.append({"test": "r2_fetch", "result": "inconclusive", "reason": "the fetch probe unreadable: %s" % rf})
    elif rf["status"] == 200 and rf.get("bytes", 0) > 0:
        out.append({"test": "r2_fetch", "result": "platform", "reason": "a fetch() to B's bucket returned %s bytes" % rf["bytes"]})
    else:
        out.append({"test": "r2_fetch", "result": "pass", "reason": "a fetch() to B's bucket did not return bytes (HTTP %s)" % rf["status"]})

    # 2. Durable Object: A's marker must not be B's.
    d = probe.get("do")
    if _err(d) or "marker" not in d:
        out.append({"test": "do", "result": "inconclusive", "reason": "A's object unreadable: %s" % d})
    elif d["marker"] == b["do_marker"]:
        out.append({"test": "do", "result": "our-defect" if has_b_do else "platform",
                    "reason": "A's object marker equals B's (%s): they share an object" % d["marker"]})
    else:
        out.append({"test": "do", "result": "pass", "reason": "A's object is its own (marker %s, not B's)" % d["marker"]})

    # 3. Secrets: A's salt must not be B's, and A must see no foreign secret name.
    s = probe.get("secret")
    if _err(s) or "wp_salt_hash" not in s:
        out.append({"test": "secret", "result": "inconclusive", "reason": "A's env unreadable: %s" % s})
    elif s["wp_salt_hash"] == b["wp_salt_hash"]:
        out.append({"test": "secret", "result": "platform", "reason": "A's WP_SALT hash equals B's: A sees B's secret"})
    else:
        out.append({"test": "secret", "result": "pass", "reason": "A's WP_SALT is its own; env names: %s" % s.get("env_names")})

    # 4. Limits: subRequests exact; cpuMs enforced (inexact below ~2 s).
    sub = probe.get("sub")
    if sub is None or "ok" not in (sub if isinstance(sub, dict) else {}):
        out.append({"test": "sub", "result": "inconclusive", "reason": "the subrequest probe unreadable: %s" % sub})
    elif sub["ok"] >= sub["requested"] and sub["requested"] > probe.get("sub_limit", 0):
        out.append({"test": "sub", "result": "platform", "reason": "A made all %s subrequests past the limit %s" % (sub["requested"], probe.get("sub_limit"))})
    else:
        out.append({"test": "sub", "result": "pass", "reason": "A was cut at %s of %s subrequests (limit %s)" % (sub["ok"], sub["requested"], probe.get("sub_limit"))})

    cpu = probe.get("cpu")
    limit = probe.get("cpu_limit_ms", 0)
    if cpu is None:
        out.append({"test": "cpu", "result": "inconclusive", "reason": "the cpu probe unreadable: %s" % cpu})
    elif not _err(cpu) and limit and limit >= 2000 and cpu.get("ms", 0) > limit * 3:
        out.append({"test": "cpu", "result": "platform", "reason": "A ran %s ms of CPU, far past the limit %s" % (cpu.get("ms"), limit)})
    else:
        reached = cpu.get("ms") if isinstance(cpu, dict) else None
        out.append({"test": "cpu", "result": "pass", "reason": "A was cut by cpuMs=%s (reached %s ms, error %s); cpuMs is inexact below ~2 s (docs/wfp.md item 4)" % (limit, reached, cpu.get("error") if isinstance(cpu, dict) else cpu)})
    return out


def summarize(results):
    order = {"platform": 0, "our-defect": 1, "inconclusive": 2, "pass": 3}
    worst = min((r["result"] for r in results), key=lambda x: order[x], default="pass")
    return worst, results
