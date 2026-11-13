#!/bin/bash
# The recorded build inputs of a site (#379, lib.sh use_recorded_inputs and record_build_inputs,
# build_inputs.py), against a fake S3 bucket on localhost. The case that made it: on 2026-11-12 an
# update without the site's inputs shipped the live ggc.sh without its plugins and mu-plugins.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); chmod 700 "$T"
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: got '$2', want '$3'"; fails=$((fails + 1)); fi; }

# A fake S3: PUT stores, GET returns or 404. Path-style /<bucket>/<key>.
cat > "$T/s3.py" <<'PY'
import http.server, sys
store = {}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_PUT(self):
        n = int(self.headers.get("content-length") or 0); store[self.path] = self.rfile.read(n)
        self.send_response(200); self.end_headers()
    def do_GET(self):
        if self.path not in store:
            self.send_response(404); self.end_headers(); return
        b = store[self.path]; self.send_response(200); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(sys.argv[1], "w").write(str(s.server_port)); s.serve_forever()
PY
python3 -I "$T/s3.py" "$T/port" & SRV=$!
trap 'kill $SRV 2>/dev/null; wait $SRV 2>/dev/null; rm -rf "$T"' EXIT
for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
export WFP_S3_ENDPOINT="http://127.0.0.1:$(cat "$T/port")" WFP_S3_KEY_ID=test-key WFP_S3_SECRET=test-secret CLOUDFLARE_ACCOUNT_ID=test
ACCOUNT_ID=test
. "$HERE/../lib.sh"
B=wp-wfp-t-media

# The site's own content, as a store has it: a theme, two plugins (one the build keeps), mu-plugins.
SRC="$T/src/wp-content"
mkdir -p "$SRC/themes/tt5" "$SRC/plugins/shop" "$SRC/plugins/sqlite-database-integration" "$SRC/mu-plugins" "$SRC/plugins/extra"
echo theme > "$SRC/themes/tt5/style.css"; echo shop > "$SRC/plugins/shop/shop.php"; echo mu > "$SRC/mu-plugins/store-cart.php"; echo extra > "$SRC/plugins/extra/x.php"
# A stand-in APP with the real content-id.py and a built wp-content (the build copies the subset).
APP="$T/app"; mkdir -p "$APP/build/wordpress/wp-content"; cp "$HERE/../../../spikes/b2-wordpress/content-id.py" "$APP/"
cp -R "$SRC/themes" "$SRC/plugins" "$SRC/mu-plugins" "$APP/build/wordpress/wp-content/"
IN=(IMPORT_CONTENT="$SRC" IMPORT_THEMES=tt5 IMPORT_PLUGINS="shop sqlite-database-integration" IMPORT_MU_PLUGINS=store-cart.php WOO_ACTIVE=1)

# 1. No record yet.
python3 -I "$HERE/../build_inputs.py" get "$B" "$T/none.json"; check "no record: get exits 3" "$?" 3
run_update() { # run_update <env assignments...> : an update's scope, as update_one_inner declares it
  ( local_test() {
      local -x PLUGINS="${PLUGINS:-}" THEMES="${THEMES:-}" SUITE="${SUITE:-}" THEME_SUITE="${THEME_SUITE:-}" IMPORT_THEMES="${IMPORT_THEMES:-}" IMPORT_PLUGINS="${IMPORT_PLUGINS:-}" IMPORT_MU_PLUGINS="${IMPORT_MU_PLUGINS:-}" WOO_ACTIVE="${WOO_ACTIVE:-}" IMPORT_CONTENT="${IMPORT_CONTENT:-}"
      local REC_TREE="" W; W=$(mktemp -d "$T/w.XXXX")
      use_recorded_inputs "$B" "$W" > "$T/use.out" 2>&1 || return $?
      printf '%s\n' "PLUGINS=$PLUGINS" "THEMES=$THEMES" "SUITE=$SUITE" "THEME_SUITE=$THEME_SUITE" "IMPORT_THEMES=$IMPORT_THEMES" "IMPORT_PLUGINS=$IMPORT_PLUGINS" "IMPORT_MU_PLUGINS=$IMPORT_MU_PLUGINS" "WOO_ACTIVE=$WOO_ACTIVE" "REC_TREE=$REC_TREE" > "$T/vars"
      echo "$IMPORT_CONTENT" > "$T/content.path"
      [ "${1:-}" = record ] && { record_build_inputs "$B" build-1 "$W" > "$T/rec.out" 2>&1 || return 1; }
      return 0
    }; env "${@:2}" bash -c "$(declare -f local_test use_recorded_inputs record_build_inputs content_inputs_set); WFP='$HERE/..' APP='$APP' T='$T' B='$B'; local_test $1" )
}
run_update norecord "${IN[@]}"; check "no record and inputs passed: allowed" "$?" 0
check "  it says there is no record yet" "$(grep -c 'no recorded build inputs yet' "$T/use.out")" 1

