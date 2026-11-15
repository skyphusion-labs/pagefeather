#!/usr/bin/env python3
# GD without AVIF (#582 S2, the lead's ruling of 2026-11-14), edits to upstream's
# packages/php-wasm/compile/libgd/Dockerfile. Upstream's prebuilt libgd.a was compiled with
# -DENABLE_AVIF=ON, so gd_avif.c.o needs libavif even when PHP is configured without --with-avif
# (run 43647365311: "undefined symbol: avifDecoderCreate"). build.sh rebuilds libgd with these edits.
# Each edit must match EXACTLY ONCE.
#   python3 -I engine/patches/libgd-noavif.py <libgd/Dockerfile>
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()
edits = [
    ('AVIF off in cmake', '        -DENABLE_AVIF=ON \\\n', '        -DENABLE_AVIF=OFF \\\n'),
    ('no libavif in gdlib.pc Requires', 'Requires.private: libpng libjpeg libwebp libavif zlib\n', 'Requires.private: libpng libjpeg libwebp zlib\n'),
    ('no libavif in gdlib.pc Libs', 'Libs: -L${libdir} -lgd -lpng16 -lz -ljpeg -lwebp -lsharpyuv -lavif\n', 'Libs: -L${libdir} -lgd -lpng16 -lz -ljpeg -lwebp -lsharpyuv\n'),
    # cmake has ENABLE_FREETYPE=OFF. The hand-written gdlib-config must say so (#590).
    # PHP 8.3 does not read this line (it links gdFontCacheShutdown; lean.py undefines
    # HAVE_GD_FREETYPE). The line still has to match the library that was built.
    ('no AVIF or FREETYPE in gdlib-config --features', '  --features) echo "PNG JPEG WEBP AVIF GIF XBM WBMP FREETYPE" ;;\n', '  --features) echo "PNG JPEG WEBP GIF XBM WBMP" ;;\n'),
    ('no libavif in gdlib-config --libs', '  --libs) echo "-L/root/lib/lib -lgd -lpng16 -lz -ljpeg -lwebp -lsharpyuv -lavif" ;;\n', '  --libs) echo "-L/root/lib/lib -lgd -lpng16 -lz -ljpeg -lwebp -lsharpyuv" ;;\n'),
]
for name, old, new in edits:
    n = s.count(old)
    if n != 1:
        sys.exit('libgd-noavif.py: edit "%s" matched %d times, not once' % (name, n))
    s = s.replace(old, new)
    print('libgd-noavif.py: ' + name)
open(p, 'w', encoding='utf-8').write(s)
