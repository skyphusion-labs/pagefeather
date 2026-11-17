#!/bin/bash
# #598: the prepare.sh wasm transform (memory section -> env.memory import, OPcache SAPI list) is idempotent.
#   tests/prepare-idempotent-test.sh   (in spikes/b2-wordpress, after npm ci)
# 1. prepare.sh twice gives the same vendor/ bytes.
# 2. An already-transformed wasm, fed back in (PF_ENGINE_WASM), passes through byte-identical.
# 3. The red: a wasm with NO memory section that does not import env.memory as the transform makes it is refused.
# Leaves vendor/ prepared from the default sources.
set -u
# #771: the plain runs use the npm engine (offline; the default, lean, is fetched: tests/engine-resolve-test.sh).
cd "$(dirname "$0")/.." || exit 1
T=$(mktemp -d "${TMPDIR:-/tmp}/prepare-idem.XXXXXX"); trap 'rm -rf "$T"' EXIT
sum() { shasum -a 256 vendor/php_8_3.wasm vendor/php_8_3.js | awk '{print $1}' | tr '\n' ' '; }
fail() { echo "prepare-idempotent: FAIL: $*"; PHP_ENGINE=npm ./prepare.sh > /dev/null 2>&1; exit 1; }
PHP_ENGINE=npm ./prepare.sh > "$T/1.log" 2>&1 || fail "prepare.sh failed: $(tail -3 "$T/1.log")"
a=$(sum)
PHP_ENGINE=npm ./prepare.sh > /dev/null 2>&1 || fail "second prepare.sh failed"
[ "$(sum)" = "$a" ] || fail "a second run changed vendor/"
cp vendor/php_8_3.wasm "$T/done.wasm"
PF_ENGINE_JS=node_modules/@php-wasm/web-8-3/jspi/php_8_3.js PF_ENGINE_WASM="$T/done.wasm" ./prepare.sh > "$T/2.log" 2>&1 || fail "an already-transformed wasm was refused: $(tail -3 "$T/2.log")"
grep -q 'kept (already transformed)' "$T/2.log" || fail "the transformed wasm was not recognised as such"
[ "$(sum)" = "$a" ] || fail "an already-transformed wasm did not pass through byte-identical"
# the red: strip the memory section from the raw module, so it neither defines nor imports a memory
python3 -I - node_modules/@php-wasm/web-8-3/jspi/8_3_36/php_8_3.wasm "$T/nomem.wasm" <<'PY'
import sys
b = open(sys.argv[1], 'rb').read()
def leb(i):
    r = s = 0
    while True:
        x = b[i]; i += 1; r |= (x & 0x7f) << s; s += 7
        if x < 0x80: return r, i
out = bytearray(b[:8]); i = 8
while i < len(b):
    st = i; sid = b[i]; size, j = leb(i + 1); i = j + size
    if sid != 5: out += b[st:i]
open(sys.argv[2], 'wb').write(out)
PY
if PF_ENGINE_JS=node_modules/@php-wasm/web-8-3/jspi/php_8_3.js PF_ENGINE_WASM="$T/nomem.wasm" ./prepare.sh > "$T/3.log" 2>&1; then fail "a wasm with no memory and no env.memory import was accepted"; fi
grep -q 'does not import env.memory' "$T/3.log" || fail "the refusal named another reason: $(tail -3 "$T/3.log")"
PHP_ENGINE=npm ./prepare.sh > /dev/null 2>&1 || fail "the final prepare.sh failed"
[ "$(sum)" = "$a" ] || fail "vendor/ was not restored"
echo "prepare-idempotent: ok: twice identical, a transformed wasm passes through untouched, a memoryless one is refused"
