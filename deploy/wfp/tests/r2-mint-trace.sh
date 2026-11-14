#!/bin/bash
# #545, test-side only: the R2_CRED_REFRESH of r2-temp-test.sh's stress case. It logs, around the
# real mint, the pid, the time, the credential file's mtime and the .minted stamp's mtime, so a
# double mint shows how the two ran. (With the old mkdir lock it showed two mints at once, both
# with the lock dir present: CI run 43581599616.) r2-mint-trace.sh <trace> <rt> <bucket> <file>
t=$1 rt=$2 b=$3 f=$4
st() { python3 -I -c 'import os, sys, time; f = sys.argv[1]; m = lambda p: os.path.getmtime(p) if os.path.exists(p) else -1; print("%.3f mtime=%.3f minted=%.3f" % (time.time(), m(f), m(f + ".minted")))' "$f"; }
echo "start pid=$$ ppid=$PPID $(st)" >> "$t"
python3 -I "$rt" mint "$b" 900 "$f"; rc=$?
echo "end pid=$$ rc=$rc $(st)" >> "$t"
exit "$rc"
