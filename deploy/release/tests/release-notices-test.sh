#!/bin/bash
# A release that ships an engine must carry the notices directory, SOURCE, and
# NOTICE (#584; Ernst's section 3 on #582). Offline: it reads the committed
# notices and the packager, and never fetches. Each refusal has a passing
# control in the same file (the prefix case, the sha256 of a local row).
#
#   bash deploy/release/tests/release-notices-test.sh
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
fails=0
check() {
  if [ "$2" = "$3" ]; then echo "  ok   $1"
  else echo "  FAIL $1: got '$2', want '$3'"; fails=$((fails + 1)); fi
}

# 1. Repo-level NOTICE (Ernst section 3 item 2: the PHP and Zend lines).
check "repo NOTICE exists" "$([ -f "$ROOT/NOTICE" ] && echo yes || echo no)" yes
if [ -f "$ROOT/NOTICE" ]; then
  check "NOTICE has the PHP acknowledgment" "$(grep -c 'This product includes PHP software, freely available from' "$ROOT/NOTICE")" 1
  check "NOTICE has the Zend acknowledgment" "$(grep -c 'This product includes the Zend Engine, freely available at' "$ROOT/NOTICE")" 1
fi

# 2. build-bundle.sh must run the packager before it writes SHA256SUMS, so a
#    release cannot forget the assets. The existing SHA256SUMS line hashes
#    every other file in release/, so the packager's files are included.
bb="$HERE/build-bundle.sh"
check "build-bundle.sh calls package-notices.sh" "$(grep -c 'package-notices.sh' "$bb")" 1
pn_line=$(grep -n 'package-notices.sh' "$bb" | head -1 | cut -d: -f1)
sum_line=$(grep -n 'SHA256SUMS' "$bb" | grep -c .)
check "build-bundle.sh still writes SHA256SUMS" "$([ "${sum_line:-0}" -ge 1 ] && echo yes || echo no)" yes
if [ -n "${pn_line:-}" ]; then
  after=$(awk -v n="$pn_line" 'NR>n && /SHA256SUMS/ {print NR; exit}' "$bb")
  check "package-notices.sh runs before SHA256SUMS is written" "$([ -n "$after" ] && echo yes || echo no)" yes
fi

# 3. A fake release dir, as build-bundle.sh leaves it before SHA256SUMS: modules
#    already copied, then the packager adds NOTICE, SOURCE, LICENSES.tar.gz.
pack="$HERE/package-notices.sh"
check "package-notices.sh exists" "$([ -x "$pack" ] && echo yes || echo no)" yes
T=$(mktemp -d "${TMPDIR:-/tmp}/release-notices.XXXXXX")
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/release"
echo dummy > "$T/release/index.js"
echo dummy > "$T/release/c6-php.wasm"
if [ -x "$pack" ]; then
  out=$(bash "$pack" "$T/release" 2>&1); rc=$?
  check "package-notices.sh into a fake release dir exits 0" "$rc" 0
  [ "$rc" = 0 ] || echo "$out"
else
  check "package-notices.sh into a fake release dir exits 0" missing 0
fi

# Asset list: the three #584 files sit next to the wasm, not inside modules/.
for f in NOTICE SOURCE LICENSES.tar.gz; do
  check "release asset list contains $f" "$([ -f "$T/release/$f" ] && echo yes || echo no)" yes
done
check "the packager did not remove the dummy wasm" "$([ -f "$T/release/c6-php.wasm" ] && echo yes || echo no)" yes

# 4. LICENSES.tar.gz is the notices directory: one file per licenses.tsv row,
#    body sha256 equal to the pin. python3 -I, 3.9-safe.
if [ -f "$T/release/LICENSES.tar.gz" ]; then
  mkdir -p "$T/lic"
  tar -xzf "$T/release/LICENSES.tar.gz" -C "$T/lic"
  check "the tar unpacks a LICENSES directory" "$([ -d "$T/lic/LICENSES" ] && echo yes || echo no)" yes
  pyout=$(python3 -I - "$ROOT/engine/licenses.tsv" "$T/lic/LICENSES" <<'PY'
import hashlib, os, sys
tsv, licdir = sys.argv[1], sys.argv[2]
rows, missing, bad = [], [], []
for line in open(tsv, encoding='utf-8'):
    if line.startswith('#') or not line.strip():
        continue
    f = line.rstrip('\n').split('\t')
    if len(f) != 10:
        print('bad-row %s' % f[0]); sys.exit(2)
    rows.append(f)
    path = os.path.join(licdir, f[0])
    if not os.path.isfile(path):
        missing.append(f[0]); continue
    raw = open(path, 'rb').read()
    # licenses.py writes a Component/Version/Licence/Source header, then a blank
    # line, then the pinned text.
    sep = b'\n\n'
    body = raw.split(sep, 1)[1] if sep in raw else raw
    got = hashlib.sha256(body).hexdigest()
    if got != f[9]:
        bad.append('%s %s' % (f[0], got))
print('rows %d' % len(rows))
print('missing %d' % len(missing))
print('badsha %d' % len(bad))
if missing:
    print('missing-names %s' % ','.join(missing))
if bad:
    print('badsha-names %s' % ';'.join(bad))
PY
)
  echo "$pyout"
  check "licenses.tsv has rows" "$(echo "$pyout" | awk '/^rows /{print ($2>0)?"yes":"no"}')" yes
  check "every licenses.tsv row has a file in LICENSES/" "$(echo "$pyout" | awk '/^missing /{print ($2==0)?"yes":"no"}')" yes
  check "every licence body matches its pinned sha256" "$(echo "$pyout" | awk '/^badsha /{print ($2==0)?"yes":"no"}')" yes
