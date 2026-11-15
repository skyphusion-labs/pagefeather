#!/usr/bin/env python3
"""doctor (#652): tell a site owner, in plain English, what Workers Logs show about one site.

    deploy/doctor <site> [--hours N] [--service NAME] [--namespace NS] [--json]

READ-ONLY. It reads the Workers Logs query API and the script's log settings. It changes nothing.
Needs CLOUDFLARE_API_TOKEN and ACCOUNT_ID (or CLOUDFLARE_ACCOUNT_ID) in the environment. The token
stays in this process; it is sent in a header, never on a command line.

Exit: 0 no failures found; 1 problems found; 3 cannot see the site, cannot count failures, or a read failed;
2 a usage or environment error.
"""
import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import facts  # noqa: E402
import words  # noqa: E402

# The last guard before anything is printed (#652 item 7). facts.py keeps paths only, so this should
# never fire. If it does, the text is hidden, not printed.
_QUERY = re.compile(r"\?[^\s\"']*")
_IPV4 = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_IPV6 = re.compile(r"\b(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}\b")
_SQL = re.compile(r"\b(?:SELECT\s.+?\sFROM|INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|REPLACE\s+INTO)\b[^\n\"]*", re.I)
_BEARER = re.compile(r"Bearer\s+\S+", re.I)


def scrub(text, secrets):
    for s in secrets:
        if s and len(s) >= 8:
            text = text.replace(s, "[hidden]")
    for rx in (_BEARER, _SQL, _QUERY, _IPV6, _IPV4):
        text = rx.sub("[hidden]", text)
    return text


def main(argv):
    ap = argparse.ArgumentParser(prog="doctor", description="Read-only health report for one site, from Workers Logs.")
    ap.add_argument("site")
    ap.add_argument("--hours", type=float, default=24.0, help="how far back to read (default 24)")
    ap.add_argument("--service", help="the exact Worker name in the logs, when the guess is wrong")
    ap.add_argument("--namespace", default=os.environ.get("NAMESPACE") or "wp-wfp", help="the WfP dispatch namespace (default wp-wfp)")
    ap.add_argument("--json", action="store_true", help="print the facts as JSON, for tools")
    a = ap.parse_args(argv)
    if not (0 < a.hours <= 24 * 7):
        print("doctor: --hours must be more than 0 and at most 168", file=sys.stderr)
        return 2
    tok = os.environ.get("CLOUDFLARE_API_TOKEN") or ""
    acct = os.environ.get("ACCOUNT_ID") or os.environ.get("CLOUDFLARE_ACCOUNT_ID") or ""
    if not tok or not acct:
        print("doctor: set CLOUDFLARE_API_TOKEN and ACCOUNT_ID in the environment", file=sys.stderr)
        return 2
    base = os.environ.get("DOCTOR_API_BASE") or ("https://api.cloudflare.com/client/v4/accounts/" + acct)
    api = facts.Api(base, tok)
    now = os.environ.get("DOCTOR_NOW_MS")  # tests only: a fixed clock
    f = facts.gather(api, a.site, facts.window_ms(a.hours, int(now) if now else None), a.namespace, a.service)
    f["api_calls"] = api.calls
    v = words.verdict(f)
    f["verdict"] = v
    out = json.dumps(f, indent=2, sort_keys=True) + "\n" if a.json else words.render(f)
    sys.stdout.write(scrub(out, [tok]))
    return {"healthy": 0, "problems": 1}.get(v, 3)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
