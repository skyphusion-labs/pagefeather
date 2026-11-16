#!/usr/bin/env python3
"""python3 -I engine/tools/licenses-test.py  (#604)

licenses.py --archives reads each tar row from a local directory instead of the
network. The archive and its pinned sha256 are made here. The pass must not
open a connection. A missing archive must fail and name the row. A wrong pin
must still fail and name the row. --fetch-archives takes one response and does
not retry: an HTML 200 fails and names the row after exactly one request.
Two different URLs that share an archive file name are refused, and the
failure names both rows. Two rows that share one URL still share one file.
"""
import hashlib, io, os, shutil, socket, subprocess, sys, tarfile, tempfile, threading

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, 'licenses.py')
PAYLOAD = 'fixture licence text\n'
MEMBER = 'fixture-1/LICENSE'
ROW = 'fixture.txt'
fails = 0

def ok(label, cond):
    global fails
    print(('ok   ' if cond else 'FAIL ') + label)
    fails += 0 if cond else 1

def archive_bytes(payload):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as t:
        data = payload.encode()
        info = tarfile.TarInfo(MEMBER)
        info.size = len(data)
        t.addfile(info, io.BytesIO(data))
    return buf.getvalue()

class OneShot:
    """Accepts connections and answers each with the current response. Records one hit per accept."""
    def __init__(self):
        self.hits = []
        self.status = 200
        self.ctype = 'text/html'
        self.body = b'<html>not an archive</html>'
        self.srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(('127.0.0.1', 0))
        self.srv.listen(8)
        self.srv.settimeout(0.2)
        self.port = self.srv.getsockname()[1]
        self.stop = threading.Event()
        self.th = threading.Thread(target=self._loop, daemon=True)
        self.th.start()

    def url(self):
        return 'http://127.0.0.1:%d/fixture-1.tar.gz' % self.port

    def reset(self):
        self.hits = []

    def _loop(self):
        while not self.stop.is_set():
            try:
                conn, _ = self.srv.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            self.hits.append(1)
            try:
                conn.settimeout(2)
                buf = b''
                while b'\r\n\r\n' not in buf and len(buf) < 8192:
                    chunk = conn.recv(4096)
                    if not chunk:
                        break
                    buf += chunk
                body = self.body
                head = ('HTTP/1.0 %d X\r\nContent-Type: %s\r\nContent-Length: %d\r\nConnection: close\r\n\r\n'
                        % (self.status, self.ctype, len(body))).encode()
                conn.sendall(head + body)
            except OSError:
                pass
            finally:
                conn.close()

    def close(self):
        self.stop.set()
        try:
            self.srv.close()
        except OSError:
            pass
        self.th.join(timeout=2)

def write_tree(root, sha, url):
    tools = os.path.join(root, 'engine', 'tools')
    os.makedirs(tools)
    shutil.copy(SCRIPT, os.path.join(tools, 'licenses.py'))
    row = '\t'.join([ROW, 'Fixture', '1', 'MIT', r'/libfixture\.a$', 'tar', url, MEMBER, '-', sha])
    open(os.path.join(root, 'engine', 'licenses.tsv'), 'w', encoding='utf-8').write(row + '\n')
    open(os.path.join(root, 'engine', 'UPSTREAM'), 'w', encoding='utf-8').write(
        'UPSTREAM_REPO=https://example.invalid/repo\n'
        'UPSTREAM_COMMIT=abc\n'
        'UPSTREAM_COMPILE_TREE=def\n'
        'PHP_REF=php-test\n'
        'PHP_REF_COMMIT=012\n'
        'EMSDK_VERSION=0\n'
        'SHIPPED_WASM_SHA256=ww\n'
        'SHIPPED_JS_SHA256=jj\n')
    inputs = os.path.join(root, 'link-inputs.txt')
    open(inputs, 'w', encoding='utf-8').write('/work/libfixture.a\n')
    return inputs

