#!/usr/bin/env python3
# WordPress's own upload decision for every fixture of engine/fileinfo/fixtures.py (#582 S2b): log in as
# admin, POST each file to the REST media endpoint, record the answer. Run it once per engine; compare
# the two records with tests/upload-sniff-compare.py.
#   B=http://localhost:8797 ADMIN_PASSWORD=... python3 tests/upload-sniff.py <fixtures-dir> <out.json>
import json, mimetypes, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from break_lib import login, rest

fx, out = sys.argv[1], sys.argv[2]
man = json.load(open(os.path.join(fx, 'manifest.json')))
o = login()
res = {}
for m in man:
    data = open(os.path.join(fx, m['file']), 'rb').read()
    ctype = mimetypes.guess_type(m['file'])[0] or 'application/octet-stream'  # what a browser sends
    r = rest(o, '/wp/v2/media', raw=data, method='POST', headers={'Content-Type': ctype, 'Content-Disposition': 'attachment; filename="%s"' % m['file']})
    try:
        body = json.loads(r['body'] or b'{}')
    except ValueError:
        body = {}
    code = body.get('code') if isinstance(body, dict) else None
    res[m['file']] = {'http': r['code'], 'accepted': r['code'] == 201, 'code': code, 'mime': body.get('mime_type') if isinstance(body, dict) else None}
    print('%-18s %-10s %s %s' % (m['file'], m['class'], r['code'], code or res[m['file']]['mime'] or ''))
json.dump(res, open(out, 'w'), indent=1)
print('upload-sniff.py: %d uploads, %d accepted' % (len(res), sum(1 for v in res.values() if v['accepted'])))
