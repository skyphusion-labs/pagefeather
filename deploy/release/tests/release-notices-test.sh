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
  check "SOURCE names the shipped wasm sha256" "$(grep -F "$SHIPPED_WASM_SHA256" "$T/release/SOURCE" >/dev/null && echo yes || echo no)" yes
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

echo "$fails failing case(s)"
[ "$fails" = 0 ]
