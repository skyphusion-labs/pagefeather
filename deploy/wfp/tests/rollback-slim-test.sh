#!/bin/bash
# Test of #507: the slim rollback artifact. It holds only what the deploy uploads, and a rollback
# from it deploys upload inputs byte-equal to the original deploy's. It runs the pinned wrangler
# (deploy/wr) with --dry-run --outdir on a small app shaped like b-dosql: the four build/ imports,
# vendor/ wasm and loader, a node_modules package, a node: built-in (unenv from deploy/tools), the
# static assets with _pf/ boot packs, and the build/ parts the deploy never uploads (wordpress/,
# cache/, logs). The artifact goes through the real lib.sh write_rollback_artifact,
# save_rollback_tree and rollback_deploy_dir and the real rollback_artifact.py, against a stand-in
# S3 (fake-s3.py). The app sits in a root with copies of deploy/wr and deploy/tools, as
# spikes/b2-wordpress sits in the repo, so the original deploy and the rollback both run as they
# do for a real site. No account.
#   deploy/wfp/tests/rollback-slim-test.sh
# What is compared: every file wrangler writes to --outdir (the bundle and its modules) except
# README.md (a note with a timestamp) and index.js.map (its sourceRoot is the out dir; the site
# config sets no upload_source_maps, so it is never uploaded), and every file of build/public.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
"$REPO/deploy/wr" --version > /dev/null 2>&1 || { echo "FAIL the pinned wrangler (deploy/wr) does not run"; exit 1; }
fails=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }
T=$(cd "$(mktemp -d)" && pwd -P)   # physical, as lib.sh ROOT and the rollback mirror are
python3 -I "$HERE/fake-s3.py" "$T/port" & S3PID=$!
trap 'kill $S3PID 2>/dev/null; wait $S3PID 2>/dev/null; rm -rf "$T"' EXIT
for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
export WFP_S3_ENDPOINT="http://127.0.0.1:$(cat "$T/port")" WFP_S3_KEY_ID=test-key WFP_S3_SECRET=test-secret CLOUDFLARE_ACCOUNT_ID=test
ACCOUNT_ID=test
# shellcheck disable=SC1091
. "$HERE/../lib.sh"
ROOT=$T/root; mkdir -p "$ROOT/deploy"; cp -p "$REPO/deploy/wr" "$ROOT/deploy/wr"
python3 -I -c 'import shutil, sys; shutil.copytree(sys.argv[1], sys.argv[2], symlinks=True)' "$REPO/deploy/tools" "$ROOT/deploy/tools"
WR=$ROOT/deploy/wr

