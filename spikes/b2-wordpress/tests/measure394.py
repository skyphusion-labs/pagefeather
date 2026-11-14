#!/usr/bin/env python3
"""The #394 measurement on a THROWAWAY b-dosql site (design docs/design-394-bundle-out-of-memory.md,
plan A: OPcache 32, 48, 52). Read-only on the front pages; on the admin pages it logs in, opens the
dashboard (which writes an auto-draft, as WordPress does), saves the admin profile with an unchanged
marker field, and creates draft pages through REST. Never point it at a live site.

  B=https://<throwaway> SPIKE_TOKEN=... ADMIN_USER=... ADMIN_PASSWORD=... TURNSTILE_TEST_TOKEN=XXXX.DUMMY.TOKEN.XXXX \
    python3 tests/measure394.py <label> [gap] [admin] [crawl] > <label>.jsonl

Phases (default: gap admin):
  gap    10 shop (/?post_type=product), 10 home, 10 product back to back, then product with an idle
         gap of 0, 2 and 10 s (15 each): 75 GETs, the #394 instrument (comment 3).
  admin  logged in, ROUNDS rounds (default 10): GET /wp-admin/, GET and POST profile.php, GET
         post-new.php?post_type=page, POST /wp/v2/pages (status draft). Every REST create is checked
         against the database after (does the page exist, whatever the answer said).
         ADMIN_EXTRA=1 adds per round: GET wc-settings and a WooCommerce settings save of the store
         city to its SAME value (REST /wc/v3/settings). ADMIN_INSTALL=1 (with ADMIN_EXTRA=1) also
         adds a Hello Dolly install and delete from wordpress.org (REST /wp/v2/plugins; never
         activated): only on a local or throwaway instance with CODE_LOCK=off, since every site
         is code-locked (#458).
  crawl  180 s at 1 request a second: product, product, shop, Store API cart.
  rest   ROUNDS REST creates on a warm runtime (GET edit.php between them).
  pnrest ROUNDS rounds of GET post-new.php then a REST create (the #394 trigger sequence).
Every REST create is read back (check_state): by the id in a 201, else by exact title, in
context=edit. The state is found, absent, mismatch or read-failed (#519: a failed read is never an
absent row). The summary counts each, the 201-and-absent rows, and stalls over 30 s.
Every GET carries a unique nocache= so the edge page cache never answers. One JSON line per request
(headers only, never a body or a cookie); a summary per label on stderr.
TURNSTILE_TEST_TOKEN is sent as cf-turnstile-response on the login: on a throwaway with the
Cloudflare test keys (always pass) the gated login then runs its real siteverify path."""
import json, os, re, sys, time, urllib.parse
sys.path.insert(0, os.path.dirname(__file__))
import break_lib
from break_lib import opener, req

RUN = sys.argv[1] if len(sys.argv) > 1 else 'run'
os.environ.setdefault('PERF_RUN', RUN)
PHASES = sys.argv[2:] or ['gap', 'admin']
n = [0]
rows = []


def nc(path):
    n[0] += 1
    return path + ('&' if '?' in path else '?') + 'nocache=%s-%d-%d' % (RUN, int(time.time()), n[0])


def rec(phase, label, method, path, r, extra=None):
    h = r.get('h') or {}
    g = lambda k: h.get(k) if h else None
    perf = None
    try:
        perf = json.loads(g('x-perf')) if g('x-perf') else None
    except ValueError:
        perf = None
    keep = ('iso', 'rt', 'rtServed', 'boot', 'wasm0MiB', 'wasm1MiB', 'inflates', 'inflateKiB', 'phpMs', 'bootWaitMs')
    row = {'run': RUN, 'phase': phase, 'label': label, 'method': method, 'path': path.split('?')[0], 't': round(time.time(), 3),
           'code': r.get('code'), 's': r.get('s'), 'boot': g('x-boot'), 'wasm': g('x-wasm-mib'),
           'recycled': g('x-runtime-recycled'), 'writeLoss': g('x-write-loss'), 'reset': g('x-isolate-reset'),
           'prerecycled': g('x-runtime-prerecycled'), 'retry': g('x-isolate-retry'), 'perfId': break_lib.LAST_ID[0],
           'perf': perf}  # the whole perf object: a fixed subset dropped fields the #394 runs needed
    if r.get('err'):
        row['err'] = r['err']  # a client exception (break_lib.req): the repr, never a body
    row.update(extra or {})
    rows.append(row)
    print(json.dumps(row), flush=True)
    return r


