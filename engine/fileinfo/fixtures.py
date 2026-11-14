#!/usr/bin/env python3
# The fixture corpus of the fileinfo tests (#582 S2b). Every file is made here from code: no binary
# fixture lives in the repo. Each is the smallest real instance of its format that libmagic names.
#   fixtures.py <out-dir>     writes the files and manifest.json
# manifest.json: [{"file", "ext", "class", "why"}]. Classes:
#   accepted   an upload WordPress accepts: the trimmed database must sniff it as the full one does
#   disguise   a dangerous type renamed to an accepted extension: it must sniff as what it is
#   known-diff a harmless type WordPress does not accept, renamed to an accepted application/ extension:
#              the trimmed database cannot name it (the documented limit, #582); the test pins that
#   refused    an extension WordPress does not accept: refused by name, as on any host
import io, json, os, struct, sys, zipfile, zlib

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
man = []
def put(name, data, cls, why):
    open(os.path.join(out, name), 'wb').write(data)
    man.append({'file': name, 'ext': name.rsplit('.', 1)[1], 'class': cls, 'why': why})

def png():
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\x00\xff\x00\x00')) + chunk(b'IEND', b'')
def gif(): return b'GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;'
def jpg(): return bytes.fromhex('ffd8ffe000104a46494600010100000100010000ffdb004300' + '01' * 64 + 'ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffda0008010100003f00d2cf20ffd9')
def bmp():
    px = b'\x00\x00\xff\x00'
    return b'BM' + struct.pack('<IHHI', 14 + 40 + len(px), 0, 0, 54) + struct.pack('<IiiHHIIiiII', 40, 1, 1, 1, 24, 0, len(px), 2835, 2835, 0, 0) + px
def tiff(): return b'II*\x00\x08\x00\x00\x00\x01\x00\x00\x01\x03\x00\x01\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00'
def riff(kind, body): return b'RIFF' + struct.pack('<I', 4 + len(body)) + kind + body
def ftyp(brand, compat): return struct.pack('>I', 8 + 8 + 4 * len(compat)) + b'ftyp' + brand + b'\x00\x00\x00\x00' + b''.join(compat) + struct.pack('>I', 8) + b'mdat'
def ebml(doctype):
    dt = doctype.encode()
    body = b'\x42\x86\x81\x01' + b'\x42\xf7\x81\x01' + b'\x42\xf2\x81\x04' + b'\x42\xf3\x81\x08' + b'\x42\x82' + bytes([0x80 | len(dt)]) + dt + b'\x42\x87\x81\x04' + b'\x42\x85\x81\x02'
    return b'\x1a\x45\xdf\xa3' + bytes([0x80 | len(body)]) + body + b'\x18\x53\x80\x67\x01\x00\x00\x00\x00\x00\x00\x00'
def ogg(head):
    seg = head
    hdr = b'OggS\x00\x02' + b'\x00' * 8 + struct.pack('<I', 1) + struct.pack('<I', 0) + b'\x00\x00\x00\x00' + bytes([1, len(seg)])
    return hdr + seg
ASF = bytes.fromhex('3026b2758e66cf11a6d900aa0062ce6c')
def asf(): return ASF + struct.pack('<Q', 30) + struct.pack('<I', 0) + b'\x01\x02'
def zipped(entries, stored_first=None):
    b = io.BytesIO()
    with zipfile.ZipFile(b, 'w') as z:
        if stored_first:
            z.writestr(zipfile.ZipInfo(stored_first[0], date_time=(2026, 1, 1, 0, 0, 0)), stored_first[1], compress_type=zipfile.ZIP_STORED)
        for n, d in entries:
            z.writestr(zipfile.ZipInfo(n, date_time=(2026, 1, 1, 0, 0, 0)), d, compress_type=zipfile.ZIP_DEFLATED)
    return b.getvalue()
