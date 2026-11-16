#!/usr/bin/env bash
# #771: engine.sh resolves the PHP engine the same way for every caller. Offline: engine.sh is copied beside a test
# engine.lock that pins two small fake files, which a local stub server serves (it counts requests and can serve
# wrong bytes). The real engine.lock is only checked for form (no network).
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/engine-resolve-test.XXXXXX")
trap 'kill "$SRV" 2>/dev/null; rm -rf "$T"' EXIT
mkdir -p "$T/eng" "$T/srv" "$T/cache"
cp "$HERE/engine.sh" "$T/eng/engine.sh"
printf 'fake wasm bytes\n' > "$T/srv/pagefeather-engine-lean.wasm"; printf 'fake loader\n' > "$T/srv/pagefeather-engine-lean.js"
sha() { { sha256sum "$1" 2>/dev/null || shasum -a 256 "$1"; } | cut -d' ' -f1; }
W=$(sha "$T/srv/pagefeather-engine-lean.wasm"); J=$(sha "$T/srv/pagefeather-engine-lean.js")
cat > "$T/eng/engine.lock" <<LOCK
PHP_ENGINE_DEFAULT=lean
LEAN_TAG=engine-test
LEAN_BASE_URL=http://127.0.0.1:9/never-used
LEAN_WASM_ASSET=pagefeather-engine-lean.wasm
LEAN_JS_ASSET=pagefeather-engine-lean.js
LEAN_WASM_SHA256=$W
LEAN_JS_SHA256=$J
LOCK
# The stub: serves $T/srv, counts GETs in $T/hits, and serves wrong bytes while $T/corrupt exists.
cat > "$T/srv.py" <<'PY'
import http.server, os, sys
root, hits = sys.argv[1], sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        open(hits, "a").write(self.path + "\n")
        p = os.path.join(root, os.path.basename(self.path))
        if not os.path.isfile(p):
            self.send_response(404); self.end_headers(); return
        b = b"tampered" if os.path.exists(os.path.join(os.path.dirname(hits), "corrupt")) else open(p, "rb").read()
        self.send_response(200); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(os.path.join(os.path.dirname(hits), "port"), "w").write(str(s.server_address[1]))
