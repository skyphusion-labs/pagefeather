#!/usr/bin/env python3
# The OSS hygiene files of the pagefeather engine (#582, Conrad's ruling 2026-11-14: plain hygiene,
# no lawyer gate): LICENSES/ (one licence text per linked component), NOTICE (the PHP and Zend
# acknowledgments) and SOURCE (where the exact source is). Built from the MEASURED link inputs.
#   licenses.py <link-inputs.txt> <out-dir> [--measure] [--archives <dir>]
#   licenses.py --all <out-dir> [--measure] [--archives <dir>]
#   licenses.py --fetch-archives <dir>
#   licenses.py --check-archives <dir>
# Fails when a traced link input matches no row of engine/licenses.tsv, or a licence text does not
# have its pinned sha256. --all writes every row (a product release has no wasm-ld trace; it is the
# pinned Playground binary after spikes/b2-wordpress/prepare.sh, not the lean custom build).
# --measure prints each text's sha256 instead of checking it.
# --archives reads each tar row from <dir>/<url basename> instead of the network (#604). A missing
# file fails and names the row. Two different URLs that share a file name are refused, and the
# failure names both rows. Two rows that share one URL still share one file. With no --archives,
# tar rows are fetched, as before. No retries.
# --fetch-archives downloads each tar URL once into <dir> and checks the pinned sha256 before it
# writes the file. --check-archives checks a directory already filled (a cache hit) and does not
# touch the network.
import hashlib, io, os, re, sys, tarfile, urllib.request

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(os.path.dirname(here))

def usage():
    sys.exit('usage: licenses.py <link-inputs.txt> <out-dir> [--measure] [--archives <dir>]\n'
             '       licenses.py --all <out-dir> [--measure] [--archives <dir>]\n'
             '       licenses.py --fetch-archives <dir>\n'
             '       licenses.py --check-archives <dir>')

def parse(argv):
    measure = False
    archives_opt = None
    fetch_to = None
    check_to = None
    all_mode = False
    pos = []
    i = 0
    args = argv[1:]
    while i < len(args):
        a = args[i]
        if a == '--measure':
            measure = True
        elif a == '--all':
            all_mode = True
        elif a in ('--archives', '--fetch-archives', '--check-archives'):
            if i + 1 >= len(args) or args[i + 1].startswith('-'):
                usage()
            i += 1
            if a == '--archives':
                archives_opt = args[i]
            elif a == '--fetch-archives':
                fetch_to = args[i]
            else:
                check_to = args[i]
        elif a.startswith('-'):
            usage()
        else:
            pos.append(a)
        i += 1
    if fetch_to or check_to:
        if measure or archives_opt is not None or pos or (fetch_to and check_to) or all_mode:
            usage()
        return ('fetch', fetch_to) if fetch_to else ('check', check_to)
    if all_mode:
        if len(pos) != 1:
            usage()
        return ('all', pos[0], measure, archives_opt)
    if len(pos) != 2:
        usage()
    return ('run', pos, measure, archives_opt)

parsed = parse(sys.argv)
rows = []
for line in open(os.path.join(root, 'engine', 'licenses.tsv'), encoding='utf-8'):
    if line.startswith('#') or not line.strip():
        continue
    f = line.rstrip('\n').split('\t')
    if len(f) != 10:
        sys.exit('licenses.tsv: a row has %d columns, not 10: %s' % (len(f), f[0]))
    rows.append(dict(zip(['out', 'component', 'version', 'spdx', 'match', 'kind', 'source', 'member', 'lines', 'sha256'], f)))

# Set by the run path (--archives) and by --check-archives. None means fetch tar rows.
archives = None
cache = {}
meta = {}

def fetch(url):
    # One attempt. A bad body must fail in the open, not be hidden by a second try (#604).
    if url not in cache:
        req = urllib.request.Request(url, headers={'User-Agent': 'pagefeather-engine-licenses'})
        with urllib.request.urlopen(req, timeout=120) as r:
            cache[url] = r.read()
            meta[url] = (r.status, r.geturl(), r.headers.get('content-type'))
    return cache[url]

def archive_filename(url):
    path = url.split('?', 1)[0].split('#', 1)[0]
    name = path.rsplit('/', 1)[-1]
    if not name or name in ('.', '..') or '/' in name or '\\' in name:
        sys.exit('licenses.py: tar URL has no usable archive name: ' + url)
    return name

def tar_groups():
    groups = []
    index = {}
    for r in rows:
        if r['kind'] != 'tar':
            continue
        i = index.get(r['source'])
        if i is None:
            index[r['source']] = len(groups)
            groups.append((r['source'], [r]))
        else:
            groups[i][1].append(r)
    return groups

