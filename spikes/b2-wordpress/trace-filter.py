#!/usr/bin/env python3
"""Cut a file trace down to the files two bundle zips hold (#394, approach A).

  python3 trace-filter.py <file-trace.json> <opcache.zip> <site.zip> <out.json>

Approach A has no local file trace: deploy/deploy.sh primes its OPcache on the D1 build, the way
opcache-a.sh does (#218), because A's database is MySQL and this laptop has no local one. The
D1 build is the same WordPress, WooCommerce and mu-plugins, but its trace also names files A does
not ship (wp-content/db.php.bin, d1-pdo.php, d1-dialect.php, the sqlite-database-integration
plugin). opcache-remote.py and site-remote.py refuse a traced file that is not in their zip
("another build?"), so this drops exactly those reads:
  - opcache:<dir>/<n> and opcache-open:<dir>/<n> when <n> is not in opcache.zip;
  - site:/<n> and site-open:/<n> when <n> is not in site.zip.
Every other key, the order, the boot flags and the request count stay as they are. A file that A
alone ships (hyperdrive-*.php) is not in the trace, so the pack scripts put it after the traced
files, by path: it is still in a pack, only later in the order.

Exit 0 written, 2 refused (the trace was not recorded with FILE_TRACE=on, or has no booting request;
nothing is written). Python 3.9 (Conrad's laptop): no tomllib, no match.
"""
import json, os, sys, zipfile

OC = '/internal/shared/opcache/'
PREFIXES = (('opcache:' + OC, 'oc'), ('opcache-open:' + OC, 'oc'), ('site:/', 'site'), ('site-open:/', 'site'))


def names(path):
    with zipfile.ZipFile(path) as z:
        return set(i.filename for i in z.infolist() if not i.is_dir())


def main():
    if len(sys.argv) != 5:
        print('usage: trace-filter.py <file-trace.json> <opcache.zip> <site.zip> <out.json>', file=sys.stderr)
        return 2
    tpath, opath, spath, out = sys.argv[1:5]
    trace = json.load(open(tpath))
    if trace.get('on') is not True:
        print('trace-filter: the trace was not recorded with FILE_TRACE=on', file=sys.stderr)
        return 2
    reqs = trace.get('requests') or []
    if not any(r.get('boot') for r in reqs):
        print('trace-filter: the trace has no booting request, so there is no cold-boot order to keep', file=sys.stderr)
        return 2
    have = {'oc': names(opath), 'site': names(spath)}
    dropped = {'oc': set(), 'site': set()}
    for r in reqs:
        kept = []
        for item in r.get('reads', []):
            k = item[0]
            for p, kind in PREFIXES:
                if k.startswith(p):
                    if k[len(p):] not in have[kind]:
                        dropped[kind].add(k[len(p):])
                        break
                    kept.append(item)
                    break
            else:
                kept.append(item)
        r['reads'] = kept
    tmp = out + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(trace, f)
    os.replace(tmp, out)
    print('trace-filter: dropped %d OPcache and %d site file(s) the zips do not hold, of %d request(s); wrote %s' % (
        len(dropped['oc']), len(dropped['site']), len(reqs), out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
