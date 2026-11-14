#!/bin/bash
# #545, test-side only: the R2_CRED_REFRESH of r2-temp-test.sh's stress case. It logs, around the
# real mint, the pid, the time, whether the lock dir exists and the credential file's mtime, so a
# double mint shows whether both mints ran inside one lock. r2-mint-trace.sh <trace> <rt> <bucket> <file>
t=$1 rt=$2 b=$3 f=$4
st() { python3 -I -c 'import os, sys, time; f = sys.argv[1]; print("%.3f lock=%s mtime=%.3f" % (time.time(), "y" if os.path.isdir(f + ".lock") else "n", os.path.getmtime(f) if os.path.exists(f) else -1))' "$f"; }
echo "start pid=$$ ppid=$PPID $(st)" >> "$t"
python3 -I "$rt" mint "$b" 900 "$f"; rc=$?
echo "end pid=$$ rc=$rc $(st)" >> "$t"
exit "$rc"
