#!/usr/bin/env python3
# The OSS hygiene files of the pagefeather engine (#582, Conrad's ruling 2026-11-14: plain hygiene,
# no lawyer gate): LICENSES/ (one licence text per linked component), NOTICE (the PHP and Zend
# acknowledgments) and SOURCE (where the exact source is). Built from the MEASURED link inputs.
#   licenses.py <link-inputs.txt> <out-dir> [--measure]
# Fails when a traced link input matches no row of engine/licenses.tsv, or a fetched text does not
# have its pinned sha256. --measure prints each text's sha256 instead of checking it.
import hashlib, io, os, re, sys, tarfile, urllib.request

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(os.path.dirname(here))
args = [a for a in sys.argv[1:] if not a.startswith('--')]
measure = '--measure' in sys.argv
if len(args) != 2:
    sys.exit('usage: licenses.py <link-inputs.txt> <out-dir> [--measure]')
inputs = [l.strip() for l in open(args[0]) if l.strip()]
out = args[1]
rows = []
for line in open(os.path.join(root, 'engine', 'licenses.tsv'), encoding='utf-8'):
    if line.startswith('#') or not line.strip():
        continue
    f = line.rstrip('\n').split('\t')
    if len(f) != 10:
        sys.exit('licenses.tsv: a row has %d columns, not 10: %s' % (len(f), f[0]))
    rows.append(dict(zip(['out', 'component', 'version', 'spdx', 'match', 'kind', 'source', 'member', 'lines', 'sha256'], f)))

# 1. Every traced input needs a row; a row is needed when an input matches it (or it is ALWAYS).
needed, unmatched, by_input = {}, [], {}
for r in rows:
    if r['match'] == 'ALWAYS' or r['match'].startswith('(ALWAYS|'):
        needed[r['out']] = r
for p in inputs:
    hit = [r for r in rows if re.search(r['match'].replace('ALWAYS|', ''), p) and r['match'] != 'ALWAYS']
    if not hit:
        unmatched.append(p)
    for r in hit:
        needed[r['out']] = r
    by_input[p] = [r['component'] for r in hit]
if unmatched:
    sys.exit('licenses.py: no licence row for these link inputs:\n  ' + '\n  '.join(unmatched))

# 2. Fetch, cut, check, write.
cache = {}
def fetch(url):
    if url not in cache:
        req = urllib.request.Request(url, headers={'User-Agent': 'pagefeather-engine-licenses'})
        with urllib.request.urlopen(req, timeout=120) as r:
            cache[url] = r.read()
    return cache[url]
os.makedirs(os.path.join(out, 'LICENSES'), exist_ok=True)
bad = []
for name, r in sorted(needed.items()):
    if r['kind'] == 'local':
        text = open(os.path.join(root, r['source']), 'rb').read()
    elif r['kind'] == 'raw':
        text = fetch(r['source'])
    elif r['kind'] == 'tar':
        blob = fetch(r['source'])
        with tarfile.open(fileobj=io.BytesIO(blob), mode='r:*') as t:
            text = t.extractfile(t.getmember(r['member'])).read()
    else:
        sys.exit('licenses.tsv: unknown kind ' + r['kind'])
    if r['lines'] != '-':
        a, b = (int(x) for x in r['lines'].split('-'))
        text = b''.join(text.splitlines(keepends=True)[a - 1:b])
    h = hashlib.sha256(text).hexdigest()
    if measure:
        print('%s\t%s' % (name, h))
    elif h != r['sha256']:
        bad.append('%s: sha256 %s, pinned %s' % (name, h, r['sha256']))
    head = ('Component: %s\nVersion: %s\nLicence: %s\nSource: %s%s%s\n\n' % (r['component'], r['version'], r['spdx'], r['source'],
            (' (' + r['member'] + ')') if r['member'] != '-' else '', (' lines ' + r['lines']) if r['lines'] != '-' else '')).encode()
    open(os.path.join(out, 'LICENSES', name), 'wb').write(head + text)
if bad:
    sys.exit('licenses.py: licence text changed:\n  ' + '\n  '.join(bad))

# 3. NOTICE: the acknowledgments the PHP License 3.01 (clause 6) and the Zend Engine License 2.00
#    (clause 6) require, verbatim, and the product name (Conrad's ruling: never "PHP" in it).
notice = """The pagefeather engine

The pagefeather engine is a WebAssembly build made by the pagefeather project
(https://github.com/skyphusion-labs/pagefeather). It is not PHP and is not
endorsed by The PHP Group or Zend. It includes the software below; the licence
texts are in LICENSES/, one file per component.

This product includes PHP software, freely available from
<http://www.php.net/software/>.

This product includes the Zend Engine, freely available at
<http://www.zend.com>.

Components linked into this build (from wasm-ld --trace):
"""
for name, r in sorted(needed.items(), key=lambda kv: kv[1]['component'].lower()):
    notice += '- %s %s (%s): LICENSES/%s\n' % (r['component'], r['version'], r['spdx'], name)
open(os.path.join(out, 'NOTICE'), 'w', encoding='utf-8').write(notice)

# 4. SOURCE: where the exact source of this build is.
up = dict(l.strip().split('=', 1) for l in open(os.path.join(root, 'engine', 'UPSTREAM')) if '=' in l and not l.startswith('#'))
source = """The pagefeather engine: corresponding source

Build: engine/build.sh in https://github.com/skyphusion-labs/pagefeather (this
release's tag), with engine/patches/ and engine/UPSTREAM at that tag.

Upstream pipeline: %s at commit %s
  (packages/php-wasm/compile, git tree %s)
PHP: php-src tag %s, commit %s
Emscripten: %s

Each library, the version, and where its source is (the URL the upstream recipe
downloads):
""" % (up['UPSTREAM_REPO'], up['UPSTREAM_COMMIT'], up['UPSTREAM_COMPILE_TREE'], up['PHP_REF'], up['PHP_REF_COMMIT'], up['EMSDK_VERSION'])
seen = set()
for name, r in sorted(needed.items(), key=lambda kv: kv[1]['component'].lower()):
    if r['kind'] == 'tar' and r['source'] not in seen:
        seen.add(r['source'])
        source += '- %s %s: %s\n' % (r['component'], r['version'], r['source'])
source += '\nLink inputs (wasm-ld --trace) and the licence rows they matched:\n'
for p in inputs:
    source += '- %s: %s\n' % (re.sub(r'/emscripten_temp_[A-Za-z0-9_]+/', '/emscripten_temp/', p), ', '.join(by_input[p]))
open(os.path.join(out, 'SOURCE'), 'w', encoding='utf-8').write(source)
print('licenses.py: %d link inputs, %d licence files, NOTICE and SOURCE written' % (len(inputs), len(needed)))