def get(o, phase, label, path):
    return rec(phase, label, 'GET', path, req(o, nc(path)))


def classify(code, body, title, want_id=None):
    """#519: the state of one create from ONE read, in context=edit. found: the row is there (the id
    from the 201, or one exact title); absent: the read answered and the row is not there; mismatch:
    the id answered with another title; read-failed: the read did not answer (a non-200 other than a
    404 by id, an exception, or a body without title.raw, which means the read could not see titles).
    A failed read is never counted as absent: in op48arena 4 failed read-backs were (#519)."""
    if code == 404 and want_id is not None:
        return 'absent'
    if code != 200:
        return 'read-failed'
    try:
        data = json.loads(body)
    except (ValueError, TypeError):
        return 'read-failed'
    items = data if isinstance(data, list) else [data]
    if not all(isinstance(x, dict) and isinstance(x.get('title'), dict) and 'raw' in x['title'] for x in items):
        return 'read-failed'  # no title.raw: not context=edit, so the read is blind (#519)
    if want_id is not None:
        hit = [x for x in items if x.get('id') == want_id]
        if not hit:
            return 'absent'
        return 'found' if hit[0]['title']['raw'] == title else 'mismatch'
    return 'found' if any(x['title']['raw'] == title for x in items) else 'absent'


def check_state(a, nonce, r, title):
    """Read a create back, whatever it answered: by the id in a 201's body, else by exact title."""
    want = None
    if r.get('code') == 201:
        try:
            want = json.loads(r.get('body') or b'').get('id')
        except (ValueError, AttributeError):
            want = None
    want = want if isinstance(want, int) else None
    h = {'X-WP-Nonce': nonce}
    if want is not None:
        s = req(a, '/?rest_route=/wp/v2/pages/%d&context=edit' % want, None, h)
    else:
        s = req(a, '/?rest_route=/wp/v2/pages&status=draft&context=edit&per_page=100&search=' + urllib.parse.quote_plus(title), None, h)
    st = classify(s['code'], s.get('body'), title, want)
    return {'state': st, 'stateFound': {'found': 1, 'absent': 0}.get(st), 'stateCode': s['code'], 'stateId': want, 'stateS': s.get('s')}


def product_path(o):
    r = req(o, nc('/?rest_route=/wc/store/v1/products') + '&per_page=1')
    items = json.loads(r['body'] or b'[]') if r['code'] == 200 else []
    assert items, 'no product from the Store API: is the sample store imported?'
    # The permalink, not /?p=<id>: that answers 301 to it, and a redirect is not a render.
    u = urllib.parse.urlparse(items[0]['permalink'])
    return u.path + ('?' + u.query if u.query else '')


def gap(o):
    prod = product_path(o)
    for label, path in (('shop', '/?post_type=product'), ('home', '/'), ('product', prod)):
        for _ in range(10):
            get(o, 'gap', label, path)
    for wait in (0, 2, 10):
        for _ in range(15):
            time.sleep(wait)
            get(o, 'gap', 'product-gap%d' % wait, prod)


def login():
    o = opener()
    req(o, '/wp-login.php')
    form = {'log': os.environ.get('ADMIN_USER', 'admin'), 'pwd': os.environ['ADMIN_PASSWORD'], 'wp-submit': 'Log In', 'redirect_to': '/wp-admin/', 'testcookie': '1'}
    if os.environ.get('TURNSTILE_TEST_TOKEN'):
        form['cf-turnstile-response'] = os.environ['TURNSTILE_TEST_TOKEN']
    r = rec('admin', 'login', 'POST', '/wp-login.php', req(o, '/wp-login.php', form))
    assert r['code'] == 302, 'login answered %s' % r['code']
    return o