# 2. A good update records the inputs and the tree.
run_update record "${IN[@]}"; check "a good update records" "$?" 0
python3 -I "$HERE/../build_inputs.py" get "$B" "$T/rec.json"; check "  the record is there" "$?" 0
tree=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["tree"])' "$T/rec.json")
check "  the tree key is _build/c<8 hex>.tar.gz" "$(echo "$tree" | grep -cE '^_build/c[0-9a-f]{8}\.tar\.gz$')" 1
check "  the record holds the input values, no path" "$(grep -c "$T" "$T/rec.json")" 0

# 3. THE GGC CASE: an update that passes NO input builds with the recorded ones and the stored tree.
run_update norecord; check "THE GGC CASE: an update with no input is allowed" "$?" 0
check "  it says it uses the recorded inputs" "$(grep -c 'using the recorded build inputs' "$T/use.out")" 1
check "  IMPORT_PLUGINS is the recorded value" "$(grep '^IMPORT_PLUGINS=' "$T/vars")" "IMPORT_PLUGINS=shop sqlite-database-integration"
check "  IMPORT_MU_PLUGINS is the recorded value" "$(grep '^IMPORT_MU_PLUGINS=' "$T/vars")" "IMPORT_MU_PLUGINS=store-cart.php"
check "  WOO_ACTIVE is the recorded value" "$(grep '^WOO_ACTIVE=' "$T/vars")" "WOO_ACTIVE=1"
check "  REC_TREE is the recorded tree" "$(grep '^REC_TREE=' "$T/vars")" "REC_TREE=$tree"
got=$(cat "$T/content.path")
check "  the fetched tree has the theme, the plugin and the mu-plugin" "$(cat "$got/themes/tt5/style.css" "$got/plugins/shop/shop.php" "$got/mu-plugins/store-cart.php" 2>/dev/null | tr '\n' ' ')" "theme shop mu "
check "  and only the named subset (no unnamed plugin, not the build's own sqlite copy)" "$(ls "$got/plugins" | tr '\n' ' ')" "shop "

# 4. Different inputs: refused, unless REPLACE_INPUTS=1. The same inputs: allowed.
run_update norecord IMPORT_CONTENT="$SRC" IMPORT_THEMES=tt5 IMPORT_PLUGINS=shop IMPORT_MU_PLUGINS= WOO_ACTIVE=1; check "different inputs (the mu-plugin dropped): refused" "$?" 2
check "  the difference is named" "$(grep -c 'IMPORT_MU_PLUGINS' "$T/use.out")" 1
run_update norecord REPLACE_INPUTS=1 IMPORT_CONTENT="$SRC" IMPORT_THEMES=tt5 IMPORT_PLUGINS=shop IMPORT_MU_PLUGINS= WOO_ACTIVE=1; check "the same with REPLACE_INPUTS=1: allowed" "$?" 0
run_update norecord "${IN[@]}"; check "the same inputs as recorded: allowed" "$?" 0
run_update norecord WOO_ACTIVE=0; check "only WOO_ACTIVE=0 passed, recorded 1: refused" "$?" 2

# 4b. THEMES and the pin lists (#457) are recorded and reused like the other inputs. Without SUITE in
# the record, a later update read the default suite.txt and skipped a slug pinned only in another list.
IN2=("${IN[@]}" THEMES=hello-elementor SUITE=gate2-build.txt THEME_SUITE=themes.txt)
run_update record REPLACE_INPUTS=1 "${IN2[@]}"; check "THEMES, SUITE and THEME_SUITE: a good update records them" "$?" 0
run_update norecord; check "  an update with no input is allowed" "$?" 0
check "  THEMES is the recorded value" "$(grep '^THEMES=' "$T/vars")" "THEMES=hello-elementor"
check "  SUITE is the recorded value" "$(grep '^SUITE=' "$T/vars")" "SUITE=gate2-build.txt"
check "  THEME_SUITE is the recorded value" "$(grep '^THEME_SUITE=' "$T/vars")" "THEME_SUITE=themes.txt"
run_update norecord "${IN[@]}" THEMES=astra SUITE=gate2-build.txt THEME_SUITE=themes.txt; check "  a different THEMES is refused" "$?" 2
check "    the difference is named" "$(grep -c 'THEMES: recorded' "$T/use.out")" 1
run_update norecord "${IN[@]}" THEMES=hello-elementor THEME_SUITE=themes.txt; check "  a dropped SUITE is refused" "$?" 2
run_update norecord "${IN2[@]}"; check "  the same inputs: allowed" "$?" 0
check "  THEMES alone counts as a content input" "$(env -i THEMES=x bash -c "$(declare -f content_inputs_set); content_inputs_set")" 1
run_update record REPLACE_INPUTS=1 "${IN[@]}"; check "  (the record goes back to the section 3 inputs)" "$?" 0