# The app, at the same depth below its root as spikes/b2-wordpress.
FA=$T/root/spikes/b2-app; mkdir -p "$FA/build/public/wp-includes" "$FA/build/public/_pf/abc" "$FA/build/wordpress/wp-admin" "$FA/build/cache/src" "$FA/vendor" "$FA/node_modules/fakedep"
cat > "$FA/index.js" <<'JS'
import siteZip from './build/site.zip';
import opcacheZip from './build/opcache.zip';
import BUILD_ID from './build/build-id.js';
import OPCACHE_BOOT from './build/opcache-boot-index.js';
import wasmModule from './vendor/php_8_3.wasm';
import * as loader from './vendor/php_8_3.js';
import { performance } from 'node:perf_hooks';
import { hi } from 'fakedep';
import { helper } from './helper.mjs';
export default { async fetch() { return new Response([siteZip.byteLength, opcacheZip.byteLength, BUILD_ID, JSON.stringify(OPCACHE_BOOT), typeof wasmModule, Object.keys(loader).length, hi(), helper(), performance.now() > 0].join(' ')); } };
JS
echo 'export function helper() { return "h"; }' > "$FA/helper.mjs"
echo '{"name":"app","private":true,"type":"module"}' > "$FA/package.json"
echo '{"name":"fakedep","version":"1.0.0","type":"module","main":"index.js"}' > "$FA/node_modules/fakedep/package.json"
echo 'export function hi() { return "hi"; }' > "$FA/node_modules/fakedep/index.js"
printf '\0asm\1\0\0\0' > "$FA/vendor/php_8_3.wasm"
echo 'export const ready = 1;' > "$FA/vendor/php_8_3.js"
head -c 20000 /dev/urandom > "$FA/build/site.zip"; head -c 9000 /dev/urandom > "$FA/build/opcache.zip"
echo 'export default "ab96cafab127";' > "$FA/build/build-id.js"
echo 'export default {"id":"abc","chunks":["boot-0.zip"]};' > "$FA/build/opcache-boot-index.js"
echo 'a{}' > "$FA/build/public/wp-includes/a.css"; head -c 5000 /dev/urandom > "$FA/build/public/_pf/abc/boot-0.zip"
head -c 300000 /dev/urandom > "$FA/build/wordpress/wp-admin/never-uploaded.php"
head -c 300000 /dev/urandom > "$FA/build/cache/src/wordpress.zip"; echo log > "$FA/build/opcache.log"
CONF='name = "slim-test"
main = "index.js"
compatibility_date = "2025-09-01"
compatibility_flags = ["nodejs_compat"]
rules = [{ type = "Data", globs = ["**/*.zip"], fallthrough = false }]
[assets]
directory = "build/public"'
printf '%s\n' "$CONF" > "$FA/wrangler.deploy.slim-test.toml"
dry() { # dry <dir> <config> <out>: a wrangler dry-run build of <dir>, the deploy's upload inputs in <out>
  (cd "$1" && "$WR" deploy --config "$2" --dry-run --outdir "$3") > "$3.log" 2>&1
}
shas() { (cd "$1" && find . -type f ! -name README.md ! -name '*.map' -exec shasum -a 256 {} + | sort -k2); }

dry "$FA" "$FA/wrangler.deploy.slim-test.toml" "$T/out1"; check "wrangler dry-run of the original app" "$?" 0
check "  it wrote the bundle and the site.zip, opcache.zip and wasm modules (the .js imports are inlined)" "$(shas "$T/out1" | wc -l | tr -d ' ')" 4

# The artifact: written by the real write_rollback_artifact, as after a good update.
APP=$FA
write_rollback_artifact wp-wfp-s-media ab96cafab127 > "$T/w.log" 2>&1
check "write_rollback_artifact stores it" "$(grep -c 'stored wp-wfp-s-media/_build/artifact/ab96cafab127.tar.gz' "$T/w.log")" 1
python3 -I "$WFP/rollback_artifact.py" pack "$FA" ab96cafab127 "$T/a.tgz" > /dev/null
names=$(python3 -I -c 'import sys, tarfile; print("\n".join(sorted(tarfile.open(sys.argv[1]).getnames())))' "$T/a.tgz")
check "the artifact holds no build/wordpress, build/cache or build log" "$(printf '%s\n' "$names" | grep -cE '^build/(wordpress|cache|opcache\.log)')" 0
check "  it holds the four imported build/ files and build/public" "$(printf '%s\n' "$names" | grep -cxE 'build/(site\.zip|opcache\.zip|build-id\.js|opcache-boot-index\.js|public/_pf/abc/boot-0\.zip|public/wp-includes/a\.css)')" 6
check "  it holds vendor/ and the root sources" "$(printf '%s\n' "$names" | grep -cxE 'vendor/php_8_3\.(wasm|js)|index\.js|helper\.mjs|package\.json')" 5