s.serve_forever()
PY
python3 -I "$T/srv.py" "$T/srv" "$T/hits" & SRV=$!; disown "$SRV" 2>/dev/null
for _ in $(seq 50); do [ -s "$T/port" ] && break; sleep 0.1; done
URL="http://127.0.0.1:$(cat "$T/port")"
: > "$T/hits"
run() { # run <env...>: prints "rc|resolved|js|wasm|line" after engine_resolve in a clean shell
  env -i PATH="$PATH" HOME="$T" PF_ENGINE_CACHE="$T/cache" PF_ENGINE_BASE_URL="$URL" "$@" bash -c ". '$T/eng/engine.sh'; engine_resolve 2>'$T/err'; rc=\$?; echo \"\$rc|\${PHP_ENGINE_RESOLVED:-}|\${PF_ENGINE_JS:-}|\${PF_ENGINE_WASM:-}|\$(engine_recycle_mib)\""
}
echo "1. the default is lean, fetched by hash"
IFS='|' read -r rc res js wasm mib < <(run)
ok "unset: rc 0, lean" "$([ "$rc" = 0 ] && [ "$res" = lean ] && echo 1 || echo 0)"
ok "  fetched by their published names, cached under the loader's names" "$(grep -qx '/pagefeather-engine-lean.wasm' "$T/hits" && grep -qx '/pagefeather-engine-lean.js' "$T/hits" && [ "$(basename "$wasm")" = php_8_3.wasm ] && [ "$(basename "$js")" = php_8_3.js ] && echo 1 || echo 0)"
ok "  the two files are the pinned ones" "$([ -n "$js" ] && [ "$(sha "$wasm")" = "$W" ] && [ "$(sha "$js")" = "$J" ] && echo 1 || echo 0)"
ok "  fetched once each (2 requests)" "$([ "$(wc -l < "$T/hits" | tr -d ' ')" = 2 ] && echo 1 || echo 0)"
ok "  its recycle line is 140" "$([ "$mib" = 140 ] && echo 1 || echo 0)"
IFS='|' read -r rc res _ _ _ < <(run PHP_ENGINE=lean)
ok "PHP_ENGINE=lean: the same, from the cache (no new request)" "$([ "$rc" = 0 ] && [ "$res" = lean ] && [ "$(wc -l < "$T/hits" | tr -d ' ')" = 2 ] && echo 1 || echo 0)"
echo "2. a file that is not the pin is never used"
printf 'bitrot' > "$wasm"
IFS='|' read -r rc res _ wasm2 _ < <(run)
ok "a cached file that changed is fetched again and is the pin" "$([ "$rc" = 0 ] && [ "$(sha "$wasm2")" = "$W" ] && [ "$(wc -l < "$T/hits" | tr -d ' ')" = 3 ] && echo 1 || echo 0)"
rm -f "$wasm2"; touch "$T/corrupt"
IFS='|' read -r rc res _ _ _ < <(run)
ok "served bytes that are not the pin: refused (rc 2), named, nothing left in the cache" "$([ "$rc" = 2 ] && grep -q 'not the pin' "$T/err" && [ ! -e "$wasm2" ] && ! ls "$T"/cache/*/*.part >/dev/null 2>&1 && echo 1 || echo 0)"
rm -f "$T/corrupt"
echo "3. the other choices"
IFS='|' read -r rc res js wasm mib < <(run PHP_ENGINE=npm)
ok "PHP_ENGINE=npm: rc 0, npm, no engine files, line 100" "$([ "$rc" = 0 ] && [ "$res" = npm ] && [ -z "$js$wasm" ] && [ "$mib" = 100 ] && echo 1 || echo 0)"
IFS='|' read -r rc res _ _ _ < <(run PHP_ENGINE=npm PF_ENGINE_JS=/dev/null PF_ENGINE_WASM=/dev/null)
printf 'another build\n' > "$T/other.wasm"; printf 'another loader\n' > "$T/other.js"
IFS='|' read -r rc2 res2 js2 _ mib2 < <(run PF_ENGINE_JS="$T/other.js" PF_ENGINE_WASM="$T/other.wasm")
ok "explicit files (another build): custom, used as given, line 140" "$([ "$rc2" = 0 ] && [ "$res2" = custom ] && [ "$js2" = "$T/other.js" ] && [ "$mib2" = 140 ] && echo 1 || echo 0)"
IFS='|' read -r rc3 res3 js3 _ _ < <(run PF_ENGINE_JS="$T/srv/pagefeather-engine-lean.js" PF_ENGINE_WASM="$T/srv/pagefeather-engine-lean.wasm")
ok "explicit files that ARE the pinned pair: lean (a deploy script resolved and exported them)" "$([ "$rc3" = 0 ] && [ "$res3" = lean ] && [ "$js3" = "$T/srv/pagefeather-engine-lean.js" ] && echo 1 || echo 0)"
IFS='|' read -r rc _ _ _ _ < <(run PF_ENGINE_JS="$T/srv/pagefeather-engine-lean.js")
ok "one explicit file only: refused (rc 2)" "$([ "$rc" = 2 ] && grep -q 'set both or neither' "$T/err" && echo 1 || echo 0)"
IFS='|' read -r rc _ _ _ _ < <(run PHP_ENGINE=npm PF_ENGINE_JS="$T/srv/pagefeather-engine-lean.js" PF_ENGINE_WASM="$T/srv/pagefeather-engine-lean.wasm")
ok "npm and explicit files together: refused" "$([ "$rc" = 2 ] && grep -q 'choose one' "$T/err" && echo 1 || echo 0)"
IFS='|' read -r rc _ _ _ _ < <(run PHP_ENGINE=fast)
ok "PHP_ENGINE=fast: refused, named" "$([ "$rc" = 2 ] && grep -q 'PHP_ENGINE must be lean or npm' "$T/err" && echo 1 || echo 0)"
echo "4. the real engine.lock"
(
  # shellcheck disable=SC1091
  . "$HERE/engine.lock"
  [ "$PHP_ENGINE_DEFAULT" = lean ] && [[ "$LEAN_WASM_SHA256" =~ ^[0-9a-f]{64}$ ]] && [[ "$LEAN_JS_SHA256" =~ ^[0-9a-f]{64}$ ]] && [[ "$LEAN_BASE_URL" == https://* ]] && [[ "$LEAN_BASE_URL" == *"$LEAN_TAG" ]] && [[ "$LEAN_WASM_ASSET$LEAN_JS_ASSET$LEAN_TAG" != *[Pp][Hh][Pp]* ]]
); ok "it pins lean by two sha256 values, at an https URL named by its tag, and no published name says PHP" "$([ $? = 0 ] && echo 1 || echo 0)"
echo "$fails failing case(s)"
exit $((fails > 0))
