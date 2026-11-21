#!/bin/bash
# #1262: an opt-in custom domain for a deploy.sh site. deploy/lib/custom-domain.sh against a stub Cloudflare API (no
# network), and the render. Exits 0 only when every check holds.
#   deploy/tests/custom-domain-test.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/custom-domain-test.XXXXXX"); PID=""
trap '[ -z "$PID" ] || kill "$PID" 2>/dev/null; rm -rf "${T:?}"' EXIT
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails + 1)); fi; }
# The stub: GET /zones answers $T/zones (a JSON body); GET /accounts/x/workers/domains?service=... answers $T/domains;
# DELETE /accounts/x/workers/domains/<id> answers the code in $T/delcode (default 200) and removes it from $T/domains.
cat > "$T/stub.py" <<'PY'
import http.server, json, os, sys
root = sys.argv[2]
def rd(n, d=""):
    p = os.path.join(root, n)
    return open(p).read() if os.path.exists(p) else d
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body):
        b = body.encode(); self.send_response(code); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        open(os.path.join(root, "log"), "a").write("GET %s\n" % self.path)
        if self.path.startswith("/zones"): return self.send(int(rd("zonescode", "200")), rd("zones", '{"success":true,"result":[]}'))
        if self.path.startswith("/dns-query"):
            t = self.path.split("type=")[-1]
            return self.send(200, rd("dns-" + t, '{"Status":0}'))
        if "/workers/domains" in self.path: return self.send(200, rd("domains", '{"success":true,"result":[]}'))
        self.send(404, "{}")
    def do_DELETE(self):
        open(os.path.join(root, "log"), "a").write("DELETE %s\n" % self.path)
        code = int(rd("delcode", "200")); did = self.path.rsplit("/", 1)[-1]
        if code == 200 and not os.path.exists(os.path.join(root, "sticky")):
            d = json.loads(rd("domains", '{"success":true,"result":[]}')); d["result"] = [x for x in d["result"] if x.get("id") != did]
            open(os.path.join(root, "domains"), "w").write(json.dumps(d))
        self.send(code, '{"success":%s}' % ("true" if code == 200 else "false"))
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
open(sys.argv[1], "w").write(str(srv.server_address[1])); srv.serve_forever()
PY
mkdir -p "$T/api"; python3 -I "$T/stub.py" "$T/port" "$T/api" & PID=$!
for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
BASE="http://127.0.0.1:$(cat "$T/port")"
ZONES='{"success":true,"result":[{"name":"example.com"},{"name":"pagefeather.dev"},{"name":"sub.example.com"}]}'
printf '%s' "$ZONES" > "$T/api/zones"
prep() { # prep <env assignments...>: runs custom_domain_prepare; prints SITE_ORIGIN after it; rc kept
  env -i PATH="$PATH" CLOUDFLARE_API_TOKEN=tok ACCOUNT_ID=acct NAME=t1 CF_API_BASE="$BASE" CF_DOH_BASE="$BASE/dns-query" "$@" bash -c '. "'"$ROOT"'/deploy/lib/custom-domain.sh"; custom_domain_prepare; rc=$?; echo "ORIGIN=${SITE_ORIGIN:-}"; exit $rc' > "$T/out" 2> "$T/err"
}
prep; rc=$?
ok "off: CUSTOM_DOMAIN unset passes and derives nothing (rc $rc)" "$([ $rc = 0 ] && grep -qx 'ORIGIN=' "$T/out" && ! grep -q GET "$T/api/log" 2>/dev/null && echo 1 || echo 0)"
prep CUSTOM_DOMAIN=gate-test.pagefeather.dev; rc=$?
ok "on: a host in a zone passes, SITE_ORIGIN becomes https://<host> (rc $rc)" "$([ $rc = 0 ] && grep -qx 'ORIGIN=https://gate-test.pagefeather.dev' "$T/out" && grep -q 'zone pagefeather.dev' "$T/out" && echo 1 || echo 0)"
prep CUSTOM_DOMAIN=a.sub.example.com; rc=$?
ok "the longest matching zone is named (sub.example.com, not example.com)" "$([ $rc = 0 ] && grep -q 'zone sub.example.com' "$T/out" && echo 1 || echo 0)"
prep CUSTOM_DOMAIN=shop.nowhere.test; rc=$?
ok "a host in no zone on the account is refused (rc $rc)" "$([ $rc = 2 ] && grep -q 'in no active zone' "$T/err" && echo 1 || echo 0)"
prep CUSTOM_DOMAIN=notexample.com; rc=$?
ok "a suffix that is not a label boundary does not match (notexample.com is not in example.com)" "$([ $rc = 2 ] && echo 1 || echo 0)"
prep CUSTOM_DOMAIN=cf759x.skyphusion.workers.dev; rc=$?
ok "a workers.dev host is refused before any read (rc $rc)" "$([ $rc = 2 ] && grep -q 'workers.dev hostname' "$T/err" && echo 1 || echo 0)"
for bad in Shop.Example.com 'example.com/x' localhost 'a..b.com' '-a.example.com' 'https://a.example.com'; do
  prep CUSTOM_DOMAIN="$bad"; rc=$?
  ok "a bad hostname is refused: '$bad' (rc $rc)" "$([ $rc = 2 ] && grep -q 'lower-case hostname' "$T/err" && echo 1 || echo 0)"