def check_names(groups):
    # One file per archive name. The same URL on several rows is one file (libjpeg, libwebp).
    # Two different URLs with that name would silently share a file, and the pin would then
    # fail against the wrong bytes. Refuse and name every row on each URL.
    by_name = {}
    for url, rs in groups:
        name = archive_filename(url)
        by_name.setdefault(name, []).append((url, rs))
    for name in sorted(by_name):
        hits = by_name[name]
        if len(hits) < 2:
            continue
        described = ['%s (%s)' % (', '.join(r['out'] for r in rs), url) for url, rs in hits]
        sys.exit('licenses.py: %s map different URLs to the archive name %s' % (' and '.join(described), name))

def not_an_archive(name, url, blob, err):
    # #604: a body that is not an archive. Say which row, which host, and what came back, then fail.
    # No retry: the next one must explain itself, not be hidden.
    if url in meta:
        status, final, ctype = meta[url]
        sys.exit('licenses.py: %s: the tar from %s is not an archive (%s)\n  final url: %s\n  status: %s, content-type: %s, length: %d\n  first bytes: %r'
                 % (name, url, err, final, status, ctype, len(blob), blob[:120]))
    where = os.path.join(archives, archive_filename(url)) if archives else url
    sys.exit('licenses.py: %s: the tar from %s is not an archive (%s)\n  local file: %s\n  length: %d\n  first bytes: %r'
             % (name, url, err, where, len(blob), blob[:120]))

def blob_for(r):
    if archives is None:
        return fetch(r['source'])
    path = os.path.join(archives, archive_filename(r['source']))
    if not os.path.isfile(path):
        sys.exit('licenses.py: %s: archive missing from %s (%s)' % (r['out'], archives, archive_filename(r['source'])))
    return open(path, 'rb').read()

def licence_bytes(r, blob):
    try:
        t = tarfile.open(fileobj=io.BytesIO(blob), mode='r:*')
    except tarfile.ReadError as e:
        not_an_archive(r['out'], r['source'], blob, str(e).splitlines()[0])
    with t:
        try:
            member = t.getmember(r['member'])
        except KeyError:
            sys.exit('licenses.py: %s: member %s is not in the tar from %s' % (r['out'], r['member'], r['source']))
        extracted = t.extractfile(member)
        if extracted is None:
            sys.exit('licenses.py: %s: member %s is not a file in the tar from %s' % (r['out'], r['member'], r['source']))
        return extracted.read()

def cut_lines(text, spec):
    # Applied to every kind, as before: dlmalloc is a raw row with a line range, sqlite a tar row.
    if spec == '-':
        return text
    a, b = (int(x) for x in spec.split('-'))
    return b''.join(text.splitlines(keepends=True)[a - 1:b])

def verify_rows(rs, blob):
    bad = []
    for r in rs:
        h = hashlib.sha256(cut_lines(licence_bytes(r, blob), r['lines'])).hexdigest()
        if h != r['sha256']:
            bad.append('%s: sha256 %s, pinned %s' % (r['out'], h, r['sha256']))
    if bad:
        sys.exit('licenses.py: licence text changed:\n  ' + '\n  '.join(bad))

def fetch_archives(dest):
    os.makedirs(dest, exist_ok=True)
    groups = tar_groups()
    check_names(groups)
    for url, rs in groups:
        blob = fetch(url)
        verify_rows(rs, blob)
        path = os.path.join(dest, archive_filename(url))
        tmp = path + '.partial'
        open(tmp, 'wb').write(blob)
        os.replace(tmp, path)
    print('licenses.py: %d tar archives written to %s' % (len(groups), dest))

def check_archives(dest):
    global archives
    archives = dest
    groups = tar_groups()
    check_names(groups)
    for _url, rs in groups:
        verify_rows(rs, blob_for(rs[0]))
    print('licenses.py: %d tar archives in %s match the pinned sha256' % (len(groups), dest))

if parsed[0] == 'fetch':
    fetch_archives(parsed[1])
    sys.exit(0)
if parsed[0] == 'check':
    check_archives(parsed[1])
    sys.exit(0)

_kind, pos, measure, archives = parsed
all_mode = _kind == 'all'
if all_mode:
    inputs = []
    out = pos
else:
    inputs = [l.strip() for l in open(pos[0]) if l.strip()]
    out = pos[1]
if archives is not None:
    check_names(tar_groups())

# 1. Every traced input needs a row; a row is needed when an input matches it (or it is ALWAYS).
#    --all writes every row: a product release has no wasm-ld trace (#584). It ships the
#    pinned Playground binary after prepare.sh, not the lean custom build.
needed, unmatched, by_input = {}, [], {}
if all_mode:
    for r in rows:
        needed[r['out']] = r
