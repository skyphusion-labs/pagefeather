#!/usr/bin/env python3
# The drift check of engine/fileinfo/accepted.txt (#582 S2b): its EXT and MIME lines must equal what the
# WordPress tree itself says, read from the source.
#   - wp_get_mime_types() (wp-includes/functions.php), as get_allowed_mime_types() leaves it: it removes
#     swf and exe (the check requires that unset line to still be there);
#   - the Font Library's types, WP_Font_Utils::get_allowed_font_mime_types()
#     (wp-includes/fonts/class-wp-font-utils.php), each PHP_VERSION_ID ternary taken as PHP 8.3 takes it.
# Exit 0 when they are equal, 1 naming each difference, 2 on a tree it cannot read.
#   check-accepted.py <wordpress-dir> <accepted.txt>
import re, sys
wp, acc = sys.argv[1:3]
fn = open(wp + '/wp-includes/functions.php', encoding='utf-8').read()
def body(src, name):
    m = re.search(r'\nfunction ' + name + r'\s*\(.*?\n}\n', src, re.S)
    if not m:
        print('check-accepted.py: %s not found' % name); sys.exit(2)
    return m.group(0)
mimes = body(fn, 'wp_get_mime_types')
pairs = re.findall(r"'([^']+)'\s*=>\s*'([^']+)'", mimes)
if len(pairs) < 50:
    print('check-accepted.py: only %d types read from wp_get_mime_types()' % len(pairs)); sys.exit(2)
allowed = body(fn, 'get_allowed_mime_types')
if "unset( $t['swf'], $t['exe'] );" not in allowed:
    print('check-accepted.py: get_allowed_mime_types() no longer removes swf and exe as expected'); sys.exit(2)
EXT, MIME = set(), set()
for k, v in pairs:
    if k in ('swf', 'exe'):
        continue
    EXT.update(k.split('|')); MIME.add(v)
fu = open(wp + '/wp-includes/fonts/class-wp-font-utils.php', encoding='utf-8').read()
fm = re.search(r'function get_allowed_font_mime_types\(\)\s*\{(.*?)\n\t}', fu, re.S)
if not fm:
    print('check-accepted.py: get_allowed_font_mime_types() not found'); sys.exit(2)
fb = fm.group(1)
php7 = re.search(r"\$php_7_ttf_mime_type\s*=\s*PHP_VERSION_ID >= 70300 \? '([^']+)'", fb)
fonts = 0
for ext, val in re.findall(r"'(\w+)'\s*=>\s*([^\n]+?),?\n", fb):
    # PHP 8.3 (PHP_VERSION_ID 80300 and later) takes the first branch of each "PHP_VERSION_ID >= N ? a : b"
    t = re.match(r"PHP_VERSION_ID >= (\d+) \? '([^']+)'", val.strip())
    v = t.group(2) if t else (re.match(r"'([^']+)'", val.strip()) or [None, None])[1]
    if t and int(t.group(1)) > 80300:
        print('check-accepted.py: a font type depends on a PHP version above 8.3: ' + val); sys.exit(2)
    if v is None:
        print('check-accepted.py: cannot read the font type of ' + ext); sys.exit(2)
    EXT.add(ext); MIME.add(v); fonts += 1
if fonts != 4:
    print('check-accepted.py: %d font types read, not 4' % fonts); sys.exit(2)
lines = {l.split()[0]: set(l.split()[1:]) for l in open(acc) if l.startswith(('EXT ', 'MIME '))}
bad = []
for name, want in (('EXT', EXT), ('MIME', MIME)):
    have = lines.get(name, set())
    for x in sorted(want - have): bad.append('%s missing %s (WordPress accepts it)' % (name, x))
    for x in sorted(have - want): bad.append('%s has %s (WordPress does not list it; libmagic names go on LIBMAGIC)' % (name, x))
print('@event check-accepted ' + '{"holds": %s, "ext": %d, "mime": %d, "differences": %d}' % ('true' if not bad else 'false', len(EXT), len(MIME), len(bad)))
for b in bad: print('  ' + b)
sys.exit(1 if bad else 0)
