#!/bin/bash
# The recorded build inputs of a site (#379, lib.sh use_recorded_inputs and record_build_inputs,
# build_inputs.py), against a fake S3 bucket on localhost. The case that made it: on 2026-11-12 an
# update without the site's inputs shipped the live ggc.sh without its plugins and mu-plugins.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); chmod 700 "$T"
fails=0
SRV=""
# A failing case prints its inputs and leaves a copy of the work dir. The batch
# that saw #601 kept no log, and the work dir used to vanish in the exit trap.
evidence() {
  echo "  --- evidence ($1) ---"
  echo "  endpoint: ${WFP_S3_ENDPOINT-<unset>}"
  if [ -n "$SRV" ] && kill -0 "$SRV" 2>/dev/null; then echo "  server: up"; else echo "  server: down"; fi
  echo "  temp: $T"
  local f p
  for f in last-args use.out rec.out vars content.path pyc.out; do
    if [ -s "$T/$f" ]; then echo "  $f:"; sed 's/^/    /' "$T/$f"; else echo "  $f: (empty)"; fi
  done
  if [ -s "$T/content.path" ]; then
    p=$(cat "$T/content.path")
    if [ -n "$p" ] && [ -d "$p" ]; then echo "  content names:"; find "$p" -print | sed 's/^/    /'; fi
  fi
  if [ -d "$HERE/../__pycache__" ]; then echo "  shared __pycache__:"; find "$HERE/../__pycache__" -type f -print | sed 's/^/    /'; fi
  echo "  ambient PLUGINS=${PLUGINS-<unset>} THEMES=${THEMES-<unset>} IMPORT_CONTENT=${IMPORT_CONTENT-<unset>} IMPORT_THEMES=${IMPORT_THEMES-<unset>} IMPORT_PLUGINS=${IMPORT_PLUGINS-<unset>} IMPORT_MU_PLUGINS=${IMPORT_MU_PLUGINS-<unset>} WOO_ACTIVE=${WOO_ACTIVE-<unset>} REPLACE_INPUTS=${REPLACE_INPUTS-<unset>} CLICOLOR_FORCE=${CLICOLOR_FORCE-<unset>}"
}
check() {
  if [ "$2" = "$3" ]; then echo "  ok   $1"; return; fi
  echo "  FAIL $1"
  echo "    got:  $(printf '%q' "$2")"
  echo "    want: $(printf '%q' "$3")"
  evidence "$1"
  fails=$((fails + 1))
}
cleanup() {
  local st=$? keep
  [ -n "$SRV" ] && { kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; }
  if [ "$fails" != 0 ] && [ -d "$T" ]; then
    local td="${TMPDIR:-/tmp}"
    td="${td%/}"
    keep=$(mktemp -d "$td/build-inputs-test-fail.XXXXXX")
    chmod 700 "$keep"
    cp -R "$T"/. "$keep"/
    echo "evidence kept at $keep"
  fi
  rm -rf "$T"
  exit "$st"
}
trap cleanup EXIT

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
for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
if [ ! -s "$T/port" ] || ! kill -0 "$SRV" 2>/dev/null; then
  echo "  FAIL the fake S3 did not stay up"
  echo "    got:  port $([ -s "$T/port" ] && echo present || echo missing), server $(kill -0 "$SRV" 2>/dev/null && echo up || echo down)"
  echo "    want: a port file and a live server"
  fails=$((fails + 1))
  evidence "the fake S3 did not stay up"
  echo "$fails failing case(s)"
  exit 1
fi
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
run_update() { # run_update <record|norecord> <env assignments...>: one update's scope
  # Drop ambient content inputs first, then apply this case's assignments.
  # local -x keeps an inherited value, so a parent PLUGINS or REPLACE_INPUTS=1
  # used to decide the "no input" case and the refusal cases (#601).
  printf '%q\n' "$@" > "$T/last-args"
  ( local_test() {
      : > "$T/use.out"; : > "$T/vars"; : > "$T/content.path"; : > "$T/rec.out"
      local -x PLUGINS="${PLUGINS:-}" THEMES="${THEMES:-}" SUITE="${SUITE:-}" THEME_SUITE="${THEME_SUITE:-}" IMPORT_THEMES="${IMPORT_THEMES:-}" IMPORT_PLUGINS="${IMPORT_PLUGINS:-}" IMPORT_MU_PLUGINS="${IMPORT_MU_PLUGINS:-}" WOO_ACTIVE="${WOO_ACTIVE:-}" IMPORT_CONTENT="${IMPORT_CONTENT:-}"
      local REC_TREE="" W; W=$(mktemp -d "$T/w.XXXX")
      use_recorded_inputs "$B" "$W" > "$T/use.out" 2>&1 || return $?
      printf '%s\n' "PLUGINS=$PLUGINS" "THEMES=$THEMES" "SUITE=$SUITE" "THEME_SUITE=$THEME_SUITE" "IMPORT_THEMES=$IMPORT_THEMES" "IMPORT_PLUGINS=$IMPORT_PLUGINS" "IMPORT_MU_PLUGINS=$IMPORT_MU_PLUGINS" "WOO_ACTIVE=$WOO_ACTIVE" "REC_TREE=$REC_TREE" > "$T/vars"
      echo "$IMPORT_CONTENT" > "$T/content.path"
      [ "${1:-}" = record ] && { record_build_inputs "$B" build-1 "$W" > "$T/rec.out" 2>&1 || return 1; }
      return 0
    }; env -u PLUGINS -u THEMES -u SUITE -u THEME_SUITE -u IMPORT_CONTENT -u IMPORT_THEMES -u IMPORT_PLUGINS -u IMPORT_MU_PLUGINS -u WOO_ACTIVE -u WOO -u REPLACE_INPUTS -u PF_ENGINE_JS -u PF_ENGINE_WASM "${@:2}" bash -c "$(declare -f local_test use_recorded_inputs record_build_inputs content_inputs_set); WFP='$HERE/..' APP='$APP' T='$T' B='$B'; local_test $1" )
}
# Poison from outside the case. A parent shell, or a batch that exported these,
# must not count as the update's own inputs. The cases below fail if run_update leaks them.
export PLUGINS=from-the-parent THEMES=from-the-parent WOO_ACTIVE=from-the-parent REPLACE_INPUTS=1
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
# BSD ls colors a pipe when CLICOLOR_FORCE is set. env runs the ls binary, so a shell
# function cannot add -G, and the unset stops the color. Do not pass `command`:
# GNU env on Ubuntu looks that name up as a program and the listing is empty (CI).
check "  and only the named subset (no unnamed plugin, not the build's own sqlite copy)" "$(env -u CLICOLOR -u CLICOLOR_FORCE ls "$got/plugins" | tr '\n' ' ')" "shop "

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