CT = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/%s" ContentType="%s"/></Types>'
def ooxml(main, ctype): return zipped([('[Content_Types].xml', CT % (main, ctype)), ('_rels/.rels', '<Relationships/>'), (main, '<x/>')])
def odf(mime): return zipped([('META-INF/manifest.xml', '<manifest/>'), ('content.xml', '<x/>')], stored_first=('mimetype', mime))
def cdf(clsid_hex):
    # A minimal OLE2 compound file: one directory sector with the root entry, whose CLSID names the type.
    sec = 512
    hdr = bytearray(sec)
    hdr[0:8] = bytes.fromhex('d0cf11e0a1b11ae1'); hdr[24:26] = struct.pack('<H', 0x3e); hdr[26:28] = struct.pack('<H', 3)
    hdr[28:30] = struct.pack('<H', 0xfffe); hdr[30:32] = struct.pack('<H', 9); hdr[32:34] = struct.pack('<H', 6)
    hdr[44:48] = struct.pack('<I', 1)          # number of SAT sectors
    hdr[48:52] = struct.pack('<I', 1)          # first directory sector
    hdr[56:60] = struct.pack('<I', 4096)       # mini stream cutoff
    hdr[60:64] = struct.pack('<i', -2); hdr[64:68] = struct.pack('<I', 0)  # no SSAT
    hdr[68:72] = struct.pack('<i', -2); hdr[72:76] = struct.pack('<I', 0)  # no extra MSAT
    msat = [0] + [0xffffffff] * 108
    hdr[76:76 + 436] = struct.pack('<109I', *msat)
    sat = struct.pack('<I', 0xfffffffd) + struct.pack('<I', 0xfffffffe) + struct.pack('<I', 0xffffffff) * 126
    d = bytearray(128); name = 'Root Entry'.encode('utf-16-le') + b'\x00\x00'
    d[0:len(name)] = name; d[64:66] = struct.pack('<H', len(name)); d[66] = 5; d[67] = 1
    d[68:80] = struct.pack('<iii', -1, -1, -1); d[80:96] = bytes.fromhex(clsid_hex)
    d[116:120] = struct.pack('<i', -2); d[120:124] = struct.pack('<I', 0)
    empty = bytearray(128); empty[68:80] = struct.pack('<iii', -1, -1, -1)
    dirsec = bytes(d) + bytes(empty) * 3
    return bytes(hdr) + sat + dirsec
def clsid(guid):  # "00020906-0000-0000-C000-000000000046" to the on-disk (mixed endian) bytes
    a, b, c, d, e = guid.split('-')
    return (struct.pack('<IHH', int(a, 16), int(b, 16), int(c, 16)) + bytes.fromhex(d + e)).hex()
def sfnt(tag): return tag + struct.pack('>HHHH', 0, 0, 0, 0)
def woff(sig, flavor): return sig + flavor + struct.pack('>IHHIHHIIIII', 44, 0, 0, 12, 1, 0, 0, 0, 0, 0, 0)
PE = b'MZ' + b'\x90\x00' * 29 + struct.pack('<I', 64) + b'PE\x00\x00' + struct.pack('<HHIIIHH', 0x14c, 0, 0, 0, 0, 0xe0, 0x102) + b'\x0b\x01' + b'\x00' * 222
ELF = b'\x7fELF\x02\x01\x01\x00' + b'\x00' * 8 + struct.pack('<HHIQQQIHHHHHH', 2, 62, 1, 0x400000, 64, 0, 0, 64, 56, 0, 64, 0, 0)
MACHO = struct.pack('<IiiIIII', 0xfeedfacf, 0x01000007, 3, 2, 0, 0, 0) + b'\x00' * 4
JCLASS = b'\xca\xfe\xba\xbe\x00\x00\x00\x34' + b'\x00' * 16

