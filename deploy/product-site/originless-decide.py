#!/usr/bin/env python3
# Decide what ensure_originless should do for one type+name.
# Stdin: Cloudflare DNS list envelope ({"result":[...]}).
# Env: WANT_CONTENT (exact originless target, e.g. 192.0.2.1 or 100::).
# Prints one line: ok | create | patch <id> | fail <ids>
# Exit 0 always (the shell maps fail to exit 1).
import json
import os
import sys

want = os.environ["WANT_CONTENT"]
recs = json.load(sys.stdin).get("result") or []
good = [r for r in recs if r.get("proxied") is True and r.get("content") == want]
if good:
    print("ok")
    sys.exit(0)
if len(recs) == 0:
    print("create")
    sys.exit(0)
if len(recs) == 1:
    print("patch %s" % recs[0]["id"])
    sys.exit(0)
print("fail %s" % ",".join(r.get("id") or "?" for r in recs))