def admin(o):
    a = login()
    for i in range(int(os.environ.get('ROUNDS', '10'))):
        get(a, 'admin', 'dashboard', '/wp-admin/')
        p = get(a, 'admin', 'profile', '/wp-admin/profile.php')
        body = p.get('body') or b''
        m = re.search(rb'name="_wpnonce"[^>]*value="([a-f0-9]+)"', body)
        uid = re.search(rb'name="user_id"[^>]*value="(\d+)"', body)
        email = re.search(rb'name="email"[^>]*value="([^"]*)"', body)
        if m and uid and email:
            form = {'_wpnonce': m.group(1).decode(), '_wp_http_referer': '/wp-admin/profile.php', 'from': 'profile', 'checkuser_id': uid.group(1).decode(),
                    'user_id': uid.group(1).decode(), 'email': email.group(1).decode(), 'nickname': 'admin', 'display_name': 'admin',
                    'description': 'measure394 marker', 'action': 'update', 'submit': 'Update Profile'}
            rec('admin', 'profile-save', 'POST', '/wp-admin/profile.php', req(a, '/wp-admin/profile.php', form))
        else:
            rec('admin', 'profile-save', 'POST', '/wp-admin/profile.php', {'code': 'SKIP-no-form'})
        get(a, 'admin', 'post-new', '/wp-admin/post-new.php?post_type=page')
        nn = req(a, '/wp-admin/admin-ajax.php?action=rest-nonce')
        nonce = (nn.get('body') or b'').decode().strip()
        title = 'measure394 %s %d' % (RUN, i)
        r = req(a, '/?rest_route=/wp/v2/pages', json.dumps({'title': title, 'status': 'draft'}).encode(),
                {'X-WP-Nonce': nonce, 'Content-Type': 'application/json'}, 'POST')
        # The state, whatever the answer said (#394: a 500 write-loss once had created the page).
        rec('admin', 'rest-page', 'POST', '/wp/v2/pages', r, check_state(a, nonce, r, title))
        if os.environ.get('ADMIN_EXTRA') == '1':
            # The WooCommerce settings screen (a heavy admin page), and a settings save through
            # WooCommerce's settings API with the SAME value (no setting changes).
            get(a, 'admin', 'wc-settings', '/wp-admin/admin.php?page=wc-settings')
            h = {'X-WP-Nonce': nonce, 'Content-Type': 'application/json'}
            cur = req(a, '/?rest_route=/wc/v3/settings/general/woocommerce_store_city', None, h)
            val = json.loads(cur['body']).get('value', '') if cur.get('code') == 200 else None
            if val is None:
                rec('admin', 'wc-settings-save', 'PUT', '/wc/v3/settings/general', {'code': 'SKIP-no-read'})
            else:
                rec('admin', 'wc-settings-save', 'PUT', '/wc/v3/settings/general', req(a, '/?rest_route=/wc/v3/settings/general/woocommerce_store_city', json.dumps({'value': val}).encode(), h, 'PUT'))
        if os.environ.get('ADMIN_EXTRA') == '1' and os.environ.get('ADMIN_INSTALL') == '1':
            # A plugin install from wordpress.org and its delete (the #430 path): Hello Dolly, never
            # activated. Off by default: every site is code-locked (#458), so this only runs on a
            # local or throwaway instance with CODE_LOCK=off.
            ri = req(a, '/?rest_route=/wp/v2/plugins', json.dumps({'slug': 'hello-dolly'}).encode(), h, 'POST')
            rec('admin', 'plugin-install', 'POST', '/wp/v2/plugins', ri)
            rd = req(a, '/?rest_route=/wp/v2/plugins/hello-dolly/hello', None, h, 'DELETE')
            rec('admin', 'plugin-delete', 'DELETE', '/wp/v2/plugins', rd)