# 5. Scope: a recorded value set inside one update does not leak into the next (update --all).
unset PLUGINS IMPORT_PLUGINS; f() { local -x IMPORT_PLUGINS=""; IMPORT_PLUGINS=leaked; }; f
check "a local -x value does not leak out of the update" "${IMPORT_PLUGINS:-unset}" unset

# 6. A hostile record or tree is refused.
python3 -I - "$T" <<'PY'
import io, json, sys, tarfile
t = sys.argv[1]
def tgz(add):
    b = io.BytesIO()
    with tarfile.open(fileobj=b, mode="w:gz") as z: add(z)
    return b.getvalue()
def f(z, name, data=b"x"):
    i = tarfile.TarInfo(name); i.size = len(data); z.addfile(i, io.BytesIO(data))
def l(z, name):
    i = tarfile.TarInfo(name); i.type = tarfile.SYMTYPE; i.linkname = "/etc/passwd"; z.addfile(i)
open(t + "/up.tgz", "wb").write(tgz(lambda z: f(z, "wp-content/../../escape.txt")))
# An absolute name under this test's own dir, so even a broken check never writes to a shared /tmp.
open(t + "/abs.tgz", "wb").write(tgz(lambda z: f(z, t + "/abs-escaped.txt")))
open(t + "/link.tgz", "wb").write(tgz(lambda z: l(z, "wp-content/plugins/x")))
open(t + "/out.tgz", "wb").write(tgz(lambda z: f(z, "other/file.txt")))
PY
for k in up abs link out; do
  python3 -I "$HERE/../build_inputs.py" tree-put "$B" "_build/c0000000$((${#k})).tar.gz" "$T/$k.tgz" >/dev/null 2>&1
  python3 -I "$HERE/../build_inputs.py" tree-get "$B" "_build/c0000000$((${#k})).tar.gz" "$T/x-$k" >/dev/null 2>&1; check "a tree with a $k entry is refused" "$?" 1
done
check "  nothing escaped the out dir" "$([ -e "$T/escape.txt" ] || [ -e "$T/abs-escaped.txt" ] && echo escaped || echo none)" none
python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); r["tree"]="../../x.tar.gz"; json.dump(r, open(sys.argv[2],"w"))' "$T/rec.json" "$T/bad.json"
python3 -I "$HERE/../build_inputs.py" put "$B" "$T/bad.json" >/dev/null
run_update norecord; check "a record whose tree key is not _build/c<8 hex>.tar.gz: refused" "$?" 2
ln -s /etc/hosts "$SRC/plugins/shop/hosts"
python3 -I "$HERE/../build_inputs.py" pack "$SRC" "$T/p.tgz" >/dev/null 2>&1; check "pack refuses a symbolic link in the content" "$?" 1
rm "$SRC/plugins/shop/hosts"

# 6b. Running build_inputs.py leaves no file in the tree (a __pycache__ would make the next update's
# tree_clean_check refuse it).
# Bytecode writing is switched ON first (some Pythons, Apple's 3.9 under -I, never write it, and
# then this check could not fail): only the script's own sys.dont_write_bytecode can stop it.
python3 -I -c 'import runpy, sys; sys.dont_write_bytecode = False; sys.pycache_prefix = None; sys.argv = ["build_inputs.py", "env-json", "c00000000", "", "b"]; runpy.run_path("'"$HERE/../build_inputs.py"'", run_name="__main__")' > /dev/null
check "build_inputs.py writes no __pycache__ next to snapshot.py" "$([ -e "$HERE/../__pycache__" ] && echo present || echo none)" none

# 7. The wiring in deploy/wfp/site: read before the refusals and the snapshot, recorded after a good update.
S="$HERE/../site"
l_use=$(grep -n '  use_recorded_inputs "$bucket" "$WDIR"' "$S" | cut -d: -f1)
l_chk=$(grep -n 'update_inputs_check "${rollback' "$S" | cut -d: -f1)
l_snap=$(grep -n 'snapshot the data to' "$S" | head -1 | cut -d: -f1)
l_upd=$(grep -n 'echo "site $s: updated $rollback -> $new"' "$S" | cut -d: -f1)
l_rec=$(grep -n '    record_build_inputs "$bucket" "$new" "$WDIR"' "$S" | cut -d: -f1)
check "the record is read before the #378 refusals and the snapshot" "$([ -n "$l_use" ] && [ "$l_use" -lt "$l_chk" ] && [ "$l_use" -lt "$l_snap" ] && echo yes || echo no)" yes
check "the record is written right after a good update" "$([ -n "$l_rec" ] && [ "$l_rec" = $((l_upd + 1)) ] && echo yes || echo no)" yes
check "the inputs are local -x in the update" "$(grep -c '  local -x PLUGINS=' "$S")" 1
check "update_one removes its work dir however it ends" "$(grep -A4 '^update_one() {' "$S" | grep -c 'rm -rf "$WDIR"')" 1

echo "$fails failing case(s)"
[ "$fails" = 0 ]