# accepted: one per WordPress extension group (the first extension of the group), plus the fonts
A = 'accepted'
put('a.jpg', jpg(), A, 'image/jpeg'); put('a.gif', gif(), A, 'image/gif'); put('a.png', png(), A, 'image/png')
put('a.bmp', bmp(), A, 'image/bmp'); put('a.tiff', tiff(), A, 'image/tiff'); put('a.webp', riff(b'WEBP', b'VP8L\x05\x00\x00\x00\x2f\x00\x00\x00\x00\x00'), A, 'image/webp')
put('a.avif', ftyp(b'avif', [b'avif', b'mif1']), A, 'image/avif'); put('a.ico', b'\x00\x00\x01\x00\x01\x00\x01\x01\x00\x00\x01\x00\x20\x00\x30\x00\x00\x00\x16\x00\x00\x00' + b'\x00' * 48, A, 'image/x-icon')
put('a.heic', ftyp(b'heic', [b'mif1', b'heic']), A, 'image/heic'); put('a.heif', ftyp(b'mif1', [b'mif1']), A, 'image/heif')
put('a.heics', ftyp(b'hevc', [b'msf1', b'hevc']), A, 'image/heic-sequence'); put('a.heifs', ftyp(b'msf1', [b'msf1']), A, 'image/heif-sequence')
put('a.asf', asf(), A, 'video/x-ms-asf'); put('a.wmv', asf(), A, 'video/x-ms-wmv'); put('a.wmx', b'<ASX version="3.0"><Entry/></ASX>\n', A, 'video/x-ms-wmx'); put('a.wm', asf(), A, 'video/x-ms-wm')
put('a.avi', riff(b'AVI ', b'LIST\x04\x00\x00\x00hdrl'), A, 'video/avi'); put('a.divx', riff(b'AVI ', b'LIST\x04\x00\x00\x00hdrl'), A, 'video/divx')
put('a.flv', b'FLV\x01\x05\x00\x00\x00\x09\x00\x00\x00\x00', A, 'video/x-flv'); put('a.mov', ftyp(b'qt  ', [b'qt  ']), A, 'video/quicktime')
put('a.mpeg', b'\x00\x00\x01\xba\x44\x00\x04\x00\x04\x01\x01\x89\xc3\xf8', A, 'video/mpeg'); put('a.mp4', ftyp(b'isom', [b'isom', b'mp41']), A, 'video/mp4')
put('a.ogv', ogg(b'\x80theora\x03\x02\x01' + b'\x00' * 30), A, 'video/ogg'); put('a.webm', ebml('webm'), A, 'video/webm'); put('a.mkv', ebml('matroska'), A, 'video/x-matroska')
put('a.3gp', ftyp(b'3gp4', [b'3gp4']), A, 'video/3gpp'); put('a.3g2', ftyp(b'3g2a', [b'3g2a']), A, 'video/3gpp2')
put('a.txt', b'Plain text, one line.\n', A, 'text/plain'); put('a.csv', b'a,b,c\n1,2,3\n4,5,6\n', A, 'text/csv'); put('a.tsv', b'a\tb\tc\n1\t2\t3\n', A, 'text/tab-separated-values')
put('a.ics', b'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\nEND:VCALENDAR\r\n', A, 'text/calendar'); put('a.rtx', b'<richtext>text</richtext>\n', A, 'text/richtext')
put('a.css', b'body { color: #333; }\n', A, 'text/css'); put('a.vtt', b'WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n', A, 'text/vtt')
put('a.dfxp', b'<?xml version="1.0" encoding="utf-8"?>\n<tt xmlns="http://www.w3.org/ns/ttml"><body/></tt>\n', A, 'application/ttaf+xml')
put('a.mp3', b'ID3\x03\x00\x00\x00\x00\x00\x00' + b'\xff\xfb\x90\x64' + b'\x00' * 413, A, 'audio/mpeg'); put('a.m4a', ftyp(b'M4A ', [b'M4A ', b'mp42']), A, 'audio/mpeg (m4a)')
put('a.aac', b'\xff\xf1\x50\x80\x02\x1f\xfc' + b'\x00' * 9, A, 'audio/aac'); put('a.ra', b'.ra\xfd\x00\x04' + b'\x00' * 20, A, 'audio/x-realaudio')
put('a.wav', riff(b'WAVE', b'fmt \x10\x00\x00\x00\x01\x00\x01\x00\x44\xac\x00\x00\x88\x58\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00'), A, 'audio/wav')
put('a.ogg', ogg(b'\x01vorbis\x00\x00\x00\x00\x01\x44\xac\x00\x00' + b'\x00' * 15), A, 'audio/ogg'); put('a.flac', b'fLaC\x80\x00\x00\x22' + b'\x00' * 34, A, 'audio/flac')
put('a.mid', b'MThd\x00\x00\x00\x06\x00\x00\x00\x01\x00\x60MTrk\x00\x00\x00\x04\x00\xff\x2f\x00', A, 'audio/midi'); put('a.wma', asf(), A, 'audio/x-ms-wma')
put('a.wax', b'<ASX version="3.0"><Entry/></ASX>\n', A, 'audio/x-ms-wax'); put('a.mka', ebml('matroska'), A, 'audio/x-matroska')
put('a.rtf', b'{\\rtf1\\ansi Hello}\n', A, 'application/rtf'); put('a.js', b'function f() { return 1; }\n', A, 'application/javascript')
put('a.pdf', b'%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', A, 'application/pdf'); put('a.class', JCLASS, A, 'application/java')
tb = io.BytesIO()
import tarfile
with tarfile.open(fileobj=tb, mode='w', format=tarfile.USTAR_FORMAT) as t:
    ti = tarfile.TarInfo('a.txt'); ti.size = 2; ti.mtime = 1767225600; t.addfile(ti, io.BytesIO(b'a\n'))
