#!/usr/bin/env python3
# Select the trimmed magic database (#582 S2b). A top-level magic entry (its first line and every
# continuation and annotation line under it) is kept when its own !:ext is an accepted extension, its
# own !:mime is an accepted type, or a !:mime matches a rejection signature; then every "name" block a
# kept entry reaches through "use" is kept too. Nothing else.
#   select.py <Magdir> <out-dir> <accepted.txt> <rejection.txt>
import os, re, sys
src, out, accf, rejf = sys.argv[1:5]
acc = [l.split() for l in open(accf) if l.startswith(('EXT ', 'MIME '))]
EXT = set(next(a for a in acc if a[0] == 'EXT')[1:]); MIME = set(next(a for a in acc if a[0] == 'MIME')[1:])
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
kept = set()
for i, (f, e) in enumerate(allent):
    if set(exts(e)) & EXT or set(mimes(e)) & MIME or any(r.match(m) for m in mimes(e) for r in REJ):
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