def rest(o):
    """#394 (b): REST creates on a WARM runtime. Per round: GET edit.php, then a REST draft page,
    read back. No post-new in between, so the create does not follow a recycle or an isolate reset."""
    a = login()
    for i in range(int(os.environ.get('ROUNDS', '50'))):
        get(a, 'rest', 'edit-list', '/wp-admin/edit.php')
        rest_round(a, 'rest', i)


def pnrest(o):
    """#394 (b): the trigger sequence. Per round: GET post-new.php (115 to 121 MiB: it recycles the
    runtime or resets the isolate), then a REST draft page, read back."""
    a = login()
    for i in range(int(os.environ.get('ROUNDS', '50'))):
        get(a, 'pnrest', 'post-new', '/wp-admin/post-new.php?post_type=page')
        rest_round(a, 'pnrest', i)


def rest_round(a, phase, i):
    nn = req(a, '/wp-admin/admin-ajax.php?action=rest-nonce')
    nonce = (nn.get('body') or b'').decode().strip()
    title = 'measure394 %s %d' % (RUN, i)
    r = req(a, '/?rest_route=/wp/v2/pages', json.dumps({'title': title, 'status': 'draft'}).encode(),
            {'X-WP-Nonce': nonce, 'Content-Type': 'application/json'}, 'POST')
    rec(phase, 'rest-page', 'POST', '/wp/v2/pages', r, check_state(a, nonce, r, title))


def crawl(o):
    prod = product_path(o)
    seq = [('product', prod), ('product', prod), ('shop', '/?post_type=product'), ('cart', '/?rest_route=/wc/store/v1/cart')]
    end = time.time() + 180
    i = 0
    while time.time() < end:
        t = time.time()
        label, path = seq[i % len(seq)]
        get(o, 'crawl', label, path)
        i += 1
        time.sleep(max(0, 1 - (time.time() - t)))


def summary():
    by = {}
    for r in rows:
        by.setdefault((r['phase'], r['label']), []).append(r)
    for (ph, lb), rs in by.items():
        s = sorted(x['s'] for x in rs if isinstance(x.get('s'), (int, float)))
        p = lambda q: s[min(len(s) - 1, int(q * len(s)))] if s else None
        isos = {(x['perf'] or {}).get('iso') for x in rs if x.get('perf')}
        print('%-6s %-14s n %3d codes %s boots %d recycled %d writeLoss %d isolates %d wasmMax %s p50 %s p99 %s' % (
            ph, lb, len(rs), sorted({str(x['code']) for x in rs}), sum(1 for x in rs if x.get('boot') == '1'),
            sum(1 for x in rs if x.get('recycled')), sum(1 for x in rs if x.get('writeLoss') not in (None, '0')),
            len(isos - {None}), max((int(x['wasm']) for x in rs if x.get('wasm')), default=None), p(0.5), p(0.99)), file=sys.stderr)
        if lb == 'rest-page':
            st = {k: sum(1 for x in rs if x.get('state') == k) for k in ('found', 'absent', 'mismatch', 'read-failed')}
            stalls = sum(1 for x in rs if max(x.get('s') or 0, x.get('stateS') or 0) > 30)
            print('       rest-page: answered 201 %d; read back: found %d absent %d mismatch %d read-failed %d; 201-and-absent %d; stalls over 30 s %d' % (
                sum(1 for x in rs if x['code'] == 201), st['found'], st['absent'], st['mismatch'], st['read-failed'],
                sum(1 for x in rs if x['code'] == 201 and x.get('state') == 'absent'), stalls), file=sys.stderr)


if __name__ == '__main__':
    o = opener()
    for ph in PHASES:
        {'gap': gap, 'admin': admin, 'crawl': crawl, 'rest': rest, 'pnrest': pnrest}[ph](o)
    summary()