fi

# 5. SOURCE names the pinned upstream (Ernst section 3 item 4: a pointer, not
#    a tarball of every tree). Values come from engine/UPSTREAM.
if [ -f "$T/release/SOURCE" ]; then
  . "$ROOT/engine/UPSTREAM"
  check "SOURCE names the Playground commit" "$(grep -F "$UPSTREAM_COMMIT" "$T/release/SOURCE" >/dev/null && echo yes || echo no)" yes
  check "SOURCE names the php-src tag" "$(grep -F "$PHP_REF" "$T/release/SOURCE" >/dev/null && echo yes || echo no)" yes
  check "SOURCE names the php-src commit" "$(grep -F "$PHP_REF_COMMIT" "$T/release/SOURCE" >/dev/null && echo yes || echo no)" yes
  check "SOURCE names Emscripten" "$(grep -F "$EMSDK_VERSION" "$T/release/SOURCE" >/dev/null && echo yes || echo no)" yes
  check "SOURCE names the pinned Playground wasm sha256" "$(grep -F "$SHIPPED_WASM_SHA256" "$T/release/SOURCE" >/dev/null && echo yes || echo no)" yes

  # 5b. The shipped php_8_3.wasm is not that pin byte for byte. prepare.sh
  #     (the memory-import transform and the loader patch) produces it, and
  #     that script is part of the corresponding source. The shipped hash is
  #     the php_8_3.wasm line of SHA256SUMS, not a second digest in SOURCE.
  #     That hash differs from the pin or equals it, and SOURCE says which.
  #     The wasm in this fake release is not the product file (it is not in
  #     the tree). Its SHA256SUMS line is enough to run the same check a
  #     bundle directory must pass. A flipped sentence is the failing control.
  #     A sums line whose hash is the pin passes only a SOURCE that says equals.
  srcf="$T/release/SOURCE"
  check "SOURCE names spikes/b2-wordpress/prepare.sh" "$(grep -F 'spikes/b2-wordpress/prepare.sh' "$srcf" >/dev/null && echo yes || echo no)" yes
  check "SOURCE names the memory-import transform" "$(grep -F 'memory-import transform' "$srcf" >/dev/null && echo yes || echo no)" yes
  check "SOURCE names the loader patch" "$(grep -F 'loader patch' "$srcf" >/dev/null && echo yes || echo no)" yes
  check "SOURCE names prepare.sh as part of the corresponding source" "$(grep -F 'That script is part of the corresponding source.' "$srcf" >/dev/null && echo yes || echo no)" yes
  check "SOURCE says prepare.sh is GPL in this repository at the release tag" "$(grep -F 'spikes/b2-wordpress/prepare.sh (GPL) in this repository at the release tag.' "$srcf" >/dev/null && echo yes || echo no)" yes
  check "SOURCE points at SHA256SUMS for the shipped php_8_3.wasm" "$(grep -F 'The sha256 of the shipped php_8_3.wasm is the line in this release'"'"'s SHA256SUMS whose file name ends in php_8_3.wasm.' "$srcf" >/dev/null && echo yes || echo no)" yes
  printf 'not-the-pinned-playground-binary\n' > "$T/release/notpin-php_8_3.wasm"
  pyrel=$(python3 -I - "$srcf" "$T/release/notpin-php_8_3.wasm" "$T/release/SHA256SUMS" "$SHIPPED_WASM_SHA256" "$SHIPPED_JS_SHA256" <<'PY'
import hashlib, re, sys
source = open(sys.argv[1], encoding='utf-8').read()
wasm = open(sys.argv[2], 'rb').read()
sums_path, pin, loader_pin = sys.argv[3], sys.argv[4], sys.argv[5]
shipped = hashlib.sha256(wasm).hexdigest()
# The line build-bundle.sh writes (shasum -a 256): digest, two spaces, name.
open(sums_path, 'w', encoding='utf-8').write('%s  notpin-php_8_3.wasm\n' % shipped)
got_hash = None
for line in open(sums_path, encoding='utf-8'):
    parts = line.split()
    if len(parts) == 2 and parts[1].endswith('php_8_3.wasm'):
        if got_hash is not None:
            print('two wasm lines'); sys.exit(2)
        got_hash = parts[0]
if got_hash is None:
    print('no wasm line'); sys.exit(2)
relation = 'equals' if got_hash == pin else 'differs'
differs_s = 'That sha256 differs from the pinned Playground wasm sha256 above.'
equals_s = 'That sha256 equals the pinned Playground wasm sha256 above.'
def says(text):
    d = differs_s in text
    e = equals_s in text
    if d and not e:
        return 'differs'
    if e and not d:
        return 'equals'
    return 'neither'
def matches(text, rel):
    return 'yes' if says(text) == rel else 'no'
print('relation %s' % relation)
print('says %s' % says(source))
print('shipped-in-source %s' % ('yes' if got_hash in source else 'no'))
print('match %s' % matches(source, relation))
found = set(re.findall(r'[0-9a-f]{64}', source))
other = sorted(found - {pin, loader_pin})
print('other-sha %d' % len(other))
if differs_s in source and equals_s not in source:
    flipped = source.replace(differs_s, equals_s)
elif equals_s in source and differs_s not in source:
    flipped = source.replace(equals_s, differs_s)
else:
    flipped = source
print('flip-match %s' % matches(flipped, relation))
# The pin itself, as the wasm line of a sums file: SOURCE must say equals.
print('equal-match %s' % matches(equals_s + '\n', 'equals'))
print('equal-mismatch %s' % matches(differs_s + '\n', 'equals'))
PY
)
  echo "$pyrel"
  check "the fixture wasm hash in SHA256SUMS differs from the pin" "$(echo "$pyrel" | awk '/^relation /{print $2}')" differs
  check "SOURCE says which, and it matches that SHA256SUMS hash" "$(echo "$pyrel" | awk '/^match /{print $2}')" yes
  check "SOURCE does not hard-code the shipped wasm sha256" "$(echo "$pyrel" | awk '/^shipped-in-source /{print $2}')" no
  check "SOURCE has no sha256 other than the two upstream pins" "$(echo "$pyrel" | awk '/^other-sha /{print $2}')" 0
  check "a flipped sentence does not match the same SHA256SUMS" "$(echo "$pyrel" | awk '/^flip-match /{print $2}')" no
  check "a hash equal to the pin matches a SOURCE that says equals" "$(echo "$pyrel" | awk '/^equal-match /{print $2}')" yes
  check "a hash equal to the pin does not match a SOURCE that says differs" "$(echo "$pyrel" | awk '/^equal-mismatch /{print $2}')" no