# 4c. #642: the engine. A site built with PF_ENGINE_JS and PF_ENGINE_WASM (the lean engine) records the
# two files' sha256, never a path. An update that would build another engine, or none (npm), is refused
# unless REPLACE_INPUTS=1, also when it passes no other input (the recorded inputs cannot bring an
# engine back: it is a file). Before #642 an update without the pair silently rebuilt a lean site on npm.
printf 'lean js' > "$T/e1.js"; printf 'lean wasm 1' > "$T/e1.wasm"; printf 'lean wasm 2' > "$T/e2.wasm"
E1=(PF_ENGINE_JS="$T/e1.js" PF_ENGINE_WASM="$T/e1.wasm")
run_update record REPLACE_INPUTS=1 "${IN[@]}" "${E1[@]}"; check "an engine build records" "$?" 0
python3 -I "$HERE/../build_inputs.py" get "$B" "$T/rec-e.json"
want=$(cat "$T/e1.wasm" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1):$(cat "$T/e1.js" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1)
check "  the record holds the engine's sha256 (wasm:js)" "$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("engine", "MISSING"))' "$T/rec-e.json")" "$want"
check "  and no path" "$(grep -c "$T" "$T/rec-e.json")" 0
run_update norecord; check "THE #642 CASE: an update with NO input on a lean site: refused" "$?" 2
check "  it names the engine and how to keep or change it" "$(grep -c 'PF_ENGINE_JS and PF_ENGINE_WASM' "$T/use.out")" 1
run_update norecord "${E1[@]}"; check "  the same engine and no other input: allowed (the recorded inputs are used)" "$?" 0
check "    it uses the recorded inputs" "$(grep -c 'using the recorded build inputs' "$T/use.out")" 1
run_update norecord "${IN[@]}"; check "the recorded inputs but no engine (npm): refused" "$?" 2
run_update norecord "${IN[@]}" PF_ENGINE_JS="$T/e1.js" PF_ENGINE_WASM="$T/e2.wasm"; check "another engine: refused" "$?" 2
run_update norecord "${IN[@]}" "${E1[@]}"; check "the same inputs and the same engine: allowed" "$?" 0
run_update norecord REPLACE_INPUTS=1 "${IN[@]}"; check "REPLACE_INPUTS=1 with no engine: allowed (a change to npm on purpose)" "$?" 0
check "  it says the engine changes" "$(grep -c 'engine:' "$T/use.out")" 1
# A record from before #642 has no engine key: it reads as npm, so a run with no engine is unchanged.
python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); d.pop("engine", None); json.dump(d, open(sys.argv[2], "w"))' "$T/rec-e.json" "$T/rec-old.json"
check "an old record (no engine key) and an npm run: equal" "$(env -u PF_ENGINE_JS -u PF_ENGINE_WASM python3 -I "$HERE/../build_inputs.py" engine-check "$T/rec-old.json" > /dev/null; echo $?)" 0
check "an old record and an engine run: differ" "$(env PF_ENGINE_JS="$T/e1.js" PF_ENGINE_WASM="$T/e1.wasm" python3 -I "$HERE/../build_inputs.py" engine-check "$T/rec-old.json" > /dev/null; echo $?)" 4
run_update record REPLACE_INPUTS=1 "${IN[@]}"; check "  (the record goes back to the section 3 inputs, npm)" "$?" 0

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

# 6b. Running build_inputs.py leaves no __pycache__ beside snapshot.py (a file there makes the next
# update's tree_clean_check refuse the tree). The check uses a private copy. deploy/wfp/__pycache__
# is shared with the rest of a batch: config-hash-test.sh imports site_settings and leaves
# site_settings.*.pyc, and rollback-artifact-test.py deletes that directory. Checking the shared
# directory failed once in that batch and passed on a later run alone (#601).
# Bytecode writing is switched ON first (some Pythons, Apple's 3.9 under -I, never write it, and
# then this check could not fail): only the script's own sys.dont_write_bytecode can stop it.
PYC="$T/pyc"
mkdir -p "$PYC"
cp "$HERE/../build_inputs.py" "$HERE/../snapshot.py" "$PYC/"
python3 -I -c 'import runpy, sys; sys.dont_write_bytecode = False; sys.pycache_prefix = None; sys.argv = ["build_inputs.py", "env-json", "c00000000", "", "b"]; runpy.run_path("'"$PYC"'/build_inputs.py", run_name="__main__")' > "$T/pyc.out" 2>&1
check "the bytecode probe ran" "$?" 0
check "build_inputs.py writes no __pycache__ next to snapshot.py" "$([ -e "$PYC/__pycache__" ] && echo present || echo none)" none

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
