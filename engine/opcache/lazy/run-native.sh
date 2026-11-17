#!/bin/bash
# #582 S4 M2b: the lazy-body contract suite (probe.php) on a NATIVE php-cli built with pf-lazy-bodies.patch.
#   engine/opcache/lazy/run-native.sh <php-cli> <opcache.so>
# Primes a file cache from the fixtures (opcache_compile_file, so nothing runs), then runs each case of probe.php in
# its own process four ways, each on a fresh copy of that cache: lazy (a body loads at the first call of its function),
# script (opcache.pagefeather_lazy_unit=script: the first call into a script loads all of its bodies), eager (the same
# engine, opcache.pagefeather_lazy_load=0) and compiled (OPcache off). A case passes when "out" is the same in all
# four and neither lazy run lists a failed check. tcbad must stop with the trait-collision fatal in every mode.
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
# The hot-set cache (stage 5): oc0's files, plus the .hot profiles that opcache.pagefeather_profile=1 writes while
# the cases run (and prof_hot.php, which makes only a and b of f_hot.php hot). The probe's own files are dropped.
cp -R "$work/oc0" "$work/oc2"
for c in plain methods refl copy fail never missing ic xref; do
  "$php" "${opc[@]}" -d "opcache.file_cache=$work/oc2" -d opcache.pagefeather_profile=1 "$work/probe.php" "$c" profile > /dev/null 2>&1
done
"$php" "${opc[@]}" -d "opcache.file_cache=$work/oc2" -d opcache.pagefeather_profile=1 "$work/prof_hot.php" > /dev/null 2>&1
find "$work/oc2" \( -name 'probe.php.bin*' -o -name 'prof_hot.php.bin*' \) -exec rm -f {} +
echo "prime: $(find "$work/oc2" -name '*.hot' | wc -l | tr -d ' ') hot profiles"
n=$(find "$work/oc0" -name "*.bin" | wc -l | tr -d " ")
[ "$n" -ge 15 ] || { echo "prime: only $n .bin files written"; exit 1; }
rc=0
for case in plain methods refl copy fail never missing ic xref xstr hot tcbad; do
  for mode in lazy script hot eager compiled; do
    src=oc0; [ "$case" = xstr ] && src=oc1; [ "$mode" = hot ] && [ "$case" != xstr ] && src=oc2
    rm -rf "$work/oc"; cp -R "$work/$src" "$work/oc"
    extra=(); [ "$mode" = eager ] && extra=(-d opcache.pagefeather_lazy_load=0); [ "$mode" = compiled ] && extra=(-d opcache.enable_cli=0)
    [ "$mode" = script ] && extra=(-d opcache.pagefeather_lazy_unit=script)
    [ "$mode" = hot ] && extra=(-d opcache.pagefeather_lazy_unit=hot)
    [ "$case" = xstr ] && extra+=(-d opcache.interned_strings_buffer=1)
    "$php" "${opc[@]}" -d "opcache.file_cache=$work/oc" ${extra[@]+"${extra[@]}"} "$work/probe.php" "$case" "$mode" > "$work/$case.$mode.out" 2>&1
  done
  python3 -I - "$work" "$case" <<'PY' || rc=1
import json, sys
work, case = sys.argv[1], sys.argv[2]
txt = {m: open("%s/%s.%s.out" % (work, case, m)).read() for m in ("lazy", "script", "hot", "eager", "compiled")}
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
        if got["script"]["out"] != got["compiled"]["out"]:
            why.append("script out differs from compiled: %s" % json.dumps(got["script"]["out"])[:300])
        why += ["lazy: " + f for f in got["lazy"]["fail"]]
        why += ["script: " + f for f in got["script"]["fail"]]
        if got["hot"]["out"] != got["compiled"]["out"]:
            why.append("hot out differs from compiled: %s" % json.dumps(got["hot"]["out"])[:300])
        why += ["hot: " + f for f in got["hot"]["fail"]]
        lz, ht = got["lazy"].get("lb") or {}, got["hot"].get("lb") or {}
        if case != "hot":
            # every function a case calls was profiled hot, so the hot unit loads the same bodies as lazy, in fewer reads
            for k in ("body_loads", "body_fail"):
                if ht.get(k) != lz.get(k):
                    why.append("hot %s %r, lazy %r: the hot set loaded other bodies" % (k, ht.get(k), lz.get(k)))
            if case != "xstr" and (lz.get("body_loads") or 0) > 0 and not (ht.get("hot_loads") or 0) > 0:
                why.append("hot: no hot load at all (hot_loads %r): the profile or the unit did not take" % ht.get("hot_loads"))
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