put('a.tar', tb.getvalue(), A, 'application/x-tar'); put('a.zip', zipped([('a.txt', 'a')]), A, 'application/zip')
put('a.gz', b'\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\x03' + zlib.compress(b'a')[2:-4] + struct.pack('<II', zlib.crc32(b'a'), 1), A, 'application/x-gzip')
put('a.rar', b'Rar!\x1a\x07\x00\xcf\x90\x73\x00\x00\x0d\x00\x00\x00\x00\x00\x00\x00', A, 'application/rar'); put('a.7z', b"7z\xbc\xaf\x27\x1c\x00\x04" + b'\x00' * 24, A, 'application/x-7z-compressed')
put('a.psd', b'8BPS\x00\x01' + b'\x00' * 6 + b'\x00\x03\x00\x00\x00\x01\x00\x00\x00\x01\x00\x08\x00\x03', A, 'application/octet-stream (psd)')
put('a.xcf', b'gimp xcf v011\x00' + b'\x00' * 16, A, 'application/octet-stream (xcf)')
put('a.doc', cdf(clsid('00020906-0000-0000-C000-000000000046')), A, 'application/msword')
put('a.ppt', cdf(clsid('64818D10-4F9B-11CF-86EA-00AA00B929E8')), A, 'application/vnd.ms-powerpoint')
put('a.xls', cdf(clsid('00020820-0000-0000-C000-000000000046')), A, 'application/vnd.ms-excel')
put('a.wri', b'\x31\xbe\x00\x00\x00\xab' + b'\x00' * 122, A, 'application/vnd.ms-write')
put('a.mdb', b'\x00\x01\x00\x00Standard Jet DB\x00' + b'\x00' * 108, A, 'application/vnd.ms-access')
put('a.mpp', cdf(clsid('74B78F3A-C8C8-11D1-BE11-00C04FB6FAF1')), A, 'application/vnd.ms-project')
for ext, main, ct in [('docx', 'word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'),
                      ('xlsx', 'xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'),
                      ('pptx', 'ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml')]:
    put('a.' + ext, ooxml(main, ct), A, 'OOXML ' + ext)
