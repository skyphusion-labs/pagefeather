#!/usr/bin/env python3
"""#589: measure394.page_body, the JSON of each REST draft create. Unset REST_CONTENT_KIB keeps the old
body exactly (a title and status draft), so earlier runs stay comparable. REST_CONTENT_KIB=N adds about N KiB
of paragraph blocks: WordPress renders that content for the create's answer AFTER the insert, which widens the
window in which an object reset kills a create that already wrote (the population #589's rolled-back share
needs). Offline: no network.
  python3 -I spikes/b2-wordpress/tests/measure394-body-test.py"""
import os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.argv = [sys.argv[0], 'bodytest']
import measure394 as M

fail = 0
def check(name, ok):
    global fail
    fail += not ok
    print('%s %s' % ('PASS' if ok else 'FAIL', name))

os.environ.pop('REST_CONTENT_KIB', None)
check('unset: the body is the title and status draft, nothing else', M.page_body('t1') == {'title': 't1', 'status': 'draft'})
os.environ['REST_CONTENT_KIB'] = '0'
check('0: the same as unset', M.page_body('t1') == {'title': 't1', 'status': 'draft'})
os.environ['REST_CONTENT_KIB'] = '16'
b = M.page_body('t2')
c = b.get('content', '')
check('16: title and status kept', b.get('title') == 't2' and b.get('status') == 'draft')
check('16: content is 16 to 17 KiB', 16 * 1024 <= len(c.encode()) <= 17 * 1024)
blocks = re.findall(r'<!-- wp:paragraph -->\n<p>[^<]+</p>\n<!-- /wp:paragraph -->', c)
check('16: only whole paragraph blocks', len(blocks) > 1 and ''.join(x + '\n\n' for x in blocks).strip() == c.strip())
check('16: the same body every time (comparable runs)', M.page_body('t2') == b)
for bad in ('x', '-1', '1.5', '4097'):
    os.environ['REST_CONTENT_KIB'] = bad
    try:
        M.page_body('t3'); ok = False
    except SystemExit:
        ok = True
    check('%s is refused (a whole number 0 to 4096)' % bad, ok)
print('%d failing check(s)' % fail)
sys.exit(1 if fail else 0)
