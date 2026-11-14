#!/usr/bin/env python3
# The lean static build (#582 S2): edits to upstream's packages/php-wasm/compile/php/Dockerfile at
# engine/UPSTREAM's commit. Each edit names why, and must match EXACTLY ONCE or the build stops, so an
# upstream change can never be silently skipped.
#   python3 -I engine/patches/lean.py <php/Dockerfile>
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()
edits = [
    # 1. No MAIN_MODULE. Upstream links a dylink main module only so side modules (intl.so) can load,
    #    and for that exports the whole libphp ABI (our 6,603 exports). Pagefeather loads no .so.
    ('no MAIN_MODULE', '\t-s MAIN_MODULE=2 \\\n', ''),
    # 2. The ABI export list (-Wl,--export=... for every libphp symbol) goes with it.
    ('no ABI export list', '\t-Wl,@/root/.wasm-exports \\\n', ''),
    # 3. Do not compute the libphp ABI at all (its llvm-nm step).
    ('skip the libphp ABI step', 'RUN set -eux; \\\n\tif [ "$WITH_JSPI" != "yes" ]; then \\\n\t\texit 0; \\\n\tfi; \\\n\t/root/emsdk/upstream/bin/llvm-nm',
     'RUN set -eux; \\\n\tif true; then \\\n\t\texit 0; \\\n\tfi; \\\n\t/root/emsdk/upstream/bin/llvm-nm'),
    # 4. No side-module ABI from the committed extensions (intl.so): its imports would become exports.
    ('no extension ABI', '\tfor path in "$EXTENSIONS_DIR_PATH"/*; do \\\n', '\tfor path in ; do \\\n'),
    # 5. The source that exports Zend symbols for side modules.
    ('no side-module export source', '\t\tZEND_SIDE_MODULE_EXPORT_SOURCE="/root/zend-side-module-exports.c"; \\\n', ''),
    # 6. dlopen for side modules (it needs MAIN_MODULE's dlopenInternal).
    ('no dynamic-linking library', '\t--js-library /root/phpwasm-emscripten-library-dynamic-linking.js \\\n', ''),
    # 7. calendar: nothing in WordPress, WooCommerce, our mu-plugins or the 18-plugin suite names it.
    ('no calendar', '\t--enable-calendar  \\\n', ''),
    # 8. The SQLite3 class: nothing of ours uses it. libsqlite3 stays for pdo_sqlite (b-dosql).
    ('no SQLite3 class', "echo -n ' --with-sqlite3 --enable-pdo --with-pdo-sqlite=/root/lib '", "echo -n ' --without-sqlite3 --enable-pdo --with-pdo-sqlite=/root/lib '"),
    # 9. GD without AVIF (the lead's ruling, 2026-11-14): no --with-avif, no libavif in the link.
    ('no AVIF flag', "\t\t\t\techo -n ' --with-avif ' >> /root/.php-configure-flags; \\\n", '\t\t\t\t: ; \\\n'),
    ('no libavif in the link', " /root/lib/lib/libsharpyuv.a /root/lib/lib/libavif.a ' >> /root/.emcc-php-wasm-sources; \\\n", " /root/lib/lib/libsharpyuv.a ' >> /root/.emcc-php-wasm-sources; \\\n"),
    # 10. Print every input the linker reads (the hygiene files are built from this list).
    # 10. Print every input the linker reads (the hygiene files are built from this list), and write
    #     the linker map: every data and BSS symbol with its address and size (the static memory, measured).
    ('trace the link inputs', '\t-s ERROR_ON_UNDEFINED_SYMBOLS=1 \\\n', '\t-s ERROR_ON_UNDEFINED_SYMBOLS=1 \\\n\t-Wl,--trace \\\n\t-Wl,-Map=/root/output/php.map \\\n'),
]
for name, old, new in edits:
    n = s.count(old)
    if n != 1:
        sys.exit('lean.py: edit "%s" matched %d times, not once' % (name, n))
    s = s.replace(old, new)
    print('lean.py: ' + name)
open(p, 'w', encoding='utf-8').write(s)
