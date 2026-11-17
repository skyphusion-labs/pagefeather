#!/usr/bin/env python3
"""Our replacements for upstream specs that cannot run on a deployed site (#759), in the runner's results format.

    gaps.py run --base-url https://<throwaway> --out results-gaps-<on|off>.json
    gaps.py baseline --out baseline-gaps.json

fatal-error-handler (wordpress-develop tests/e2e/specs, excluded in exclude/wp.txt): upstream writes a mu-plugin
"<?php new NonExistentClass();" on the RUNNER's disk and expects WordPress's handler page, "There has been a
critical error on this website". Our throwaway build ships php/pf-conformance-gaps.php (prepare-content.sh), which
runs that same line only on ?pf_conformance=fatal, and only beside the throwaway marker. This asks whether a PHP
fatal on our runtime reaches WP_Fatal_Error_Handler, or ends the runtime as a bare 500, and whether the site then
serves the next request.

Three rows (file "pf/fatal-error-handler"): the site serves normally without the trigger (a control: the plugin
fires only on its parameter), the fatal shows the handler page with HTTP 500, and the next request is served.
"Fatal error:" (the PHP message, shown only with display_errors on, as in wp-env) is reported on the row, never a
failure on its own. Every request carries a fresh pf_n, so the page cache cannot answer it.

The baseline is the outcome the upstream spec asserts, written as runner.py summarize rows (all expected), so
matrix.py compares the same way it compares a suite. It refuses a site without the throwaway marker, exactly as
runner.py prepare does, and sends no trigger to it. A failing check is a RESULT (exit 0); a refusal is a STOP (3).
"""
import argparse, json, os, sys, uuid
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import runner

FILE = "pf/fatal-error-handler"
T_CONTROL = "Fatal error handler > the site serves normally without the trigger"
T_FATAL = "Fatal error handler > should display fatal error notice (HTTP 500, the handler page)"
T_AFTER = "Fatal error handler > the site serves the next request"
HANDLER = "There has been a critical error on this website"


def _row(title, good, **extra):
    return dict({"file": FILE, "title": title, "project": "gaps", "status": "expected" if good else "unexpected"}, **extra)


def _get(site, path):
    sep = "&" if "?" in path else "?"
    st, h, b = site.req("GET", "%s%spf_n=%s" % (path, sep, uuid.uuid4().hex[:12]), cookies=False, keep_path=True)
    return st, b.decode("utf-8", "replace")


def check(base):
    site = runner.Site(base)
    runner.check_target(site, None)
    rows = []
    st, b = _get(site, "/")
    rows.append(_row(T_CONTROL, st == 200 and HANDLER not in b, http=st))
    st, b = _get(site, "/?pf_conformance=fatal")
    rows.append(_row(T_FATAL, st == 500 and HANDLER in b, http=st, handler=HANDLER in b, fatal_text="Fatal error" in b))
    st, b = _get(site, "/")
    rows.append(_row(T_AFTER, st == 200 and HANDLER not in b, http=st))
    for r in rows:
        print("@event gap %s" % json.dumps({k: r[k] for k in r if k not in ("project",)}, sort_keys=True))
    return rows


def baseline_rows():
    return [_row(t, True) for t in (T_CONTROL, T_FATAL, T_AFTER)]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("run"); p.add_argument("--base-url", required=True); p.add_argument("--out", required=True)
    p = sub.add_parser("baseline"); p.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    try:
        rows = check(a.base_url) if a.cmd == "run" else baseline_rows()
    except runner.Stop as e:
        print("STOP: %s" % e, file=sys.stderr)
        return 3
    with open(a.out, "w") as f:
        json.dump(rows, f, indent=1)
    bad = sum(1 for r in rows if r["status"] != "expected")
    print("gaps %s: %d rows, %d unexpected" % (a.cmd, len(rows), bad))
    return 0


if __name__ == "__main__":
    sys.exit(main())
