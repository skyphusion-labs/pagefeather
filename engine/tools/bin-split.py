"""#582 S4 M2a: check the body-tail layout of every OPcache file in an opcache.zip, and sum it.

Usage: python3 -I engine/tools/bin-split.py <opcache.zip> [--expect-eager]

The file cache header (zend_file_cache_metainfo, wasm32) is magic[8], system_id[32], then mem_size,
str_size and script_offset (4 bytes each), timestamp (8, at offset 56), checksum (4). The lazy-body
patch (engine/opcache/pf-lazy-bodies.patch) adds pf_body_offset, pf_body_size and (M2b) pf_bstr_size
(4 each), so the header is 80 bytes, against 72 without it, and the body-string section (pf_bstr_size
bytes) follows the string section. The header size is not assumed: it is the file length minus mem_size,
str_size and pf_bstr_size, so a file from the other build is told apart by its own bytes.

Gate (default): every .bin has an 80-byte header, pf_body_offset + pf_body_size == mem_size, and the body
starts after the script offset. Prints one JSON line of totals. --expect-eager inverts it: every .bin
must have the 72-byte header (the red control: the tool must refuse an eager zip as lazy).
"""
import json, struct, sys, zipfile

LAZY_HDR, EAGER_HDR = 80, 72

def main(path, expect_eager):
    z = zipfile.ZipFile(path)
    names = [n for n in z.namelist() if n.endswith(".bin")]
    if not names:
        sys.exit("bin-split: no .bin files in " + path)
    bad, tot = [], {"files": len(names), "memBytes": 0, "bodyBytes": 0, "withBody": 0, "hdr": {}}
    for n in names:
        b = z.read(n)
        if b[:8] != b"OPCACHE\0":
            bad.append((n, "magic")); continue
        mem, strs, soff = struct.unpack_from("<III", b, 40)
        bstr = struct.unpack_from("<I", b, 76)[0] if len(b) >= 80 else 0
        hdr = len(b) - mem - strs - bstr
        if hdr != LAZY_HDR:
            hdr, bstr = len(b) - mem - strs, 0  # an eager file: 72 bytes, no body-string section
        tot["hdr"][hdr] = tot["hdr"].get(hdr, 0) + 1
        if expect_eager:
            if hdr != EAGER_HDR:
                bad.append((n, "header %d, want %d" % (hdr, EAGER_HDR)))
            continue
        if hdr != LAZY_HDR:
            bad.append((n, "header %d, want %d" % (hdr, LAZY_HDR))); continue
        boff, bsize = struct.unpack_from("<II", b, 68)
        if boff + bsize != mem:
            bad.append((n, "body %d+%d != mem %d" % (boff, bsize, mem))); continue
        if bsize and boff <= soff:
            bad.append((n, "body offset %d not after script offset %d" % (boff, soff))); continue
        tot["memBytes"] += mem
        tot["bstrBytes"] = tot.get("bstrBytes", 0) + bstr
        tot["bodyBytes"] += bsize
        tot["withBody"] += 1 if bsize else 0
    tot["hdr"] = {str(k): v for k, v in sorted(tot["hdr"].items())}
    if not expect_eager:
        tot["bodyMiB"] = round(tot["bodyBytes"] / 2**20, 2)
        tot["memMiB"] = round(tot["memBytes"] / 2**20, 2)
        tot["bodyShare"] = round(tot["bodyBytes"] / tot["memBytes"], 3) if tot["memBytes"] else None
    print(json.dumps({"tool": "bin-split", "zip": path, "mode": "eager" if expect_eager else "lazy", "bad": len(bad), **tot}))
    for n, why in bad[:10]:
        print("  %s: %s" % (n, why))
    if bad:
        sys.exit(1)
    if not expect_eager and tot["bodyBytes"] == 0:
        sys.exit("bin-split: no body bytes at all (the split did not run)")

if __name__ == "__main__":
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    main(a[0], "--expect-eager" in a[1:])
