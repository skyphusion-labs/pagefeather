#!/usr/bin/env python3
"""A temporary R2 credential for ONE bucket, minted from the deploy token (#273).

    r2_temp.py mint <bucket> <ttl seconds> <out file>

`site down`, `site remove` and `site import` with CONTENT need a key that reaches only the site's
media bucket. They made it as a Cloudflare account token (cloudflare_account_token), which needs
API Tokens edit, and Cloudflare refuses that permission on a token minted from another token
(error 1001): an operator who minted the deploy token through the API could not run those steps.
R2's temporary credentials need no token edit: POST /accounts/{id}/r2/temp-access-credentials with
the deploy token as the parent. The R2 docs: "A temporary credential is bound to exactly one
bucket" and "cannot exceed the permissions of its parent token". Measured 2026-11-14 with a token
that has R2 Storage Write and no API Tokens permission: the mint succeeded, the credential could
PUT, list, GET and DELETE in its bucket, and another bucket answered 403 to a list and a PUT.

The parent is the deploy token's own id (tokens/verify), which is also its S3 access key id (the
R2 docs; snapshot.py derives it the same way). The permission is object-read-write. <out file> is
written mode 600, atomically, as shell lines R2_KEY_ID, R2_SECRET and R2_SESSION_TOKEN, for
deploy/variants/r2-empty.sh and deploy/import/media.sh (R2_CRED_FILE). No value is printed.
A temporary credential cannot be revoked on its own (only by revoking its parent), so the TTL is
also the time it keeps working after the step: keep it short, and mint again on a refusal.

Environment: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (or ACCOUNT_ID). For tests: WFP_API.
Exit 0 on a credential written, 1 on a refusal or an error, 2 on bad arguments.
"""
import json
import os
import re
import shlex
import sys
import tempfile
import time
import urllib.error
import urllib.request

sys.dont_write_bytecode = True  # no __pycache__: it would make the tree dirty (#377)
BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$")
TTL_MIN, TTL_MAX = 60, 604800  # the API's maximum is 7 days; 60 s is our floor, not Cloudflare's


def base():
    acct = os.environ.get("CLOUDFLARE_ACCOUNT_ID") or os.environ.get("ACCOUNT_ID") or ""
    return os.environ.get("WFP_API") or "https://api.cloudflare.com/client/v4/accounts/" + acct


def call(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"], "Content-Type": "application/json",
        "User-Agent": "pagefeather-wfp-r2-temp"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.load(e)
        except ValueError:
            return e.code, {}
    except (OSError, ValueError) as e:
        return 0, {"errors": [{"code": 0, "message": str(e)[:120]}]}


def codes(d):
    return [(e.get("code"), str(e.get("message", ""))[:120]) for e in (d or {}).get("errors") or []]


def token_id():
    """The deploy token's id: the account path for an account token, else the user path."""
    st, d = call("GET", base() + "/tokens/verify")
    tid = ((d or {}).get("result") or {}).get("id") if st == 200 else None
    if not tid and not os.environ.get("WFP_API"):
        st2, d2 = call("GET", "https://api.cloudflare.com/client/v4/user/tokens/verify")
        tid = ((d2 or {}).get("result") or {}).get("id") if st2 == 200 else None
        if not tid:
            print("r2 temp: cannot read the token id (tokens/verify: HTTP %s, then %s %s)" % (st, st2, codes(d2)), file=sys.stderr)
            return None
    if not tid:
        print("r2 temp: cannot read the token id (tokens/verify: HTTP %s %s)" % (st, codes(d)), file=sys.stderr)
    return tid


def write_creds(path, r):
    vals = {"R2_KEY_ID": r.get("accessKeyId"), "R2_SECRET": r.get("secretAccessKey"), "R2_SESSION_TOKEN": r.get("sessionToken")}
    for k, v in vals.items():
        if not isinstance(v, str) or not v or "\n" in v or "\0" in v:
            print("r2 temp: the mint answered no usable %s" % k, file=sys.stderr)
            return False
    d = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix=".r2-temp-", dir=d)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as fh:
            for k, v in vals.items():
                fh.write("%s=%s\n" % (k, shlex.quote(v)))
        os.replace(tmp, path)
    except OSError as e:
        print("r2 temp: cannot write %s: %s" % (path, e), file=sys.stderr)
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return False
    return True


def mint(bucket, ttl, out):
    tid = token_id()
    if not tid:
        return 1
    # The mint answers no expiry, so it is the time just BEFORE the request plus the TTL: the real
    # expiry is at or after the time logged, never before it.
    t0 = time.time()
    st, d = call("POST", base() + "/r2/temp-access-credentials", {
        "bucket": bucket, "parentAccessKeyId": tid, "permission": "object-read-write", "ttlSeconds": ttl})
    if st != 200 or not (d or {}).get("success"):
        print("r2 temp: the mint for %s was refused (HTTP %s %s). The deploy token needs R2 Storage Write." % (bucket, st, codes(d)), file=sys.stderr)
        return 1
    if not write_creds(out, (d.get("result") or {})):
        return 1
    print("r2 temp: a credential for %s only (object-read-write, %d s, expires %s UTC or later) is in %s"
          % (bucket, ttl, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t0 + ttl)), out))
    return 0


def main(argv):
    if len(argv) != 5 or argv[1] != "mint":
        print(__doc__, file=sys.stderr)
        return 2
    bucket, ttl_s, out = argv[2], argv[3], argv[4]
    if not BUCKET_RE.match(bucket):
        print("r2 temp: %r is not a bucket name" % bucket, file=sys.stderr)
        return 2
    if not ttl_s.isdigit() or not TTL_MIN <= int(ttl_s) <= TTL_MAX:
        print("r2 temp: the TTL must be %d to %d seconds, not %r" % (TTL_MIN, TTL_MAX, ttl_s), file=sys.stderr)
        return 2
    if not os.environ.get("CLOUDFLARE_API_TOKEN"):
        print("r2 temp: set CLOUDFLARE_API_TOKEN (the deploy token)", file=sys.stderr)
        return 2
    return mint(bucket, int(ttl_s), out)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