done
prep CUSTOM_DOMAIN=gate-test.pagefeather.dev SITE_ORIGIN=https://other.example.com; rc=$?
ok "an explicit SITE_ORIGIN that disagrees is refused (rc $rc)" "$([ $rc = 2 ] && grep -q 'disagree' "$T/err" && echo 1 || echo 0)"
prep CUSTOM_DOMAIN=gate-test.pagefeather.dev SITE_ORIGIN=https://gate-test.pagefeather.dev; rc=$?
ok "an explicit SITE_ORIGIN that agrees passes (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"
printf '{"success":false,"errors":[{"code":9109}]}' > "$T/api/zones"
prep CUSTOM_DOMAIN=gate-test.pagefeather.dev; rc=$?
ok "a failed zone read is a refusal, never a pass (rc $rc)" "$([ $rc = 2 ] && grep -q 'could not be read' "$T/err" && echo 1 || echo 0)"
printf '%s' "$ZONES" > "$T/api/zones"
# Never take over a hostname in use (the lead): another Worker's custom domain, or a DNS record.
printf '{"success":true,"result":[{"id":"o1","hostname":"gate-test.pagefeather.dev","service":"someone-else"}]}' > "$T/api/domains"
prep CUSTOM_DOMAIN=gate-test.pagefeather.dev; rc=$?
ok "a hostname that is another Worker's custom domain is refused (rc $rc)" "$([ $rc = 2 ] && grep -q 'custom domain of Worker someone-else' "$T/err" && echo 1 || echo 0)"
printf '{"success":true,"result":[{"id":"o1","hostname":"gate-test.pagefeather.dev","service":"t1"}]}' > "$T/api/domains"
printf '{"Status":0,"Answer":[{"type":1,"data":"104.21.0.1"}]}' > "$T/api/dns-A"; rm -f "$T/api/log"
prep CUSTOM_DOMAIN=gate-test.pagefeather.dev; rc=$?
ok "this site's own custom domain (a redeploy) passes, and its DNS is not held against it (rc $rc)" "$([ $rc = 0 ] && ! grep -q dns-query "$T/api/log" && echo 1 || echo 0)"
printf '{"success":true,"result":[]}' > "$T/api/domains"
prep CUSTOM_DOMAIN=gate-test.pagefeather.dev; rc=$?
ok "a hostname that already resolves (an A record) is refused (rc $rc)" "$([ $rc = 2 ] && grep -q 'already has DNS records (A 104.21.0.1' "$T/err" && echo 1 || echo 0)"
rm -f "$T/api/dns-A"; printf '{"Status":0,"Answer":[{"type":5,"data":"other.example.net."}]}' > "$T/api/dns-CNAME"
prep CUSTOM_DOMAIN=gate-test.pagefeather.dev; rc=$?
ok "a hostname with a CNAME is refused (rc $rc)" "$([ $rc = 2 ] && grep -q 'CNAME other.example.net' "$T/err" && echo 1 || echo 0)"
rm -f "$T/api/dns-CNAME"; printf '{"Status":2}' > "$T/api/dns-AAAA"
prep CUSTOM_DOMAIN=gate-test.pagefeather.dev; rc=$?
ok "a failed DNS lookup (SERVFAIL) is a refusal, never a pass (rc $rc)" "$([ $rc = 2 ] && grep -q 'DNS lookup' "$T/err" && echo 1 || echo 0)"
rm -f "$T/api/dns-AAAA"; printf '{"Status":3}' > "$T/api/dns-A"
prep CUSTOM_DOMAIN=gate-test.pagefeather.dev; rc=$?
ok "NXDOMAIN (no record at all) passes (rc $rc)" "$([ $rc = 0 ] && echo 1 || echo 0)"
rm -f "$T/api/dns-A"
# The token never reaches argv: custom-domain.sh sends it through curl -K (a config on a file descriptor).
ok "the token is passed with curl -K, never on the command line" "$(grep -c 'curl ' "$ROOT/deploy/lib/custom-domain.sh" | xargs -I{} sh -c '[ {} -ge 1 ]' && ! grep -nE 'curl [^|]*-H "Authorization' "$ROOT/deploy/lib/custom-domain.sh" && echo 1 || echo 0)"
# The render: the route only with CUSTOM_DOMAIN.
render() { (cd "$ROOT/spikes/b2-wordpress" && env -i PATH="$PATH" NAME=t1 VARIANT=b-dosql LOCATION=enam SITE_ORIGIN=https://t1.example.workers.dev APP="$ROOT/spikes/b2-wordpress" COMPAT=2026-01-01 BUCKET=b AI=0 MEDIA=0 "$@" bash -c '. "'"$ROOT"'/deploy/render-conf.sh" 2>/dev/null; render_conf' 2>/dev/null); }
off=$(render | grep -c '^routes = '); on=$(render CUSTOM_DOMAIN=gate-test.pagefeather.dev | grep -x 'routes = \[{ pattern = "gate-test.pagefeather.dev", custom_domain = true }\]' | wc -l | tr -d ' ')
ok "render: no route without CUSTOM_DOMAIN ($off), the custom_domain route with it ($on)" "$([ "$off" = 0 ] && [ "$on" = 1 ] && echo 1 || echo 0)"
# The detach (destroy.sh): one domain on the service is deleted and read back as gone.
detach() { env -i PATH="$PATH" CLOUDFLARE_API_TOKEN=tok ACCOUNT_ID=acct CF_API="$BASE" bash -c '. "'"$ROOT"'/deploy/lib/custom-domain.sh"; custom_domain_detach t1' > "$T/out" 2> "$T/err"; }
rm -f "$T/api/log" "$T/api/delcode" "$T/api/sticky"
printf '{"success":true,"result":[{"id":"d1","hostname":"gate-test.pagefeather.dev","service":"t1"},{"id":"d9","hostname":"x.example.com","service":"other"}]}' > "$T/api/domains"
detach; rc=$?
ok "detach: the site's domain is deleted (only its own), and read back as gone (rc $rc)" "$([ $rc = 0 ] && grep -q 'DELETE /accounts/acct/workers/domains/d1' "$T/api/log" && ! grep -q 'domains/d9' "$T/api/log" && grep -q 'read back, no custom domain' "$T/out" && echo 1 || echo 0)"
printf '{"success":true,"result":[]}' > "$T/api/domains"; rm -f "$T/api/log"; detach; rc=$?
ok "detach: a site with no custom domain deletes nothing (rc $rc)" "$([ $rc = 0 ] && ! grep -q DELETE "$T/api/log" && echo 1 || echo 0)"
printf '{"success":true,"result":[{"id":"d1","hostname":"gate-test.pagefeather.dev","service":"t1"}]}' > "$T/api/domains"; echo 500 > "$T/api/delcode"; detach; rc=$?
ok "detach: a failed delete stops the teardown (rc $rc)" "$([ $rc = 1 ] && grep -q 'could not be deleted' "$T/err" && echo 1 || echo 0)"
rm -f "$T/api/delcode"; : > "$T/api/sticky"; detach; rc=$?
ok "detach: a domain still there after a 200 delete stops the teardown (rc $rc)" "$([ $rc = 1 ] && grep -q 'remain after the delete' "$T/err" && echo 1 || echo 0)"
rm -f "$T/api/sticky"
# Wiring: deploy.sh calls the check before any step; destroy.sh detaches before the Worker delete.
d1=$(grep -n 'custom_domain_prepare || exit 2' "$ROOT/deploy/deploy.sh" | cut -d: -f1); d2=$(grep -n '^# 1b. Data plane' "$ROOT/deploy/deploy.sh" | cut -d: -f1)
ok "deploy.sh: custom_domain_prepare runs before the data plane (lines $d1 and $d2)" "$([ -n "$d1" ] && [ -n "$d2" ] && [ "$d1" -lt "$d2" ] && echo 1 || echo 0)"
x1=$(grep -n 'custom_domain_detach "$NAME" || exit 1' "$ROOT/deploy/destroy.sh" | cut -d: -f1); x2=$(grep -n '^delete_worker wr_delete' "$ROOT/deploy/destroy.sh" | cut -d: -f1)
ok "destroy.sh: custom_domain_detach runs before the Worker delete (lines $x1 and $x2)" "$([ -n "$x1" ] && [ -n "$x2" ] && [ "$x1" -lt "$x2" ] && echo 1 || echo 0)"
ok "CUSTOM_DOMAIN is a recorded input (#1108)" "$(grep -q '^RECORDED_INPUTS=".* CUSTOM_DOMAIN' "$ROOT/deploy/lib/recorded-inputs.sh" && echo 1 || echo 0)"
[ "$fails" = 0 ] && echo "custom-domain: all checks pass" || { echo "custom-domain: $fails FAILED"; exit 1; }
