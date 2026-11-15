#!/usr/bin/env python3
# The libgd recipe edit (#582, #590). A Dockerfile fragment with each upstream string
# the patch names, exactly once. After the patch, gdlib-config --features matches a
# libgd built with ENABLE_AVIF=OFF and ENABLE_FREETYPE=OFF: no AVIF, no FREETYPE.
#   python3 -I engine/patches/libgd-noavif-test.py
import subprocess
import sys
import tempfile
import os

here = os.path.dirname(os.path.abspath(__file__))
patch = os.path.join(here, 'libgd-noavif.py')
# Upstream packages/php-wasm/compile/libgd/Dockerfile at dcd8e50, the lines the patch edits.
src = (
    '        -DENABLE_AVIF=ON \\\n'
    'Requires.private: libpng libjpeg libwebp libavif zlib\n'
    'Libs: -L${libdir} -lgd -lpng16 -lz -ljpeg -lwebp -lsharpyuv -lavif\n'
    '  --features) echo "PNG JPEG WEBP AVIF GIF XBM WBMP FREETYPE" ;;\n'
    '  --libs) echo "-L/root/lib/lib -lgd -lpng16 -lz -ljpeg -lwebp -lsharpyuv -lavif" ;;\n'
)
fd, path = tempfile.mkstemp(suffix='.Dockerfile')
os.close(fd)
try:
    open(path, 'w', encoding='utf-8').write(src)
    r = subprocess.run([sys.executable, '-I', patch, path], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit('libgd-noavif.py failed:\n' + r.stdout + r.stderr)
    out = open(path, encoding='utf-8').read()
finally:
    os.remove(path)
line = [ln for ln in out.splitlines() if '--features)' in ln]
if len(line) != 1:
    sys.exit('expected one --features line, got %r' % line)
want = '  --features) echo "PNG JPEG WEBP GIF XBM WBMP" ;;'
if line[0] != want:
    sys.exit('features line is %r, not %r' % (line[0], want))
if 'FREETYPE' in line[0] or 'AVIF' in line[0]:
    sys.exit('features still advertise a format libgd was built without: ' + line[0])
if '-DENABLE_AVIF=ON' in out or '-lavif' in out:
    sys.exit('AVIF was not removed:\n' + out)
print('libgd-noavif-test: features are PNG JPEG WEBP GIF XBM WBMP')