def run(root, args):
    script = os.path.join(root, 'engine', 'tools', 'licenses.py')
    return subprocess.run([sys.executable, '-I', script] + args, capture_output=True, text=True)

srv = OneShot()
try:
    blob = archive_bytes(PAYLOAD)
    pin = hashlib.sha256(PAYLOAD.encode()).hexdigest()
    url = srv.url()

    # 1. Local archive, matching pin, no connection.
    srv.reset()
    srv.status, srv.ctype, srv.body = 500, 'text/plain', b'no'
    with tempfile.TemporaryDirectory() as root:
        inputs = write_tree(root, pin, url)
        archives = os.path.join(root, 'archives')
        os.makedirs(archives)
        open(os.path.join(archives, 'fixture-1.tar.gz'), 'wb').write(blob)
        out = os.path.join(root, 'out')
        r = run(root, [inputs, out, '--archives', archives])
        text = r.stdout + r.stderr
        ok('local archive exits 0 (no network): rc=%d %s' % (r.returncode, text.strip().splitlines()[-1:] or ''), r.returncode == 0)
        written = ''
        lic = os.path.join(out, 'LICENSES', ROW)
        if os.path.isfile(lic):
            written = open(lic, encoding='utf-8').read()
        ok('the licence file contains the archive member', PAYLOAD in written and 'Component: Fixture' in written)
        ok('the pass opened no connection (hits %d)' % len(srv.hits), len(srv.hits) == 0)
        traced = ''
        traced_path = os.path.join(out, 'SOURCE')
        if os.path.isfile(traced_path):
            traced = open(traced_path, encoding='utf-8').read()
        ok('traced SOURCE names engine/build.sh', 'engine/build.sh' in traced)
        ok('traced SOURCE names the build workflow', '.github/workflows/pagefeather-engine.yml' in traced)
        ok('traced SOURCE does not say prepare.sh produced the wasm',
           'produced from that pinned binary' not in traced)

    # 2. Missing archive names the row and does not touch the network.
    srv.reset()
    with tempfile.TemporaryDirectory() as root:
        inputs = write_tree(root, pin, url)
        archives = os.path.join(root, 'archives')
        os.makedirs(archives)
        out = os.path.join(root, 'out')
        r = run(root, [inputs, out, '--archives', archives])
        text = r.stdout + r.stderr
        ok('a missing archive fails (rc=%d)' % r.returncode, r.returncode != 0)
        ok('the failure names the row %s' % ROW, ROW in text and 'missing' in text)
        ok('the miss opened no connection (hits %d)' % len(srv.hits), len(srv.hits) == 0)

    # 3. The pinned sha256 is still the gate on the local path.
    srv.reset()
    wrong = '0' * 64
    with tempfile.TemporaryDirectory() as root:
        inputs = write_tree(root, wrong, url)
        archives = os.path.join(root, 'archives')
        os.makedirs(archives)
        open(os.path.join(archives, 'fixture-1.tar.gz'), 'wb').write(blob)
        out = os.path.join(root, 'out')
        r = run(root, [inputs, out, '--archives', archives])
        text = r.stdout + r.stderr
        ok('a wrong pin fails and names the row', r.returncode != 0 and ROW in text and 'sha256' in text)
        ok('a wrong pin opened no connection (hits %d)' % len(srv.hits), len(srv.hits) == 0)

    # 3b. A line range is still applied on the local path (sqlite is a tar row with lines 1-11).
    srv.reset()
    ranged = 'L1\nL2\nL3\n'
    ranged_pin = hashlib.sha256(b'L2\n').hexdigest()
    with tempfile.TemporaryDirectory() as root:
        inputs = write_tree(root, ranged_pin, url)
        # write_tree pins the whole member; replace the row with a 2-2 cut of a three-line member.
        open(os.path.join(root, 'engine', 'licenses.tsv'), 'w', encoding='utf-8').write(
            '\t'.join([ROW, 'Fixture', '1', 'MIT', r'/libfixture\.a$', 'tar', url, MEMBER, '2-2', ranged_pin]) + '\n')
        archives = os.path.join(root, 'archives')
        os.makedirs(archives)
        open(os.path.join(archives, 'fixture-1.tar.gz'), 'wb').write(archive_bytes(ranged))
        out = os.path.join(root, 'out')
        r = run(root, [inputs, out, '--archives', archives])
        written = ''
        lic = os.path.join(out, 'LICENSES', ROW)
        if os.path.isfile(lic):
            written = open(lic, encoding='utf-8').read()
        ok('a line range on a local tar passes (rc=%d)' % r.returncode, r.returncode == 0 and 'L2\n' in written and 'L1\n' not in written)
        ok('the line-range pass opened no connection (hits %d)' % len(srv.hits), len(srv.hits) == 0)

    # 3c. With no --archives, a raw row is still fetched once and its line range still applied (dlmalloc).
    srv.reset()
    srv.status, srv.ctype, srv.body = 200, 'text/plain', ranged.encode()
    with tempfile.TemporaryDirectory() as root:
        inputs = write_tree(root, ranged_pin, url)
        open(os.path.join(root, 'engine', 'licenses.tsv'), 'w', encoding='utf-8').write(
            '\t'.join([ROW, 'Fixture', '1', 'MIT', r'/libfixture\.a$', 'raw', url, '-', '2-2', ranged_pin]) + '\n')
        out = os.path.join(root, 'out')
        r = run(root, [inputs, out])
        written = ''
        lic = os.path.join(out, 'LICENSES', ROW)
        if os.path.isfile(lic):
            written = open(lic, encoding='utf-8').read()
        ok('no --archives still fetches a raw row and cuts lines (rc=%d)' % r.returncode, r.returncode == 0 and 'L2\n' in written and 'L1\n' not in written)
        ok('that raw fetch was exactly one request (hits %d)' % len(srv.hits), len(srv.hits) == 1)

    # 4. --fetch-archives: one HTML 200, no retry, names the row.
    srv.reset()
    srv.status, srv.ctype, srv.body = 200, 'text/html', b'<html>not an archive</html>'
    with tempfile.TemporaryDirectory() as root:
        write_tree(root, pin, url)
        dest = os.path.join(root, 'fetched')
        r = run(root, ['--fetch-archives', dest])
        text = r.stdout + r.stderr
        ok('an HTML 200 fails the fetch and names the row', r.returncode != 0 and ROW in text and 'not an archive' in text)
        ok('the fetch made exactly one request (hits %d), no retry' % len(srv.hits), len(srv.hits) == 1)

    # 5. --fetch-archives writes the archive once, and --check-archives accepts it offline.
    srv.reset()
    srv.status, srv.ctype, srv.body = 200, 'application/gzip', blob
    with tempfile.TemporaryDirectory() as root:
        write_tree(root, pin, url)
        dest = os.path.join(root, 'fetched')
        r = run(root, ['--fetch-archives', dest])
        text = r.stdout + r.stderr
        path = os.path.join(dest, 'fixture-1.tar.gz')
        ok('fetch writes the archive from one response (rc=%d)' % r.returncode, r.returncode == 0 and os.path.isfile(path) and open(path, 'rb').read() == blob)
        ok('the good fetch made exactly one request (hits %d)' % len(srv.hits), len(srv.hits) == 1)
        srv.reset()
        srv.status, srv.body = 500, b'no'
        r2 = run(root, ['--check-archives', dest])
        text2 = r2.stdout + r2.stderr
        ok('check-archives passes offline (rc=%d)' % r2.returncode, r2.returncode == 0 and len(srv.hits) == 0)
        empty = os.path.join(root, 'empty')
        os.makedirs(empty)
        r3 = run(root, ['--check-archives', empty])
        text3 = r3.stdout + r3.stderr
        ok('check-archives names the row when the archive is missing', r3.returncode != 0 and ROW in text3 and 'missing' in text3)

    # 6. Two different URLs with one archive file name are refused, and both rows are named.
    #    The same URL on two rows is still one file (libjpeg, libwebp). No request either way.
    srv.reset()
    srv.status, srv.body = 500, b'no'
    url_a = 'http://127.0.0.1:%d/rel/a/fixture-1.tar.gz' % srv.port
    url_b = 'http://127.0.0.1:%d/rel/b/fixture-1.tar.gz' % srv.port
    row_a, row_b = 'alpha.txt', 'beta.txt'
    collided = '\n'.join([
        '\t'.join([row_a, 'Fixture', '1', 'MIT', r'/libfixture\.a$', 'tar', url_a, MEMBER, '-', pin]),
        '\t'.join([row_b, 'Other', '1', 'MIT', r'/libother\.a$', 'tar', url_b, MEMBER, '-', pin]),
    ]) + '\n'
    shared = '\n'.join([
        '\t'.join([row_a, 'Fixture', '1', 'MIT', r'/libfixture\.a$', 'tar', url, MEMBER, '-', pin]),
        '\t'.join([row_b, 'Other', '1', 'MIT', r'/libother\.a$', 'tar', url, MEMBER, '-', pin]),
    ]) + '\n'
    for flag in ('--fetch-archives', '--archives'):
        srv.reset()
        with tempfile.TemporaryDirectory() as root:
            inputs = write_tree(root, pin, url)
            open(os.path.join(root, 'engine', 'licenses.tsv'), 'w', encoding='utf-8').write(collided)
            dest = os.path.join(root, 'archives')
            os.makedirs(dest)
            args = ['--fetch-archives', dest] if flag == '--fetch-archives' else [inputs, os.path.join(root, 'out'), '--archives', dest]
            r = run(root, args)
            text = r.stdout + r.stderr
            ok('%s refuses two URLs that share %s (rc=%d)' % (flag, 'fixture-1.tar.gz', r.returncode),
               r.returncode != 0 and 'fixture-1.tar.gz' in text)
            ok('%s names both rows (%s and %s)' % (flag, row_a, row_b), row_a in text and row_b in text)
            ok('%s opened no connection (hits %d)' % (flag, len(srv.hits)), len(srv.hits) == 0)
    srv.reset()
    with tempfile.TemporaryDirectory() as root:
        inputs = write_tree(root, pin, url)
        open(os.path.join(root, 'engine', 'licenses.tsv'), 'w', encoding='utf-8').write(shared)
        archives = os.path.join(root, 'archives')
        os.makedirs(archives)
        open(os.path.join(archives, 'fixture-1.tar.gz'), 'wb').write(blob)
        out = os.path.join(root, 'out')
        r = run(root, [inputs, out, '--archives', archives])
        text = r.stdout + r.stderr
        ok('two rows that share one URL still pass (rc=%d)' % r.returncode, r.returncode == 0)
        ok('the shared URL opened no connection (hits %d)' % len(srv.hits), len(srv.hits) == 0)

    # 7. --all writes every row with no link-inputs file, still offline with --archives.
    srv.reset()
    srv.status, srv.body = 500, b'no'
    with tempfile.TemporaryDirectory() as root:
        inputs = write_tree(root, pin, url)
        open(os.path.join(root, 'LICENSE'), 'w', encoding='utf-8').write('GPL fixture\n')
        local_pin = hashlib.sha256(b'GPL fixture\n').hexdigest()
        open(os.path.join(root, 'engine', 'licenses.tsv'), 'w', encoding='utf-8').write('\n'.join([
            '\t'.join(['pagefeather.txt', 'pagefeather', 'repo', 'GPL-2.0-or-later', 'ALWAYS', 'local', 'LICENSE', '-', '-', local_pin]),
            '\t'.join([ROW, 'Fixture', '1', 'MIT', r'/libfixture\.a$', 'tar', url, MEMBER, '-', pin]),
        ]) + '\n')
        archives = os.path.join(root, 'archives')
        os.makedirs(archives)
        open(os.path.join(archives, 'fixture-1.tar.gz'), 'wb').write(blob)
        out = os.path.join(root, 'out')
        r = run(root, ['--all', out, '--archives', archives])
        text = r.stdout + r.stderr
        ok('--all exits 0 with no link-inputs (rc=%d)' % r.returncode, r.returncode == 0)
        ok('--all writes the ALWAYS local row', os.path.isfile(os.path.join(out, 'LICENSES', 'pagefeather.txt')))
        ok('--all writes the tar row that no input matched', os.path.isfile(os.path.join(out, 'LICENSES', ROW)))
        ok('--all writes NOTICE and SOURCE', os.path.isfile(os.path.join(out, 'NOTICE')) and os.path.isfile(os.path.join(out, 'SOURCE')))
        src = open(os.path.join(out, 'SOURCE'), encoding='utf-8').read() if os.path.isfile(os.path.join(out, 'SOURCE')) else ''
        ok('--all SOURCE names the pinned Playground wasm', 'ww' in src)
        ok('--all SOURCE names prepare.sh', 'spikes/b2-wordpress/prepare.sh' in src)
        ok('--all SOURCE points at SHA256SUMS', 'SHA256SUMS' in src)
        ok('--all SOURCE says whether the shipped hash differs or equals',
           'That sha256 differs from the pinned Playground wasm sha256 above.' in src
           or 'That sha256 equals the pinned Playground wasm sha256 above.' in src)
        ok('--all opened no connection (hits %d)' % len(srv.hits), len(srv.hits) == 0)
        notice = open(os.path.join(out, 'NOTICE'), encoding='utf-8').read() if os.path.isfile(os.path.join(out, 'NOTICE')) else ''
        ok('--all NOTICE has the PHP acknowledgment', 'This product includes PHP software, freely available from' in notice)

    # 8. --all --engine lean --notices-only writes the lean release SOURCE offline.
    #    The traced run above is a custom build; this is the prerelease text
    #    (asset pagefeather-engine-lean.wasm, variant s1-lean).
    srv.reset()
    srv.status, srv.body = 500, b'no'
    with tempfile.TemporaryDirectory() as root:
        write_tree(root, pin, url)
        out = os.path.join(root, 'lean-out')
        r = run(root, ['--all', out, '--engine', 'lean', '--notices-only'])
        text = r.stdout + r.stderr
        src = ''
        notice = ''
        src_path = os.path.join(out, 'SOURCE')
        notice_path = os.path.join(out, 'NOTICE')
        if os.path.isfile(src_path):
            src = open(src_path, encoding='utf-8').read()
        if os.path.isfile(notice_path):
            notice = open(notice_path, encoding='utf-8').read()
        ok('lean --notices-only exits 0 (rc=%d) %s' % (r.returncode, text.strip().splitlines()[-1:] or ''), r.returncode == 0)
        ok('lean SOURCE names the workflow and variant s1-lean',
           '.github/workflows/pagefeather-engine.yml' in src and 'variant s1-lean' in src)
        ok('lean SOURCE names engine/licenses.tsv and the pin',
           'engine/licenses.tsv' in src and 'ww' in src)
        ok('lean SOURCE names pagefeather-engine-lean.wasm', 'pagefeather-engine-lean.wasm' in src)
        ok('lean SOURCE does not say prepare.sh produced the wasm',
           'produced from that pinned binary' not in src)
        ok('lean NOTICE names variant s1-lean', 'variant s1-lean' in notice)
        ok('lean --notices-only opened no connection (hits %d)' % len(srv.hits), len(srv.hits) == 0)
        ok('lean --notices-only writes no LICENSES directory', not os.path.isdir(os.path.join(out, 'LICENSES')))
finally:
    srv.close()

print('\n%d FAILED' % fails if fails else '\nALL PASS')
sys.exit(1 if fails else 0)
