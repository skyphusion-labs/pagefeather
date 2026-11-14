#!/usr/bin/env python3
# Compare WordPress's upload decisions on two engines (#582 S2b): the full fileinfo database (the oracle,
# a standard host) and the engine under test.
#   accepted: ACCEPTED on both (gate a); wp-quirk: refused on both (WordPress's own refusal, reason given)
#   accepted, wp-quirk, disguise, refused: the SAME decision (accepted or not) on both
#   disguise and refused: refused on both (a sanity check of the oracle itself)
#   known-diff: the decision its manifest entry names (differs or same): the documented limit, #582
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
    # gate (a): an accepted type must be ACCEPTED, on the full-database engine and on the one under test
    if m['class'] == 'accepted' and not (a['accepted'] and b['accepted']):
        bad.append('%s (accepted type): oracle %s %s, under test %s %s' % (f, a['http'], a.get('code') or (a.get('head') or '')[:60], b['http'], b.get('code') or (b.get('head') or '')[:60])); continue
    # a WordPress quirk must be refused on both (it is WordPress's own refusal on a standard host)
    if m['class'] == 'wp-quirk' and (a['accepted'] or b['accepted']):
        bad.append('%s (wp-quirk): now accepted (oracle %s, under test %s): update the quirk list' % (f, a['accepted'], b['accepted'])); continue
    if m['class'] == 'known-diff':
        want = m.get('decision', 'differs')
        if (a['accepted'] != b['accepted']) != (want == 'differs'):
            bad.append('%s: known-diff expected to decide %s, but oracle %s, under test %s: update the limit in #582' % (f, want, a['accepted'], b['accepted']))
    elif a['accepted'] != b['accepted']:
        bad.append('%s (%s): oracle %s, under test %s' % (f, m['class'], 'accepted' if a['accepted'] else 'refused ' + str(a['code']), 'accepted' if b['accepted'] else 'refused ' + str(b['code'])))
n = {c: sum(1 for m in man.values() if m['class'] == c) for c in ('accepted', 'wp-quirk', 'disguise', 'refused', 'known-diff')}
acc = sum(1 for f, m in man.items() if m['class'] == 'accepted' and full.get(f, {}).get('accepted') and got.get(f, {}).get('accepted'))
print('@event upload-sniff-compare ' + json.dumps({'holds': not bad, 'fixtures': n, 'accepted_on_both': acc, 'differences': len(bad)}))
print('%d accepted types: accepted on both engines (of %d); %d WordPress quirks refused on both, each with its reason in the manifest' % (acc, n['accepted'], n['wp-quirk']))
for f, m in sorted(man.items()):
    if got.get(f, {}).get('warnings_in_body') or full.get(f, {}).get('warnings_in_body'):
        print('  accepted, 200 with PHP warnings before the JSON %-10s oracle %s under test %s: %s' % (f, full[f]['http'], got[f]['http'], (got[f].get('head') or '')[:80]))
for f, m in sorted(man.items()):
    if m['class'] == 'wp-quirk':
        print('  wp-quirk %-10s %s' % (f, m['why']))
for x in bad:
    print('  ' + x)
sys.exit(1 if bad else 0)
