#!/bin/bash
# #582 S4 M2b: the lazy-body contract suite (probe.php) on a NATIVE php-cli built with pf-lazy-bodies.patch.
#   engine/opcache/lazy/run-native.sh <php-cli> <opcache.so>
# Primes a file cache from the fixtures (opcache_compile_file, so nothing runs), then runs each case of probe.php in
# its own process three ways, each on a fresh copy of that cache: lazy (bodies load at first call), eager (the same
# engine, opcache.pagefeather_lazy_load=0) and compiled (OPcache off). A case passes when "out" is the same in all
# three and the lazy run lists no failed check. tcbad must stop with the trait-collision fatal in every mode.
# Prints "@event lazy-case {json}" per case; exit 1 on any failure. The wasm engine runs the same probe through
# spikes/b2-wordpress/tests/lazy-bodies.test.mjs.
set -u
php=${1:?php-cli}; so=${2:?opcache.so}
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/pf582-lazy.XXXXXX")
trap 'rm -rf "$work"' EXIT
cp "$here"/*.php "$work/"
opc=(-n -d "zend_extension=$so" -d opcache.enable_cli=1 -d opcache.validate_timestamps=0 -d opcache.file_update_protection=0
  -d opcache.memory_consumption=64 -d opcache.interned_strings_buffer=8 -d opcache.max_accelerated_files=4000)
# Case xstr runs with a FULL 1 MB interned-string buffer, from its own primed cache: f_0fill.php (generated here,
# compiled first) fills it, so later literals are not interned, as on the Worker (4 MB, full on WordPress).
"$php" -n -r 'echo "<?php\nfunction pf_lb_fill() { return array("; for ($i = 0; $i < 30000; $i++) { echo "\"pf-lb-fill-", $i, "-", str_repeat("q", 40), "\","; } echo "); }\n";' > "$work/f_0fill.php"
prime() { # <dir> [extra -d ...]
mkdir "$work/$1"; d=$1; shift
"$php" "${opc[@]}" -d "opcache.file_cache=$work/$d" "$@" -r '
  foreach (glob($argv[1] . "/f_*.php") as $f) { if (!opcache_compile_file($f)) { echo "prime: could not compile $f\n"; exit(1); } }
  $s = opcache_get_status(false)["pagefeather_lazy_bodies"] ?? null;
  echo "prime: ", json_encode($s), "\n";' "$work" || exit 1
}
prime oc0
prime oc1 -d opcache.interned_strings_buffer=1
n=$(find "$work/oc0" -name "*.bin" | wc -l | tr -d " ")
[ "$n" -ge 15 ] || { echo "prime: only $n .bin files written"; exit 1; }
rc=0
for case in plain methods refl copy fail never missing ic xref xstr tcbad; do
  for mode in lazy eager compiled; do
    src=oc0; [ "$case" = xstr ] && src=oc1
    rm -rf "$work/oc"; cp -R "$work/$src" "$work/oc"
    extra=(); [ "$mode" = eager ] && extra=(-d opcache.pagefeather_lazy_load=0); [ "$mode" = compiled ] && extra=(-d opcache.enable_cli=0)
    [ "$case" = xstr ] && extra+=(-d opcache.interned_strings_buffer=1)
    "$php" "${opc[@]}" -d "opcache.file_cache=$work/oc" ${extra[@]+"${extra[@]}"} "$work/probe.php" "$case" "$mode" > "$work/$case.$mode.out" 2>&1
  done
  python3 -I - "$work" "$case" <<'PY' || rc=1
import json, sys
work, case = sys.argv[1], sys.argv[2]
txt = {m: open("%s/%s.%s.out" % (work, case, m)).read() for m in ("lazy", "eager", "compiled")}
why = []
if case == "tcbad":
    for m, t in txt.items():
        if "collision" not in t or "NO COLLISION" in t:
            why.append("%s: want the trait-collision fatal, got %r" % (m, t.strip()[-200:]))
    ev = {"case": case, "ok": not why}
else:
    got = {}
    for m, t in txt.items():
        try:
            got[m] = json.loads(t.strip().splitlines()[-1])
        except Exception:
            why.append("%s printed no JSON: %r" % (m, t.strip()[-300:]))
    if not why:
        if got["lazy"]["out"] != got["compiled"]["out"]:
            why.append("lazy out differs from compiled: %s vs %s" % (json.dumps(got["lazy"]["out"])[:400], json.dumps(got["compiled"]["out"])[:400]))
        if got["eager"]["out"] != got["compiled"]["out"]:
            why.append("eager out differs from compiled")
        why += ["lazy: " + f for f in got["lazy"]["fail"]]
        if any(t.lstrip().startswith(("PHP ", "Warning", "Fatal", "Notice", "Deprecated")) for t in txt.values()):
            why.append("a run printed a diagnostic before its JSON")
    ev = {"case": case, "ok": not why, "lb": got.get("lazy", {}).get("lb")}
print("@event lazy-case " + json.dumps(ev))
for w in why:
    print("  FAIL %s: %s" % (case, w))
sys.exit(1 if why else 0)
PY
done
[ "$rc" = 0 ] && echo "lazy-native: all cases pass" || echo "lazy-native: FAILED"
exit $rc
