#!/usr/bin/env python3
"""A stand-in for the account (the API, R2's S3 API and the sites), for
snapshot-test.sh (issue #35, slice 3).

  fake-account.py <port-file> <state.json>

It reads <state.json> on every request, so a test changes the state between
calls. The state: {"sites": {"<name>": {"dispatcher": {"etag", "modified_on"} | null,
"script": {"etag", "modified_on"} | null, "entry": "<value>" | null,
"bucket": [[key, etag, size], ...] | null, "title": "..."}},
"ns_list_shape": "top" | "nested" | "bare", "ns_list_status": 200,
"s3_status": 200}. A null part is absent (404).
Paths: /workers/scripts (list), /workers/scripts/<name>,
/workers/dispatch/namespaces/wp-wfp/scripts (list) and /<name>,
/storage/kv/namespaces/kv1/values/<host>, /r2/buckets/<b>, /s3/<b>?list-type=2,
/site/<dispatcher>/ (the page).
"""
import http.server, json, sys, urllib.parse

port_file, state_file = sys.argv[1], sys.argv[2]


def st():
    return json.load(open(state_file))


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json"):
        b = body if isinstance(body, bytes) else (json.dumps(body) if not isinstance(body, str) else body).encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        s = st()
        sites = s["sites"]
        u = urllib.parse.urlsplit(self.path)
        p = u.path
        if p == "/workers/subdomain":
            return self.send(200, {"success": True, "result": {"subdomain": "sub"}})
        if p == "/workers/scripts":
            return self.send(200, {"success": True, "result": [{"id": "wp-" + n, **v["dispatcher"]} for n, v in sites.items() if v.get("dispatcher")]})
        if p.startswith("/workers/scripts/"):
            n = p.rsplit("/", 1)[1][3:]
            return self.send(200 if sites.get(n, {}).get("dispatcher") else 404, {"success": True})
        if p == "/workers/dispatch/namespaces/wp-wfp/scripts":
            if s.get("ns_list_status", 200) != 200:
                return self.send(s["ns_list_status"], {"success": False})
            shape = s.get("ns_list_shape", "top")
            items = []
            for n, v in sites.items():
                if v.get("script"):
                    sc = v["script"]
                    items.append({"script": {"id": "site-" + n, **sc}} if shape == "nested" else {"id": "site-" + n} if shape == "bare" else {"id": "site-" + n, **sc})
            return self.send(200, {"success": True, "result": items})
        if p.startswith("/workers/dispatch/namespaces/wp-wfp/scripts/"):
            n = p.rsplit("/", 1)[1][5:]
            if sites.get(n, {}).get("script"):
                return self.send(200, {"success": True, "result": {"script": {"id": "site-" + n}}})
            return self.send(404, {"success": False})
        if p.startswith("/storage/kv/namespaces/kv1/values/"):
            n = p.rsplit("/", 1)[1].split(".", 1)[0][3:]
            e = sites.get(n, {}).get("entry")
            return self.send(200, e, "text/plain") if e is not None else self.send(404, {"success": False})
        if p.startswith("/vectorize/v2/indexes/"):
            n = p.rsplit("/", 1)[1][7:-7]
            return self.send(200 if sites.get(n, {}).get("search") else 404, {"success": True})
        if p.startswith("/r2/buckets/"):
            n = p.rsplit("/", 1)[1][7:-6]
            return self.send(200 if sites.get(n, {}).get("bucket") is not None else 404, {"success": True})
        if p.startswith("/s3/"):
            if not self.headers.get("authorization", "").startswith("AWS4-HMAC-SHA256"):
                return self.send(403, "<Error/>", "application/xml")
            if s.get("s3_status", 200) != 200:
                return self.send(s["s3_status"], "<Error/>", "application/xml")
            n = p.split("/")[2][7:-6]
            objs = sites.get(n, {}).get("bucket") or []
            x = "".join("<Contents><Key>%s</Key><ETag>%s</ETag><Size>%s</Size></Contents>" % tuple(o) for o in objs)
            return self.send(200, '<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">%s</ListBucketResult>' % x, "application/xml")
        if p.startswith("/site/"):
            n = p.split("/")[2][3:]
            site = sites.get(n, {})
            t = site.get("title")
            if not t:
                return self.send(404, "no")
            return self.send(site.get("page_status", 200), "<html><title>%s</title></html>" % t, "text/html")
        return self.send(404, {"success": False})


    # Any write is logged (site-cmd-test.sh: a refused command must send none) and refused.
    def write(self):
        with open(state_file + ".writes", "a") as f:
            f.write("%s %s\n" % (self.command, self.path))
        self.send(405, {"success": False})

    do_PUT = do_POST = do_DELETE = do_PATCH = write


s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
open(port_file, "w").write(str(s.server_port))
s.serve_forever()
