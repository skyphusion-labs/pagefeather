#!/usr/bin/env python3
# Compare WordPress's upload decisions on two engines (#582 S2b): the full fileinfo database (the oracle,
# a standard host) and the engine under test.
#   accepted, disguise, refused: the SAME decision (accepted or not) on both
#   disguise and refused: refused on both (a sanity check of the oracle itself)
#   known-diff: a DIFFERENT decision (the documented limit of a trimmed database, #582)
# Exit 0 when all hold, 1 when not (naming each fixture).
#   python3 tests/upload-sniff-compare.py <manifest.json> <oracle.json> <under-test.json>
import json, sys
man = {m['file']: m for m in json.load(open(sys.argv[1]))}
full, got = json.load(open(sys.argv[2])), json.load(open(sys.argv[3]))
bad = []
for f, m in sorted(man.items()):
    a, b = full.get(f), got.get(f)
    if a is None or b is None:
        bad.append('%s: missing from a record' % f); continue
    if m['class'] in ('disguise', 'refused') and a['accepted']:
        bad.append('%s: the oracle ACCEPTED a %s file (%s)' % (f, m['class'], a)); continue
    if m['class'] == 'known-diff':
        if a['accepted'] == b['accepted']:
            bad.append('%s: known-diff now decided the same (%s): update the limit in #582' % (f, b['accepted']))
    elif a['accepted'] != b['accepted']:
        bad.append('%s (%s): oracle %s, under test %s' % (f, m['class'], 'accepted' if a['accepted'] else 'refused ' + str(a['code']), 'accepted' if b['accepted'] else 'refused ' + str(b['code'])))
n = {c: sum(1 for m in man.values() if m['class'] == c) for c in ('accepted', 'disguise', 'refused', 'known-diff')}
acc = sum(1 for f, m in man.items() if m['class'] == 'accepted' and full.get(f, {}).get('accepted'))
print('@event upload-sniff-compare ' + json.dumps({'holds': not bad, 'fixtures': n, 'oracle_accepts_of_accepted_class': acc, 'differences': len(bad)}))
for x in bad:
    print('  ' + x)
sys.exit(1 if bad else 0)
