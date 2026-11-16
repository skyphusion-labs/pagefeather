#!/usr/bin/env python3
"""#728: on an ordinary site, the editor's own requests never meet rest_list_too_large.

  B=https://<site> ADMIN_PASSWORD=... [SPIKE_TOKEN=...] [TURNSTILE_TEST_TOKEN=...] python3 -I tests/editor-lists-check.py

Logs in as admin through break_lib.login() (as woo.py and break.py do), then sends what the core editors send (read from wp-includes/js/dist):
  1. the editor pages, whose REST preloads run server-side and land in the HTML: post-new.php (post, page),
     post.php for the newest post and page, site-editor.php and its pages, templates, patterns and navigation
     views, and the edit.php lists. Each must answer 200 with no rest_list_too_large in it.
  2. every REST post type list the editors send at its largest ask: core-data pages per_page:-1 as per_page=100
     (wp_block, wp_navigation, the user's lists), the Site Editor views at per_page=20, both in context=edit
     with no _fields, and the page-parent picker (per_page=100, _fields=id,title,parent). Every page of each
     list is read (X-WP-TotalPages). None may answer rest_list_too_large.
Prints the X-PF-List-Content of each list (KiB of post content it loaded, or light) and the largest, which is
the margin under the budget. Exit 1 on any refusal or any editor page that is not a 200.
"""
import json, os, sys, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import break_lib  # the same login and opener as woo.py and break.py: no redirects followed, the 302 asserted, Turnstile

if not os.environ.get('B') or not os.environ.get('ADMIN_PASSWORD'):
    sys.exit('editor-lists: set B and ADMIN_PASSWORD')
try:
    o = break_lib.login()
except AssertionError as e:
    sys.exit('editor-lists: login failed: %s' % (str(e)[:200],))


def get(path, h=None):
    r = break_lib.req(o, path, headers=h, timeout=300)
    hd = r.get('h') or {}
    return (r['code'] if r['code'] != 'EXC' else 0), {k.lower(): v for k, v in hd.items()}, r.get('body') or b''


nonce = o.nonce
H = {'X-WP-Nonce': nonce}
fail, sized = [], []


def rest(route, q):
    return get('/?rest_route=' + route + '&' + urllib.parse.urlencode(q), H)


def newest(rb):
    st, _, b = rest('/wp/v2/' + rb, {'per_page': 1, 'context': 'edit', '_fields': 'id', 'status': 'any'})
    try:
        return json.loads(b)[0]['id'] if st == 200 else None
    except Exception:
        return None


# 2 first: the types and their REST bases.
st, _, b = get('/?rest_route=/wp/v2/types&context=edit', H)
types = json.loads(b) if st == 200 else {}
if not types:
    sys.exit('editor-lists: /wp/v2/types answered %d' % st)
lists = []
for name, t in sorted(types.items()):
    rb, ns = t.get('rest_base'), t.get('rest_namespace', 'wp/v2')
    if not rb or ns != 'wp/v2' or name in ('wp_template', 'wp_template_part', 'wp_global_styles', 'wp_font_face', 'wp_font_family'):
        continue  # templates and styles have their own controllers, which this plugin does not touch
    route = '/wp/v2/' + rb
    lists.append((name + ' per_page:-1 (100)', route, {'per_page': 100, 'context': 'edit', 'status': 'any'} if name != 'attachment' else {'per_page': 100, 'context': 'edit'}))
    lists.append((name + ' view per_page:20', route, {'per_page': 20, 'context': 'edit'}))
lists.append(('page parent picker', '/wp/v2/pages', {'per_page': 100, 'context': 'edit', '_fields': 'id,title,parent', 'orderby': 'menu_order', 'order': 'asc'}))
for label, route, q in lists:
    page, pages = 1, 1
    while page <= pages:
        st, h, b = rest(route, {**q, 'page': page})
        code = ''
        if st != 200:
            try:
                code = json.loads(b).get('code', '')
            except Exception:
                code = ''
        pc = h.get('x-pf-list-content', '-')
        sized.append((label + ('' if page == 1 else ' p%d' % page), st, pc, code))
        if code == 'rest_list_too_large' or b'rest_list_too_large' in b:
            fail.append('%s page %d: rest_list_too_large' % (label, page))
        if st == 200:
            pages = int(h.get('x-wp-totalpages', '1') or 1)
        page += 1
# 1: the editor pages.
pid, gid = newest('posts'), newest('pages')
screens = ['/wp-admin/post-new.php', '/wp-admin/post-new.php?post_type=page', '/wp-admin/edit.php', '/wp-admin/edit.php?post_type=page',
           '/wp-admin/site-editor.php', '/wp-admin/site-editor.php?p=%2Fpage', '/wp-admin/site-editor.php?p=%2Ftemplate',
           '/wp-admin/site-editor.php?p=%2Fpattern', '/wp-admin/site-editor.php?p=%2Fnavigation']
if pid:
    screens.append('/wp-admin/post.php?post=%d&action=edit' % pid)
if gid:
    screens.append('/wp-admin/post.php?post=%d&action=edit' % gid)
if 'product' in types:
    screens += ['/wp-admin/edit.php?post_type=product', '/wp-admin/post-new.php?post_type=product']
for s in screens:
    st, h, b = get(s)
    bad = b'rest_list_too_large' in b
    print('  page  %-60s %d%s' % (s, st, '  rest_list_too_large' if bad else ''))
    if st != 200 or bad:
        fail.append('%s: %d%s' % (s, st, ' rest_list_too_large' if bad else ''))
for label, st, pc, code in sized:
    print('  list  %-40s %d  X-PF-List-Content %s%s' % (label, st, pc, ('  ' + code) if code else ''))
kib = [(int(pc), label) for label, st, pc, code in sized if pc.isdigit()]
top = max(kib) if kib else (0, 'none sized')
print('editor-lists: largest content loaded by one list: %d KiB (%s); %d lists light; %d refused; %d failing'
      % (top[0], top[1], sum(1 for x in sized if x[2] == 'light'), sum(1 for x in sized if x[3] == 'rest_list_too_large'), len(fail)))
for f in fail:
    print('  FAIL ' + f)
sys.exit(1 if fail else 0)
