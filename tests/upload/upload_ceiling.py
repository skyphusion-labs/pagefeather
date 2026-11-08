#!/usr/bin/env python3
"""Media-upload memory-ceiling check for b-dosql (issue #189).

Uploads one small image through the real admin path
(POST /wp-admin/async-upload.php, action=upload-attachment) and reports whether
the attachment is stored. The image bytes are tiny, so this measures the memory
cost of the REQUEST, not of image processing.

Why this exists. On b-dosql the PHP runtime lives in one Durable Object with a
128 MiB isolate cap. A WooCommerce-warmed isolate sits at about x-wasm-mib 99,
leaving about 29 MiB. The attachment insert (wp_insert_post plus the serialized
_wp_attachment_metadata) needs more headroom than that, so on a Woo-warmed site
the upload returns {"success":false,"data":{"message":"Could not insert
attachment into the database."}} with no isolate reset. The same upload on a
b-dosql site with WooCommerce NOT active (about mib 58) stores the attachment.
So the blocker is the WooCommerce per-request working set, not the image. This
is the same 128-vs-256 wall that sends checkout to a Container (index.js, the
WooCheckout class). See docs/results.md and issue #189.

Usage:
  BASE=https://<site>.workers.dev ADMIN_PASSWORD=<pw> python3 tests/upload/upload_ceiling.py
  (ADMIN_PASSWORD may instead be a file path via ADMIN_PASSWORD_FILE.)

Exit codes:
  0  the attachment was stored (upload works on this deploy)
  2  the upload was blocked at the write-memory ceiling (measured, expected on a
     WooCommerce-warmed b-dosql isolate until the write path gets a Container)
  1  harness error (could not log in, no nonce, upload endpoint unreachable)
"""
import base64
import os
import re
import sys
import time
import uuid
import http.cookiejar
import urllib.error
import urllib.parse
import urllib.request

# A 64x64 PNG, embedded so the test needs no image library or fixture file.
PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAABAAQMAAACQp+OdAAAAIGNIUk0AAHomAACAhAAA+gAAAIDo"
    "AAB1MAAA6mAAADqYAAAXcJy6UTwAAAADUExURQAAgErCvvoAAAAHdElNRQfqCwgLExZQAZCYAAAA"
    "JXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTExLTA4VDExOjE5OjIyKzAwOjAwF0PCjgAAACV0RVh0ZGF0"
    "ZTptb2RpZnkAMjAyNi0xMS0wOFQxMToxOToyMiswMDowMGYeejIAAAAodEVYdGRhdGU6dGltZXN0"
    "YW1wADIwMjYtMTEtMDhUMTE6MTk6MjIrMDA6MDAxC1vtAAAAD0lEQVQoz2NgGAWjgHwAAAJAAAGM"
    "xat3AAAAAElFTkSuQmCC"
)
UA = "upload-ceiling-check/1.0"


def main():
    base = os.environ.get("BASE", "").rstrip("/")
    pw = os.environ.get("ADMIN_PASSWORD", "")
    pw_file = os.environ.get("ADMIN_PASSWORD_FILE", "")
    if pw_file and not pw:
        pw = open(pw_file).read().strip()
    user = os.environ.get("ADMIN_USER", "admin")
    if not base or not pw:
        sys.stderr.write("set BASE and ADMIN_PASSWORD (or ADMIN_PASSWORD_FILE)\n")
        return 1

    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    op.addheaders = [("User-Agent", UA)]

    def get(path, headers=None):
        req = urllib.request.Request(base + path)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            r = op.open(req, timeout=90)
            return r.status, r.read().decode("utf-8", "replace"), dict(r.headers)
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace"), dict(e.headers)

    def post_form(path, data):
        body = urllib.parse.urlencode(data).encode()
        req = urllib.request.Request(base + path, data=body)
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        req.add_header("User-Agent", UA)
        r = op.open(req, timeout=90)
        return r.status, r.read().decode("utf-8", "replace")

    # 1. log in as admin
    get("/wp-login.php")
    post_form("/wp-login.php", {
        "log": user, "pwd": pw, "wp-submit": "Log In",
        "redirect_to": base + "/wp-admin/", "testcookie": "1"})
    if not any("wordpress_logged_in" in c.name for c in cj):
        sys.stderr.write("login failed (no auth cookie)\n")
        return 1

    # 2. read the media-form upload nonce
    st, page, _ = get("/wp-admin/media-new.php")
    m = (re.search(r'"_wpnonce":"([a-f0-9]+)"', page)
         or re.search(r'name="_wpnonce"\s+value="([a-f0-9]+)"', page))
    if not m:
        sys.stderr.write("no upload nonce on media-new.php (http %s)\n" % st)
        return 1
    nonce = m.group(1)

    # 3. upload, retrying past the 503 overload gate to land in a free PHP-lock window
    img = base64.b64decode(PNG_B64)
    boundary = "----b" + uuid.uuid4().hex
    nl = "\r\n"

    def upload():
        body = b""
        for k, v in (("action", "upload-attachment"), ("_wpnonce", nonce)):
            body += ("--%s%sContent-Disposition: form-data; name=\"%s\"%s%s%s%s"
                     % (boundary, nl, k, nl, nl, v, nl)).encode()
        body += ("--%s%sContent-Disposition: form-data; name=\"async-upload\"; "
                 "filename=\"ceiling.png\"%sContent-Type: image/png%s%s"
                 % (boundary, nl, nl, nl, nl)).encode()
        body += img + ("%s--%s--%s" % (nl, boundary, nl)).encode()
        req = urllib.request.Request(base + "/wp-admin/async-upload.php", data=body)
        req.add_header("Content-Type", "multipart/form-data; boundary=" + boundary)
        req.add_header("User-Agent", UA)
        try:
            r = op.open(req, timeout=120)
            return r.status, r.read().decode("utf-8", "replace"), dict(r.headers)
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace"), dict(e.headers)

    attempts = 0
    while True:
        attempts += 1
        status, body, hdrs = upload()
        if status != 503 or attempts >= 30:
            break
        time.sleep(1.5)

    mib = hdrs.get("x-wasm-mib")
    oom = "exceeded its memory" in body
    stored = '"success":true' in body

    print("upload: http %s x-wasm-mib=%s attempts=%d" % (status, mib, attempts))
    if stored:
        print("RESULT: stored (upload works on this deploy)")
        return 0
    if oom:
        print("RESULT: OOM (isolate exceeded its memory limit during the upload)")
        return 2
    if "Could not insert attachment" in body:
        print("RESULT: blocked at the write-memory ceiling "
              "(attachment insert failed, no isolate reset)")
        return 2
    print("RESULT: upload did not store; body: %s" % body[:200].replace(chr(10), " "))
    return 2


if __name__ == "__main__":
    sys.exit(main())