fi
if [ -f "$T/release/NOTICE" ]; then
  check "release NOTICE has the PHP acknowledgment" "$(grep -c 'This product includes PHP software, freely available from' "$T/release/NOTICE")" 1
  check "release NOTICE has the Zend acknowledgment" "$(grep -c 'This product includes the Zend Engine, freely available at' "$T/release/NOTICE")" 1
fi

# 6. Control: the approach-A prefix, the same files, no clash with unprefixed.
mkdir -p "$T/release-a"
echo dummy > "$T/release-a/a.index-a-lean.js"
if [ -x "$pack" ]; then
  bash "$pack" "$T/release-a" "a." >/dev/null
  check "prefixed asset list contains a.NOTICE" "$([ -f "$T/release-a/a.NOTICE" ] && echo yes || echo no)" yes
  check "prefixed asset list contains a.SOURCE" "$([ -f "$T/release-a/a.SOURCE" ] && echo yes || echo no)" yes
  check "prefixed asset list contains a.LICENSES.tar.gz" "$([ -f "$T/release-a/a.LICENSES.tar.gz" ] && echo yes || echo no)" yes
  check "the prefix does not also write unprefixed NOTICE" "$([ -f "$T/release-a/NOTICE" ] && echo yes || echo no)" no
fi

# 7. The lean engine (variant s1-lean, #582). Product bundles (b-dosql and
#    approach-A) keep the npm Playground notices: build-bundle.sh passes no
#    engine, and a prefixed lean release is refused. The lean prerelease
#    (pagefeather-engine-lean.wasm, unprefixed) passes engine lean. Its SOURCE
#    names the build inputs. The differs/equals sentence is checked against
#    SHA256SUMS of that asset, and the shipped digest is not written into SOURCE.
#    A release dir with no such wasm is the refusal; the fixture wasm is the
#    passing control.
check "build-bundle.sh packages the notices of the engine it built: Playground with no engine argument, lean-bundle otherwise (#771)" "$(grep -F -c 'package-notices.sh" "$OUT/release" "$prefix" ${notice_arg:+"$notice_arg"}' "$bb")" 1
if [ -x "$pack" ]; then
  mkdir -p "$T/lean-missing"
  bash "$pack" "$T/lean-missing" "a." lean >/dev/null 2>&1
  check "a prefixed lean release is refused" "$?" 2
  bash "$pack" "$T/lean-missing" "" bogon >/dev/null 2>&1
  check "an unknown engine is refused" "$?" 2
  rm -rf "$T/lean-missing"
  mkdir -p "$T/lean-missing"
  bash "$pack" "$T/lean-missing" "" lean >/dev/null 2>&1
  check "lean packaging with no pagefeather-engine-lean.wasm is refused" "$?" 1
  mkdir -p "$T/lean"
  printf 'lean-engine-fixture\n' > "$T/lean/pagefeather-engine-lean.wasm"
  printf 'lean-engine-loader\n' > "$T/lean/pagefeather-engine-lean.js"
  lean_out=$(bash "$pack" "$T/lean" "" lean 2>&1); lean_rc=$?
  check "package-notices.sh lean exits 0 when the wasm is present" "$lean_rc" 0
  [ "$lean_rc" = 0 ] || echo "$lean_out"
  for f in NOTICE SOURCE LICENSES.tar.gz pagefeather-engine-lean.wasm; do
    check "lean release contains $f" "$([ -f "$T/lean/$f" ] && echo yes || echo no)" yes
  done
  if [ -f "$T/lean/SOURCE" ]; then
    lsrc="$T/lean/SOURCE"
    check "lean SOURCE names engine/ at the release tag" "$(grep -F 'engine/ at this release'"'"'s tag' "$lsrc" >/dev/null && echo yes || echo no)" yes
    check "lean SOURCE names engine/build.sh" "$(grep -F 'engine/build.sh' "$lsrc" >/dev/null && echo yes || echo no)" yes
    check "lean SOURCE names the build workflow" "$(grep -F '.github/workflows/pagefeather-engine.yml' "$lsrc" >/dev/null && echo yes || echo no)" yes
    check "lean SOURCE names variant s1-lean" "$(grep -F 'variant s1-lean' "$lsrc" >/dev/null && echo yes || echo no)" yes
    check "lean SOURCE names engine/licenses.tsv" "$(grep -F 'engine/licenses.tsv' "$lsrc" >/dev/null && echo yes || echo no)" yes
    check "lean SOURCE names the Playground commit" "$(grep -F "$UPSTREAM_COMMIT" "$lsrc" >/dev/null && echo yes || echo no)" yes
    check "lean SOURCE names the php-src commit" "$(grep -F "$PHP_REF_COMMIT" "$lsrc" >/dev/null && echo yes || echo no)" yes
    check "lean SOURCE names Emscripten" "$(grep -F "$EMSDK_VERSION" "$lsrc" >/dev/null && echo yes || echo no)" yes
    check "lean SOURCE names the pinned Playground wasm sha256" "$(grep -F "$SHIPPED_WASM_SHA256" "$lsrc" >/dev/null && echo yes || echo no)" yes
    check "lean SOURCE names the shipped asset pagefeather-engine-lean.wasm" "$(grep -F 'pagefeather-engine-lean.wasm' "$lsrc" >/dev/null && echo yes || echo no)" yes
    check "lean SOURCE does not use the playground prepare.sh production sentence" "$(grep -F 'The shipped php_8_3.wasm and php_8_3.js are produced from that pinned binary' "$lsrc" >/dev/null && echo yes || echo no)" no
    pylean=$(python3 -I - "$lsrc" "$T/lean/pagefeather-engine-lean.wasm" "$T/lean/SHA256SUMS" "$SHIPPED_WASM_SHA256" "$SHIPPED_JS_SHA256" <<'PY'
import hashlib, re, sys
source = open(sys.argv[1], encoding='utf-8').read()
wasm = open(sys.argv[2], 'rb').read()
sums_path, pin, loader_pin = sys.argv[3], sys.argv[4], sys.argv[5]
shipped = hashlib.sha256(wasm).hexdigest()
name = 'pagefeather-engine-lean.wasm'
open(sums_path, 'w', encoding='utf-8').write('%s  %s\n' % (shipped, name))
got_hash = None
for line in open(sums_path, encoding='utf-8'):
    parts = line.split()
    if len(parts) == 2 and parts[1] == name:
        if got_hash is not None:
            print('two wasm lines'); sys.exit(2)
        got_hash = parts[0]
if got_hash is None:
    print('no wasm line'); sys.exit(2)
relation = 'equals' if got_hash == pin else 'differs'
pointer = "The sha256 of the shipped pagefeather-engine-lean.wasm is the line in this release's SHA256SUMS whose file name is pagefeather-engine-lean.wasm."
differs_s = 'That sha256 differs from the pinned Playground wasm sha256 above.'
equals_s = 'That sha256 equals the pinned Playground wasm sha256 above.'
def says(text):
    d = differs_s in text
    e = equals_s in text
    if d and not e:
        return 'differs'
    if e and not d:
        return 'equals'
    return 'neither'
def matches(text, rel):
    return 'yes' if pointer in text and says(text) == rel else 'no'
print('relation %s' % relation)
print('says %s' % says(source))
print('pointer %s' % ('yes' if pointer in source else 'no'))
print('shipped-in-source %s' % ('yes' if got_hash in source else 'no'))
print('match %s' % matches(source, relation))
found = set(re.findall(r'[0-9a-f]{64}', source))
other = sorted(found - {pin, loader_pin})
print('other-sha %d' % len(other))
if differs_s in source and equals_s not in source:
    flipped = source.replace(differs_s, equals_s)
elif equals_s in source and differs_s not in source:
    flipped = source.replace(equals_s, differs_s)
else:
    flipped = source
print('flip-match %s' % matches(flipped, relation))
print('equal-match %s' % ('yes' if says(equals_s + '\n') == 'equals' else 'no'))
print('equal-mismatch %s' % ('yes' if says(differs_s + '\n') == 'equals' else 'no'))
PY
)
    echo "$pylean"
    check "the fixture lean wasm hash in SHA256SUMS differs from the pin" "$(echo "$pylean" | awk '/^relation /{print $2}')" differs
    check "lean SOURCE points at SHA256SUMS for pagefeather-engine-lean.wasm" "$(echo "$pylean" | awk '/^pointer /{print $2}')" yes
    check "lean SOURCE says which, and it matches that SHA256SUMS hash" "$(echo "$pylean" | awk '/^match /{print $2}')" yes
    check "lean SOURCE does not hard-code the shipped wasm sha256" "$(echo "$pylean" | awk '/^shipped-in-source /{print $2}')" no
    check "lean SOURCE has no sha256 other than the two upstream pins" "$(echo "$pylean" | awk '/^other-sha /{print $2}')" 0
    check "a flipped lean sentence does not match the same SHA256SUMS" "$(echo "$pylean" | awk '/^flip-match /{print $2}')" no
    check "a hash equal to the pin matches a SOURCE that says equals" "$(echo "$pylean" | awk '/^equal-match /{print $2}')" yes
    check "a hash equal to the pin does not match a SOURCE that says differs" "$(echo "$pylean" | awk '/^equal-mismatch /{print $2}')" no
  fi
  if [ -f "$T/lean/NOTICE" ]; then
    check "lean NOTICE has the PHP acknowledgment" "$(grep -c 'This product includes PHP software, freely available from' "$T/lean/NOTICE")" 1
    check "lean NOTICE has the Zend acknowledgment" "$(grep -c 'This product includes the Zend Engine, freely available at' "$T/lean/NOTICE")" 1
    check "lean NOTICE names variant s1-lean" "$(grep -F 'variant s1-lean' "$T/lean/NOTICE" >/dev/null && echo yes || echo no)" yes
    check "lean NOTICE names the build workflow" "$(grep -F '.github/workflows/pagefeather-engine.yml' "$T/lean/NOTICE" >/dev/null && echo yes || echo no)" yes
    check "lean NOTICE names engine/ at the release tag" "$(grep -F 'engine/ at this release'"'"'s tag' "$T/lean/NOTICE" >/dev/null && echo yes || echo no)" yes
  fi
  if [ -f "$T/release/SOURCE" ]; then
    check "playground SOURCE does not name the lean asset" "$(grep -F 'pagefeather-engine-lean.wasm' "$T/release/SOURCE" >/dev/null && echo yes || echo no)" no
  fi
fi

echo "$fails failing case(s)"
[ "$fails" = 0 ]
