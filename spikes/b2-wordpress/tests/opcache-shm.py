#!/usr/bin/env python3
"""Summarise an admin-e2e OPcache shared-memory reading (#610).

    python3 tests/opcache-shm.py <_mem.json> [dump.zip]

num_cached_scripts is the scripts in shared memory. The dump zip is the file
cache (/_opcache-dump). Each script that did not fit takes store_script_in_file_cache.
/_opcache-dump skips wp-runtime.php.bin, which still counts in cached, so when
shared memory is full, fallbacks = dump_bins - cached + 1. When it is not full,
every compiled script fitted and fallbacks are 0. The issue's 765 of 2,076 is
that difference at memory_consumption 48 against 128.

Does not print a secret. Exit 2 on usage, 1 on a malformed reading.
"""
import json
import os
import sys
import zipfile


def dump_bins(path):
    names = zipfile.ZipFile(path).namelist()
    n = 0
    for name in names:
        if not name.endswith(".bin"):
            continue
        if name.endswith("internal/eval.php.bin"):
            continue
        if name.endswith("wp-runtime.php.bin"):
            continue
        n += 1
    return n


def mib(n):
    if n is None:
        return None
    return round(float(n) / 1048576.0, 2)


def summarize(mem, bins=None):
    ini = mem.get("ini") if isinstance(mem, dict) else None
    if not isinstance(ini, dict):
        raise ValueError("/_mem JSON has no ini object")
    try:
        cached = int(ini["cached"])
    except (KeyError, TypeError, ValueError):
        raise ValueError("ini.cached is missing")
    try:
        mc = int(str(ini.get("mc") or "0"))
    except ValueError:
        raise ValueError("ini.mc is not an integer")
    usage = ini.get("mem") if isinstance(ini.get("mem"), dict) else {}
    used = usage.get("used_memory")
    free = usage.get("free_memory")
    wasted = usage.get("wasted_memory")
    wasm_bytes = mem.get("wasmMemoryBytes")
    wasm_mib = mib(wasm_bytes)
    wasm_mib_round = None if wasm_bytes is None else int(round(float(wasm_bytes) / 1048576.0))
    cap = mc * 1048576 if mc else None
    shm_full = False
    if cap and used is not None:
        shm_full = (0 if free is None else int(free)) < 1048576 or float(used) / cap >= 0.98
    # /_opcache-dump skips wp-runtime.php.bin (index.js), which still counts in
    # num_cached_scripts. The issue's 765 is total compiled minus cached; with the
    # dump that is dump_bins - cached + 1, floored at 0. A size that is not full
    # held every script, so fallbacks are 0 even if the skip makes dump_bins == cached - 1.
    fallbacks = None
    if bins is not None:
        fallbacks = 0 if not shm_full else max(0, bins - cached + 1)
    lb = ini.get("lb") if isinstance(ini.get("lb"), dict) else None
    row = {
        "mc": mc,
        "cached": cached,
        "dump_bins": bins,
        "fallbacks": fallbacks,
        "shm_used_mib": mib(used),
        "shm_free_mib": mib(free),
        "shm_wasted_mib": mib(wasted),
        "shm_full": shm_full,
        "wasm_mib": wasm_mib,
        "wasm_mib_round": wasm_mib_round,
        "fco": ini.get("fco"),
        "split_scripts": None if lb is None else lb.get("split_scripts"),
        "lazy_scripts": None if lb is None else lb.get("lazy_scripts"),
        "eager_scripts": None if lb is None else lb.get("eager_scripts"),
        "body_bytes_mib": None if lb is None else mib(lb.get("body_bytes")),
    }
    return row


def main(argv):
    if len(argv) not in (2, 3):
        print("usage: opcache-shm.py <_mem.json> [dump.zip]", file=sys.stderr)
        return 2
    try:
        mem = json.load(open(argv[1]))
    except (OSError, ValueError) as e:
        print("opcache-shm.py: cannot read %s: %s" % (argv[1], e), file=sys.stderr)
        return 1
    bins = None
    if len(argv) == 3:
        try:
            bins = dump_bins(argv[2])
        except (OSError, zipfile.BadZipFile) as e:
            print("opcache-shm.py: cannot read dump %s: %s" % (argv[2], e), file=sys.stderr)
            return 1
    try:
        row = summarize(mem, bins)
    except ValueError as e:
        print("opcache-shm.py: %s" % e, file=sys.stderr)
        return 1
    extra = os.environ.get("OPCACHE_SHM_EXTRA")
    if extra:
        row.update(json.loads(extra))
    json.dump(row, sys.stdout, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
