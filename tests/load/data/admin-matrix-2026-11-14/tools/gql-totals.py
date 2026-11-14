"""Totals per status from the lead's raw GraphQL files (workersInvocationsAdaptive and
durableObjectsInvocationsAdaptiveGroups). Prints per file: dataset -> {status: requests}."""
import json, glob, collections, sys, os
d = sys.argv[1]
for f in sorted(glob.glob(os.path.join(d, "*.json"))):
    j = json.load(open(f))
    out = {}
    def scan(o, path):
        if isinstance(o, dict):
            for k, v in o.items():
                if isinstance(v, list) and v and isinstance(v[0], dict) and ("dimensions" in v[0] or "sum" in v[0]):
                    c = collections.Counter()
                    for row in v:
                        dims = row.get("dimensions", {})
                        st = dims.get("status") or dims.get("outcome") or "?"
                        s = row.get("sum", {})
                        n = s.get("requests") if "requests" in s else s.get("count", row.get("count", 0))
                        c[st] += n or 0
                    out[k] = dict(c)
                else:
                    scan(v, path + "/" + k)
        elif isinstance(o, list):
            for x in o:
                scan(x, path)
    scan(j.get("data"), "")
    print(os.path.basename(f), j.get("_label"), j.get("_read_at"), json.dumps(out))
    print("   query vars:", json.dumps(j.get("_query", {}).get("variables", {}) if isinstance(j.get("_query"), dict) else "?")[:300])