put('a.onetoc', bytes.fromhex('e4525c7b8cd8a74daeb15378d02996d3') + b'\x00' * 48, A, 'application/onenote')
put('a.xps', zipped([('FixedDocumentSequence.fdseq', '<x/>'), ('[Content_Types].xml', '<Types/>')]), A, 'application/vnd.ms-xpsdocument')
for ext, mime in [('odt', 'application/vnd.oasis.opendocument.text'), ('odp', 'application/vnd.oasis.opendocument.presentation'), ('ods', 'application/vnd.oasis.opendocument.spreadsheet'),
                  ('odg', 'application/vnd.oasis.opendocument.graphics'), ('odc', 'application/vnd.oasis.opendocument.chart'), ('odb', 'application/vnd.oasis.opendocument.database'), ('odf', 'application/vnd.oasis.opendocument.formula')]:
    put('a.' + ext, odf(mime), A, mime)
put('a.wpd', b'\xffWPC\x10\x00\x00\x00\x01\x0a\x02\x01\x00\x00\x00\x00', A, 'application/wordperfect')
for ext in ('key', 'numbers', 'pages'):
    put('a.' + ext, zipped([('Index/Document.iwa', 'x'), ('Metadata/Properties.plist', '<plist/>')]), A, 'Apple iWork ' + ext)
put('a.ttf', sfnt(b'\x00\x01\x00\x00'), A, 'font ttf'); put('a.otf', sfnt(b'OTTO'), A, 'font otf')
put('a.woff', woff(b'wOFF', b'\x00\x01\x00\x00'), A, 'font woff'); put('a.woff2', woff(b'wOF2', b'\x00\x01\x00\x00'), A, 'font woff2')

# disguise: dangerous types renamed to accepted extensions (images and non-images)
D = 'disguise'
SH = b'#!/bin/sh\necho hello\n'; PHP = b'<?php echo "hello"; ?>\n'
HTML = b'<!DOCTYPE html>\n<html><head><title>x</title></head><body><script>alert(1)</script></body></html>\n'
SVG = b'<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n'
for kind, data in [('pe', PE), ('elf', ELF), ('macho', MACHO), ('sh', SH), ('php', PHP), ('html', HTML), ('svg', SVG), ('jclass', JCLASS)]:
    for ext in ('jpg', 'png', 'zip', 'pdf', 'docx', 'mp3', 'mp4', 'txt'):
        if kind == 'jclass' and ext == 'class':
            continue
        put('d-%s.%s' % (kind, ext), data, D, kind + ' as .' + ext)
put('d-swf.zip', b'FWS\x0a' + struct.pack('<I', 21) + b'\x78\x00\x05\x5f\x00\x00\x0f\xa0\x00\x00\x18\x01\x00', D, 'flash as .zip')

# known-diff: harmless types WordPress does not accept, renamed to an accepted application/ extension
K = 'known-diff'
put('k-sqlite.doc', b'SQLite format 3\x00' + b'\x10\x00\x01\x01\x00\x40\x20\x20' + b'\x00' * 76, K, 'a SQLite database as .doc')
put('k-ps.pdf', b'%!PS-Adobe-3.0\n%%EOF\n', K, 'PostScript as .pdf')

# refused: extensions WordPress does not accept at all (refused by name, before any sniff)
R = 'refused'
put('r.exe', PE, R, 'exe (get_allowed_mime_types removes it)'); put('r.php', PHP, R, 'php'); put('r.svg', SVG, R, 'svg')
put('r.swf', b'FWS\x0a' + struct.pack('<I', 21) + b'\x78\x00\x05\x5f\x00\x00\x0f\xa0\x00\x00\x18\x01\x00', R, 'swf (removed)')
put('r.sh', SH, R, 'sh'); put('r.sqlite', b'SQLite format 3\x00' + b'\x00' * 84, R, 'sqlite')

json.dump(man, open(os.path.join(out, 'manifest.json'), 'w'), indent=1)
print('fixtures.py: %d files (%s)' % (len(man), ', '.join('%s %d' % (c, sum(1 for m in man if m['class'] == c)) for c in ('accepted', 'disguise', 'known-diff', 'refused'))))
