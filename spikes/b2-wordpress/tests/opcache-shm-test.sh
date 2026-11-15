#!/bin/bash
# Test of opcache-shm.py, the #610 shared-memory reading. Synthetic /_mem JSON and dump
# zips; no wrangler. Also the wiring of opcache-shm.sh and the unchanged runtime default.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
PY="$HERE/opcache-shm.py"
SH="$HERE/opcache-shm.sh"
IDX="$HERE/../index.js"
T=$(mktemp -d "${TMPDIR:-/tmp}/opcache-shm-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
fails=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }

python3 -I -c '
import json, zipfile, sys
mem48 = {"bootMs": {}, "wasmMemoryBytes": 118816768, "ini": {
  "opcache": "1", "mc": "48", "fco": "0", "cached": 1314,
  "mem": {"used_memory": 50330272, "free_memory": 1376, "wasted_memory": 0},
  "lb": {"split_scripts": 1314, "lazy_scripts": 0, "eager_scripts": 0, "body_bytes": 31457280}
}}
mem128 = {"bootMs": {}, "wasmMemoryBytes": 180617216, "ini": {
  "opcache": "1", "mc": "128", "fco": "0", "cached": 2079,
  "mem": {"used_memory": 69793219, "free_memory": 64451837, "wasted_memory": 0},
  "lb": {"split_scripts": 2079, "lazy_scripts": 0, "eager_scripts": 0, "body_bytes": 44040192}
}}
json.dump(mem48, open(sys.argv[1] + "/mem48.json", "w"))
json.dump(mem128, open(sys.argv[1] + "/mem128.json", "w"))
z = zipfile.ZipFile(sys.argv[1] + "/dump2078.zip", "w")
for i in range(2078):
    z.writestr("h/wordpress/wp-includes/f%d.php.bin" % i, "x")
z.writestr("h/internal/eval.php.bin", "x")
z.writestr("h/wordpress/wp-runtime.php.bin", "x")
z.close()
' "$T"

run() { python3 -I "$PY" "$@" > "$T/out" 2>"$T/err"; echo $?; }

check "48 MB against a 2,078-file dump: fallbacks 765 (dump skips wp-runtime.php.bin)" "$(run "$T/mem48.json" "$T/dump2078.zip")" 0
j() { python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$T/out" "$1"; }
check "  cached 1314" "$(j cached)" 1314
check "  dump_bins 2078 (eval.php.bin and wp-runtime.php.bin skipped)" "$(j dump_bins)" 2078
check "  fallbacks 765" "$(j fallbacks)" 765
check "  shm_full 1 (free under 1 MiB)" "$(j shm_full)" True
check "  wasm_mib_round 113" "$(j wasm_mib_round)" 113
check "  split_scripts 1314" "$(j split_scripts)" 1314

check "128 MB against a dump one file short of cached: fallbacks 0 (not full)" "$(run "$T/mem128.json" "$T/dump2078.zip")" 0
check "  dump_bins 2078" "$(j dump_bins)" 2078
check "  cached 2079" "$(j cached)" 2079
check "  fallbacks 0" "$(j fallbacks)" 0
check "  shm_full 0" "$(j shm_full)" False
check "  shm_used_mib 66.56" "$(j shm_used_mib)" 66.56

check "no dump: fallbacks is null, exit 0" "$(run "$T/mem48.json")" 0
check "  dump_bins null" "$(j dump_bins)" None
check "  fallbacks null" "$(j fallbacks)" None

check "usage: exit 2" "$(run)" 2
check "missing mem: exit 1" "$(run "$T/missing.json")" 1
check "malformed ini: exit 1" "$(printf '%s\n' '{"ini":{}}' > "$T/bad.json"; run "$T/bad.json")" 1

# Extra fields from the runner (e2e wall time, engine hashes) merge through OPCACHE_SHM_EXTRA.
OPCACHE_SHM_EXTRA='{"e2e_s":321,"commit":"abc"}' python3 -I "$PY" "$T/mem48.json" "$T/dump2078.zip" > "$T/extra.json"
check "extra e2e_s merges" "$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["e2e_s"])' "$T/extra.json")" 321
check "extra does not drop fallbacks" "$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["fallbacks"])' "$T/extra.json")" 765

# Wiring: the runner is the issue's method, and it does not change the default.
check "opcache-shm.sh empties opcache.zip" "$(grep -c 'zipfile.ZipFile('\''build/opcache.zip'\'', '\''w'\'')' "$SH")" 1
check "opcache-shm.sh sets PHP_INI memory_consumption" "$(grep -c 'opcache.memory_consumption' "$SH")" 1
check "opcache-shm.sh runs e2e.sh" "$(grep -c '^\./e2e.sh ' "$SH")" 1
check "opcache-shm.sh reads /_mem" "$(grep -c '/_mem"' "$SH")" 1
check "opcache-shm.sh dumps the file cache" "$(grep -c '/_opcache-dump"' "$SH")" 1
check "opcache-shm.sh pins local creds" "$(grep -c 'local_creds' "$SH")" 1
check "opcache-shm.sh turns PHP_RECYCLE off" "$(grep -c 'PHP_RECYCLE:off' "$SH")" 1
check "index.js default memory_consumption stays 48" "$(grep -c "opcache.memory_consumption': '48'" "$IDX")" 1

echo "$fails failing case(s)"
[ "$fails" = 0 ]
