#!/usr/bin/env python3
# Select the trimmed magic database (#582 S2b). A top-level magic entry (its first line and every
# continuation and annotation line under it) is kept when an !:ext is an accepted extension, a !:mime is
# an accepted type, or a !:mime matches a rejection signature, counting the name blocks the entry
# reaches through "use" (transitively), or it is a wrapper ("indirect"); then those name blocks are kept
# too. Nothing else.
#   select.py <Magdir> <out-dir> <accepted.txt> <rejection.txt>
import os, re, sys
src, out, accf, rejf = sys.argv[1:5]
acc = [l.split() for l in open(accf) if l.startswith(('EXT ', 'MIME ', 'LIBMAGIC '))]
EXT = set(next(a for a in acc if a[0] == 'EXT')[1:])
MIME = set(next(a for a in acc if a[0] == 'MIME')[1:]) | set(next((a for a in acc if a[0] == 'LIBMAGIC'), ['LIBMAGIC'])[1:])
REJ = [re.compile(l.strip()) for l in open(rejf) if l.strip() and not l.startswith('#')]
def entries(text):
    cur = []
    for line in text.split('\n'):
        if line and re.match(r'^[^\s>#!]', line):
            if cur: yield cur
            cur = [line]
        elif cur:
            cur.append(line)
    if cur: yield cur
allent = []
for f in sorted(os.listdir(src)):
    for e in entries(open(os.path.join(src, f), encoding='latin-1').read()):
        allent.append((f, e))
names = {}
for i, (f, e) in enumerate(allent):
    m = re.match(r'^\S+\s+name\s+(\S+)', e[0])
    if m: names[m.group(1)] = i
def mimes(e): return [l[len('!:mime'):].strip() for l in e if l.startswith('!:mime')]
def exts(e): return [x for l in e if l.startswith('!:ext') for x in re.split(r'[\s/]+', l[len('!:ext'):].strip()) if x]
def used(e): return [m.group(1) for l in e for m in [re.search(r'\suse\s+\\?\^?(\S+)', l)] if m]
# An entry's types include those of every name block it reaches through "use", transitively: many
# formats (ELF, MP3, OOXML, BMP, ICO) carry their !:mime and !:ext only inside a name block.
def closure(i, seen=None):
    seen = seen if seen is not None else set()
    if i in seen: return set(), set()
    seen.add(i); e = allent[i][1]
    ms, xs = set(mimes(e)), set(exts(e))
    for u in used(e):
        if u in names:
            m2, x2 = closure(names[u], seen); ms |= m2; xs |= x2
    return ms, xs
kept = set()
for i, (f, e) in enumerate(allent):
    ms, xs = closure(i)
    # A wrapper (an entry with an "indirect" line, such as an ID3 tag before MP3 frames) is kept: libmagic
    # sniffs the content after it again, and that content is what WordPress gets.
    wrapper = any(re.match(r'^>*\S+\s+indirect\b', l) for l in e)
    if xs & EXT or ms & MIME or wrapper or any(r.match(m) for m in ms for r in REJ):
        kept.add(i)
todo = list(kept)
while todo:
    i = todo.pop()
    for l in allent[i][1]:
        m = re.search(r'\suse\s+\\?\^?(\S+)', l)
        if m and m.group(1) in names and names[m.group(1)] not in kept:
            kept.add(names[m.group(1)]); todo.append(names[m.group(1)])
os.makedirs(out, exist_ok=True)
byf = {}
for i in sorted(kept):
    byf.setdefault(allent[i][0], []).append('\n'.join(allent[i][1]))
for f, es in sorted(byf.items()):
    open(os.path.join(out, f), 'w', encoding='latin-1').write('\n'.join(es) + '\n')
print('select.py: %d of %d entries kept, in %d files' % (len(kept), len(allent), len(byf)))
