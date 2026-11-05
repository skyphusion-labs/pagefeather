#!/usr/bin/env python3
"""Deactivate every plugin on a site through the REST API (keep=slug,... stays on).

HostlessWP bundles only the plugins that are active on the source site when it
deploys, so its sites are deployed with all suite plugins active and turned off
here, at runtime, before the core-only checks. The files stay in the bundle.
Usage: B=<url> ADMIN_PASSWORD=... python3 tests/a/plugins-off.py [keep-slug ...]
"""
import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "spikes", "b2-wordpress", "tests"))
import break_lib as L

keep = set(sys.argv[1:])
o = L.login()
r = L.rest(o, "/wp/v2/plugins")
plugins = json.loads(r["body"])
for p in plugins:
    slug = p["plugin"].split("/")[0]
    if p["status"] == "active" and slug not in keep:
        x = L.rest(o, "/wp/v2/plugins/" + p["plugin"], {"status": "inactive"})
        print(slug, x["code"])
left = [p["plugin"] for p in json.loads(L.rest(o, "/wp/v2/plugins")["body"]) if p["status"] == "active"]
print("active now:", left)
