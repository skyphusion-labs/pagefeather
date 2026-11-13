#!/usr/bin/env python3
"""The #394 measurement on a THROWAWAY b-dosql site (design docs/design-394-bundle-out-of-memory.md,
plan A: OPcache 32, 48, 52). Read-only on the front pages; on the admin pages it logs in, opens the
dashboard (which writes an auto-draft, as WordPress does), saves the admin profile with an unchanged
marker field, and creates draft pages through REST. Never point it at a live site.

  B=https://<throwaway> SPIKE_TOKEN=... ADMIN_PASSWORD=... TURNSTILE_TEST_TOKEN=XXXX.DUMMY.TOKEN.XXXX \
    python3 tests/measure394.py <label> [gap] [admin] [crawl] > <label>.jsonl

Phases (default: gap admin):
  gap    10 shop (/?post_type=product), 10 home, 10 product back to back, then product with an idle
         gap of 0, 2 and 10 s (15 each): 75 GETs, the #394 instrument (comment 3).
  admin  logged in, 10 each: GET /wp-admin/, GET and POST profile.php, GET
         post-new.php?post_type=page, POST /wp/v2/pages (status draft). Every REST create is checked
         against the database after (does the page exist, whatever the answer said).
  crawl  180 s at 1 request a second: product, product, shop, Store API cart.
Every GET carries a unique nocache= so the edge page cache never answers. One JSON line per request
(headers only, never a body or a cookie); a summary per label on stderr.
TURNSTILE_TEST_TOKEN is sent as cf-turnstile-response on the login: on a throwaway with the
Cloudflare test keys (always pass) the gated login then runs its real siteverify path."""
import json, os, re, sys, time, urllib.parse
sys.path.insert(0, os.path.dirname(__file__))
from break_lib import opener, req

RUN = sys.argv[1] if len(sys.argv) > 1 else 'run'
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
           'perf': {k: perf.get(k) for k in keep} if perf else None}
    row.update(extra or {})
    rows.append(row)
    print(json.dumps(row), flush=True)
    return r


def get(o, phase, label, path):
    return rec(phase, label, 'GET', path, req(o, nc(path)))


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
    form = {'log': 'admin', 'pwd': os.environ['ADMIN_PASSWORD'], 'wp-submit': 'Log In', 'redirect_to': '/wp-admin/', 'testcookie': '1'}
    if os.environ.get('TURNSTILE_TEST_TOKEN'):
        form['cf-turnstile-response'] = os.environ['TURNSTILE_TEST_TOKEN']
    r = rec('admin', 'login', 'POST', '/wp-login.php', req(o, '/wp-login.php', form))
    assert r['code'] == 302, 'login answered %s' % r['code']
    return o


def admin(o):
    a = login()
    for i in range(10):
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
        s = req(a, '/?rest_route=/wp/v2/pages&status=draft&search=' + title.replace(' ', '+'), None, {'X-WP-Nonce': nonce})
        found = sum(1 for x in (json.loads(s['body']) if s['code'] == 200 else []) if x.get('title', {}).get('raw', x.get('title', {}).get('rendered')) == title)
        rec('admin', 'rest-page', 'POST', '/wp/v2/pages', r, {'stateFound': found, 'stateCode': s['code']})


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
            print('       rest-page: created per the database %d of %d; answered 201 %d' % (
                sum(1 for x in rs if x.get('stateFound')), len(rs), sum(1 for x in rs if x['code'] == 201)), file=sys.stderr)


if __name__ == '__main__':
    o = opener()
    for ph in PHASES:
        {'gap': gap, 'admin': admin, 'crawl': crawl}[ph](o)
    summary()