# The rollback, as site update runs it: fetch, place beside the app, deploy from there.
SAVED=$(mktemp -d "$T/saved.XXXX")
got=$(save_rollback_tree wp-wfp-s-media ab96cafab127 "$SAVED" 2> "$T/s.log"); check "save_rollback_tree fetches the artifact" "$got:$(grep -c "site's own artifact" "$T/s.log")" "ab96cafab127:1"
IFS=$'\t' read -r RBROOT RB RBWR <<< "$(rollback_deploy_dir "$SAVED")"
check "rollback_deploy_dir puts the tree at the app's own path in a mirror, with its own wrangler" "${RB#"$RBROOT"}:${RBWR#"$RBROOT"}" "/spikes/b2-app:/deploy/wr"
check "  node_modules and deploy/tools are real copies, not links" "$([ -d "$RB/node_modules" ] && [ ! -L "$RB/node_modules" ] && [ -d "$RBROOT/deploy/tools/node_modules" ] && [ ! -L "$RBROOT/deploy/tools" ] && echo copies || echo links)" copies
check "  the mirror is not inside the app's root" "$([[ $RBROOT == "$ROOT"* ]] && echo inside || echo outside)" outside
cp "$FA/wrangler.deploy.slim-test.toml" "$RB/wrangler.rollback.toml"
WR=$RBWR dry "$RB" "$RB/wrangler.rollback.toml" "$T/out2"; check "wrangler dry-run of the rollback tree" "$?" 0
check "#507: the rollback's bundle and modules are byte-equal to the original deploy's" "$(shas "$T/out2")" "$(shas "$T/out1")"
check "  and its static assets are byte-equal" "$(shas "$RB/build/public")" "$(shas "$FA/build/public")"

# The instrument can go red: one byte of site.zip changed, and the comparison differs.
printf 'X' | dd of="$RB/build/site.zip" bs=1 seek=100 conv=notrunc 2>/dev/null
WR=$RBWR dry "$RB" "$RB/wrangler.rollback.toml" "$T/out3"
check "control: one changed byte in site.zip makes the bundle differ" "$([ "$(shas "$T/out3")" = "$(shas "$T/out1")" ] && echo equal || echo differs)" differs
# The #466 way (a temp dir elsewhere, node_modules linked) differs in path strings: why the tree moves.
O=$(mktemp -d "$T/elsewhere/x.XXXX" 2>/dev/null || { mkdir -p "$T/elsewhere/deep/er"; mktemp -d "$T/elsewhere/deep/er/x.XXXX"; })
python3 -I "$WFP/rollback_artifact.py" get wp-wfp-s-media ab96cafab127 "$O" > /dev/null; ln -s "$FA/node_modules" "$O/node_modules"; cp "$FA/wrangler.deploy.slim-test.toml" "$O/w.toml"
dry "$O" "$O/w.toml" "$T/out4"
check "control: from a temp dir elsewhere with a linked node_modules, index.js differs" "$(cmp -s "$T/out4/index.js" "$T/out1/index.js" && echo equal || echo differs)" differs
rm -rf "$RBROOT"

# pack refuses a build that lacks a file a source imports, and finds a dynamic import().
rm "$FA/build/opcache-boot-index.js"
python3 -I "$WFP/rollback_artifact.py" pack "$FA" ab96cafab127 "$T/b.tgz" > /dev/null 2> "$T/p.err"; check "pack refuses a build without an imported file" "$?:$(grep -c 'imports build/opcache-boot-index.js, which the build did not make' "$T/p.err")" "1:1"
echo 'export default 1;' > "$FA/build/opcache-boot-index.js"; echo 'export const lazy = () => import("./build/late.js");' > "$FA/late.mjs"; echo 'export default 2;' > "$FA/build/late.js"
python3 -I "$WFP/rollback_artifact.py" pack "$FA" ab96cafab127 "$T/c.tgz" > /dev/null
check "pack takes a file a dynamic import() names" "$(python3 -I -c 'import sys, tarfile; print(int("build/late.js" in tarfile.open(sys.argv[1]).getnames()))' "$T/c.tgz")" 1
# The real sources: the scan finds every ./build/ import of spikes/b2-wordpress.
want=$(cd "$REPO/spikes/b2-wordpress" && grep -hoE "['\"]\./build/[^'\"]+['\"]" ./*.js ./*.mjs | tr -d "'\"" | sed 's|^\./build/||' | sort -u | tr '\n' ' ')
got=$(python3 -I -c 'import os, sys; sys.dont_write_bytecode = True; sys.path.insert(0, sys.argv[1]); import rollback_artifact as r; a = sys.argv[2]; print(" ".join(r.build_imports(a, sorted(n for n in os.listdir(a) if r.TOP_RE.match(n)))) + " ")' "$WFP" "$REPO/spikes/b2-wordpress")
check "the scan finds every ./build/ import of the real b-dosql sources ($want)" "$got" "$want"
echo "$fails failing check(s)"
[ "$fails" = 0 ]