else:
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

# 2. Fetch, cut, check, write. Tar rows come from --archives when that directory is set.
os.makedirs(os.path.join(out, 'LICENSES'), exist_ok=True)
bad = []
for name, r in sorted(needed.items()):
    if r['kind'] == 'local':
        text = open(os.path.join(root, r['source']), 'rb').read()
    elif r['kind'] == 'raw':
        text = fetch(r['source'])
    elif r['kind'] == 'tar':
        text = licence_bytes(r, blob_for(r))
    else:
        sys.exit('licenses.tsv: unknown kind ' + r['kind'])
    text = cut_lines(text, r['lines'])
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
endorsed by The PHP Group or Zend. It includes the software below. The licence
texts are in engine/notices/LICENSES/ in this repository, and in LICENSES.tar.gz
on each GitHub Release that ships the engine, one file per component.

This product includes PHP software, freely available from
<http://www.php.net/software/>.

This product includes the Zend Engine, freely available at
<http://www.zend.com>.

Components linked into this build%s:
""" % (' (every row of engine/licenses.tsv)' if all_mode else ' (from wasm-ld --trace)')
for name, r in sorted(needed.items(), key=lambda kv: kv[1]['component'].lower()):
    notice += '- %s %s (%s): LICENSES/%s\n' % (r['component'], r['version'], r['spdx'], name)
open(os.path.join(out, 'NOTICE'), 'w', encoding='utf-8').write(notice)

# 4. SOURCE: where the exact source of this build is.
up = dict(l.strip().split('=', 1) for l in open(os.path.join(root, 'engine', 'UPSTREAM')) if '=' in l and not l.startswith('#'))
source = """The pagefeather engine: corresponding source

Build: engine/build.sh in https://github.com/skyphusion-labs/pagefeather (this
release's tag), with engine/patches/ and engine/UPSTREAM at that tag.

The pinned Playground build is the binary this product starts from, the one
pinned in engine/UPSTREAM. Its source is the upstream pipeline listed below.
wasm sha256 %s, loader sha256 %s.

The shipped php_8_3.wasm and php_8_3.js are produced from that pinned binary
by spikes/b2-wordpress/prepare.sh (GPL) in this repository at the release tag.
That script is part of the corresponding source. It applies the memory-import transform (the wasm memory section becomes an imported env.memory) and the loader patch.

The sha256 of the shipped php_8_3.wasm is the line in this release's SHA256SUMS whose file name ends in php_8_3.wasm.
That sha256 differs from the pinned Playground wasm sha256 above.

Upstream pipeline: %s at commit %s
  (packages/php-wasm/compile, git tree %s)
PHP: php-src tag %s, commit %s
Emscripten: %s

Changes relative to that upstream live in this repository at the same tag:
engine/patches/, engine/fileinfo/ and engine/opcache/. Each patch file has a
header that says why.

Each library, the version, and where its source is (the URL the upstream recipe
downloads, fetched at the pinned version when this file was written):
""" % (up['SHIPPED_WASM_SHA256'], up['SHIPPED_JS_SHA256'], up['UPSTREAM_REPO'], up['UPSTREAM_COMMIT'], up['UPSTREAM_COMPILE_TREE'], up['PHP_REF'], up['PHP_REF_COMMIT'], up['EMSDK_VERSION'])
seen = set()
for name, r in sorted(needed.items(), key=lambda kv: kv[1]['component'].lower()):
    if r['kind'] == 'tar' and r['source'] not in seen:
        seen.add(r['source'])
        source += '- %s %s: %s\n' % (r['component'], r['version'], r['source'])
    elif r['kind'] == 'raw' and r['source'] not in seen:
        seen.add(r['source'])
        source += '- %s %s: %s\n' % (r['component'], r['version'], r['source'])
    elif r['kind'] == 'local' and r['source'] not in seen:
        seen.add(r['source'])
        source += '- %s %s: %s in this repository\n' % (r['component'], r['version'], r['source'])
if inputs:
    source += '\nLink inputs (wasm-ld --trace) and the licence rows they matched:\n'
    for p in inputs:
        source += '- %s: %s\n' % (re.sub(r'/emscripten_temp_[A-Za-z0-9_]+/', '/emscripten_temp/', p), ', '.join(by_input[p]))
else:
    source += '\nThis list is every row of engine/licenses.tsv (no wasm-ld trace).\n'
open(os.path.join(out, 'SOURCE'), 'w', encoding='utf-8').write(source)
print('licenses.py: %d link inputs, %d licence files, NOTICE and SOURCE written' % (len(inputs), len(needed)))
