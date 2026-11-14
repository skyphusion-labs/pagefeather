#!/usr/bin/env python3
"""#545, test-side: does a lock exclude on this machine? lock-race.py <mkdir|flock> <procs> <iters>
Each process takes the lock iters times, logs enter/exit with time.time_ns, holds it 2 ms.
Prints the number of overlaps (two holders at once). The mkdir form is the exact shell pattern
of r2_refresh (mkdir "$F.lock" || skip; ...; rmdir "$F.lock"), run through /bin/sh."""
import os, subprocess, sys, tempfile, time
kind, procs, iters = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
d = tempfile.mkdtemp(); F = os.path.join(d, "cred"); open(F, "w").close(); log = os.path.join(d, "log")
SH_MKDIR = r'''for i in $(seq 1 %d); do
  if mkdir "$F.lock" 2>/dev/null; then
    python3 -I -c 'import time,sys; open(sys.argv[1],"a").write("in %%d\n" %% time.time_ns())' "$LOG"
    sleep 0.002
    python3 -I -c 'import time,sys; open(sys.argv[1],"a").write("out %%d\n" %% time.time_ns())' "$LOG"
    rmdir "$F.lock" 2>/dev/null || true
  fi
done''' % iters
PY_FLOCK = r'''import fcntl, os, sys, time
F, LOG, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
for _ in range(n):
    fd = os.open(F + ".lk", os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    f = open(LOG, "a"); f.write("in %d\n" % time.time_ns()); f.close(); time.sleep(0.002); f = open(LOG, "a"); f.write("out %d\n" % time.time_ns()); f.close()
    fcntl.flock(fd, fcntl.LOCK_UN); os.close(fd)'''
env = dict(os.environ, F=F, LOG=log)
ps = []
for _ in range(procs):
    if kind == "mkdir":
        ps.append(subprocess.Popen(["/bin/bash", "-c", SH_MKDIR], env=env))
    else:
        ps.append(subprocess.Popen([sys.executable, "-I", "-c", PY_FLOCK, F, log, str(max(1, iters // 10))], env=env))
for p in ps:
    p.wait()
ev = sorted((int(t), k) for k, t in (l.split() for l in open(log) if l.strip()))
held, over, n_in = 0, 0, 0
for t, k in ev:
    if k == "in":
        held += 1; n_in += 1
        if held > 1:
            over += 1
    else:
        held -= 1
print("%s: %d entries, %d overlaps" % (kind, n_in, over))
sys.exit(1 if over else 0)
