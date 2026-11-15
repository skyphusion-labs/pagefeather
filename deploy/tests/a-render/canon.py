"""Canonical form of a flat Wrangler TOML, for deploy/tests/a-render-test.sh (#666).

One line per setting, `<table> <key> = <value>`, sorted, comments and blank lines dropped, so two configs
that say the same thing compare equal whatever their order or comments. An array of tables ([[x]]) keeps its
index. PHP_ENV is JSON in a string: it is compared as JSON, and WP_TABLE_PREFIX "wp_" is dropped because
wp-config.php defaults to it (the same site either way). No TOML library: python3 -I on macOS is 3.9.

  python3 -I canon.py <config.toml>
"""
import json
import re
import sys


def strip_comment(line):
    q = None
    for i, c in enumerate(line):
        if q:
            if c == q:
                q = None
        elif c in "\"'":
            q = c
        elif c == '#':
            return line[:i]
    return line


def canon(path):
    out = []
    table = ''
    count = {}
    for raw in open(path, encoding='utf-8'):
        line = strip_comment(raw).strip()
        if not line:
            continue
        m = re.match(r'^\[\[([^\]]+)\]\]$', line)
        if m:
            count[m.group(1)] = count.get(m.group(1), -1) + 1
            table = '%s[%d]' % (m.group(1), count[m.group(1)])
            continue
        m = re.match(r'^\[([^\]]+)\]$', line)
        if m:
            table = m.group(1)
            continue
        k, sep, v = line.partition('=')
        if not sep:
            raise SystemExit('%s: not a key = value line: %r' % (path, line))
        k, v = k.strip(), v.strip()
        if table == 'vars' and k == 'PHP_ENV':
            env = json.loads(v[1:-1])
            if env.get('WP_TABLE_PREFIX') == 'wp_':
                del env['WP_TABLE_PREFIX']
            v = json.dumps(env, sort_keys=True)
        out.append('%s %s = %s' % (table or '-', k, v))
    return sorted(out)


if __name__ == '__main__':
    print('\n'.join(canon(sys.argv[1])))
