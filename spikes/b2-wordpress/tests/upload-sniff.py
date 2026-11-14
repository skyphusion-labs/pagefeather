#!/usr/bin/env python3
# WordPress's own upload decision for every fixture of engine/fileinfo/fixtures.py (#582 S2b): log in as
# admin, POST each file to the REST media endpoint (fonts: the Font Library's font-faces endpoint, the path
# core accepts fonts on), record the answer. Run it once per engine; compare
# the two records with tests/upload-sniff-compare.py.
#   B=http://localhost:8797 ADMIN_PASSWORD=... python3 tests/upload-sniff.py <fixtures-dir> <out.json>
import json, mimetypes, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from break_lib import login, rest

fx, out = sys.argv[1], sys.argv[2]
man = json.load(open(os.path.join(fx, 'manifest.json')))
o = login()
res = {}
family = None
def font_face(fname, data):
    # Core takes fonts through the Font Library: a font family, then a font face whose src names the
    # multipart file field (the REST font-faces controller).
    global family
    if family is None:
        r = rest(o, '/wp/v2/font-families', {'font_family_settings': json.dumps({'name': 'Sniff Test', 'slug': 'sniff-test-%d' % os.getpid(), 'fontFamily': 'Sniff Test'})}, method='POST')
        assert r['code'] == 201, ('font family', r['code'], r['body'][:200])
        family = json.loads(r['body'])['id']
    bnd = 'pfsniff%d' % os.getpid()
    parts = [('--%s\r\nContent-Disposition: form-data; name="font_face_settings"\r\n\r\n%s\r\n' % (bnd, json.dumps({'fontFamily': 'Sniff Test', 'src': 'file-0'}))).encode(),
             ('--%s\r\nContent-Disposition: form-data; name="file-0"; filename="%s"\r\nContent-Type: application/octet-stream\r\n\r\n' % (bnd, fname)).encode() + data + b'\r\n',
             ('--%s--\r\n' % bnd).encode()]
    return rest(o, '/wp/v2/font-families/%d/font-faces' % family, raw=b''.join(parts), method='POST', headers={'Content-Type': 'multipart/form-data; boundary=' + bnd})
for m in man:
    data = open(os.path.join(fx, m['file']), 'rb').read()
    ctype = mimetypes.guess_type(m['file'])[0] or 'application/octet-stream'  # what a browser sends
    if m.get('path') == 'font-library':
        r = font_face(m['file'], data)
    else:
        r = rest(o, '/wp/v2/media', raw=data, method='POST', headers={'Content-Type': ctype, 'Content-Disposition': 'attachment; filename="%s"' % m['file']})
    try:
        body = json.loads(r['body'] or b'{}')
    except ValueError:
        body = {}
    code = body.get('code') if isinstance(body, dict) else None
    head = None if r['code'] == 201 else (r['body'] or b'')[:200].decode('utf-8', 'replace').replace('\n', ' ')
    # Local dev shows PHP warnings (WP_DEBUG, php/wp-config.php; a deploy sets display_errors 0). A warning
    # printed before the JSON sends the headers with 200 before the REST controller can set 201, and the
    # attachment's JSON follows the warning text. That upload was ACCEPTED: count it, and flag it.
    raw = (r['body'] or b'').decode('utf-8', 'replace')
    att = None
    if r['code'] != 201 and '{"id":' in raw:
        try:
            j, _ = json.JSONDecoder().raw_decode(raw[raw.index('{"id":'):])
            att = j.get('id') if isinstance(j, dict) and j.get('source_url') else None
            body = j
        except ValueError:
            att = None
    warned = r['code'] != 201 and att is not None
    code = body.get('code') if isinstance(body, dict) else None
    res[m['file']] = {'http': r['code'], 'accepted': r['code'] == 201 or warned, 'warnings_in_body': warned, 'attachment': att,
                      'code': code, 'mime': body.get('mime_type') if isinstance(body, dict) else None, 'head': head}
    print('%-18s %-10s %s %s %s' % (m['file'], m['class'], r['code'], code or res[m['file']]['mime'] or '', (head or '')[:80]))
json.dump(res, open(out, 'w'), indent=1)
print('upload-sniff.py: %d uploads, %d accepted (%d of them answered 200 with PHP warnings before the JSON)' % (len(res), sum(1 for v in res.values() if v['accepted']), sum(1 for v in res.values() if v['warnings_in_body'])))
