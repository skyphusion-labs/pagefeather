#!/bin/bash
# Build the pagefeather engine (PHP 8.3, web, JSPI) from the pinned upstream pipeline (#582), with docker.
#   engine/build.sh <out-dir>
# ENGINE_VARIANT=unchanged (default, S1): upstream UNCHANGED, with the same build args as Playground's
# build.js uses for "--PLATFORM=web --PHP_VERSION=8.3.36 --WITH_JSPI=yes" (platformDefaults.all plus web).
# ENGINE_VARIANT=lean (S2): engine/patches/lean.py edits the Dockerfile (no MAIN_MODULE, the extension
# list of #582) and curl, soap and mbregex are off; ENGINE_GD=no is the measured arm without GD.
# The loader is formatted with upstream's prettier (engine/tools, npm ci there first), as upstream
# formats the loaders it commits; the raw loader is kept as php_8_3.raw.js.
# build.js itself is not run: it refreshes PHP versions from the network and needs the monorepo's npm
# install. Each phase prints a line "@event phase {json}" with its time, for the job summary.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?usage: engine/build.sh <out-dir>}
mkdir -p "$out"; out=$(cd "$out" && pwd)
# shellcheck source=UPSTREAM
. "$here/UPSTREAM"
work=${ENGINE_WORK:-$(mktemp -d)}
t0=$(date +%s); last=$t0
phase() { local now; now=$(date +%s); echo "@event phase {\"name\":\"$1\",\"s\":$((now - last)),\"total\":$((now - t0))}"; last=$now; }

# 1. The upstream tree at the commit: only the compile pipeline and the 8.3 web builds (the Dockerfile
#    copies web-builds/ for the extension ABI list).
src="$work/playground"
rm -rf "$src"; git init -q "$src"
git -C "$src" remote add origin "$UPSTREAM_REPO"
git -C "$src" sparse-checkout set --no-cone packages/php-wasm/compile packages/php-wasm/web-builds/8-3 >/dev/null
git -C "$src" fetch -q --depth 1 origin "$UPSTREAM_COMMIT"
git -C "$src" checkout -q FETCH_HEAD
got=$(git -C "$src" rev-parse HEAD:packages/php-wasm/compile)
[ "$got" = "$UPSTREAM_COMPILE_TREE" ] || { echo "compile tree is $got, not $UPSTREAM_COMPILE_TREE" >&2; exit 1; }
got=$(git -C "$src" rev-parse HEAD:packages/php-wasm/web-builds/8-3)
[ "$got" = "$UPSTREAM_WEB83_TREE" ] || { echo "web-builds/8-3 tree is $got, not $UPSTREAM_WEB83_TREE" >&2; exit 1; }
got=$(git ls-remote https://github.com/php/php-src "refs/tags/$PHP_REF^{}" | cut -f1)
[ "$got" = "$PHP_REF_COMMIT" ] || { echo "php-src $PHP_REF is $got, not $PHP_REF_COMMIT" >&2; exit 1; }
grep -q "install --notty $EMSDK_VERSION" "$src/packages/php-wasm/compile/base-image/Dockerfile" || { echo "base image does not install emsdk $EMSDK_VERSION" >&2; exit 1; }
phase checkout

# 2. The base image (emsdk), as the upstream Makefile's base-image target.
compile="$src/packages/php-wasm/compile"
# ENGINE_PIN_ENV=1: a VARIANT, not the unchanged build. PHP_UNAME and SOURCE_DATE_EPOCH are set to the
# shipped binary's build-host values (engine/UPSTREAM), right after the Dockerfile's FROM line.
if [ "${ENGINE_PIN_ENV:-0}" = 1 ]; then
  df="$compile/php/Dockerfile"
  [ "$(head -1 "$df")" = "FROM playground-php-wasm:base" ] || { echo "php/Dockerfile does not start with the expected FROM" >&2; exit 1; }
  { head -1 "$df"; echo "ENV PHP_UNAME=\"$SHIPPED_PHP_UNAME\" SOURCE_DATE_EPOCH=$SHIPPED_BUILD_EPOCH"; tail -n +2 "$df"; } > "$df.pf" && mv "$df.pf" "$df"
  sed -n 2p "$df"
fi
(cd "$compile/base-image" && docker build -f ./Dockerfile -t playground-php-wasm:base --progress=plain . > "$out/base-image.log" 2>&1) || { tail -60 "$out/base-image.log"; exit 1; }
phase base-image

variant=${ENGINE_VARIANT:-unchanged}
case "$variant" in unchanged) ;; lean) python3 -I "$here/patches/lean.py" "$compile/php/Dockerfile" ;; *) echo "unknown ENGINE_VARIANT $variant" >&2; exit 1 ;; esac
# The fileinfo trim inputs ride in the docker context (lean only; lean.py's edit 11 copies them).
if [ "$variant" = lean ]; then rm -rf "$compile/../pagefeather-fileinfo"; cp -R "$here/fileinfo" "$compile/../pagefeather-fileinfo"; fi
# Lean with GD: libgd rebuilt from upstream's recipe without AVIF (engine/patches/libgd-noavif.py), as
# the upstream Makefile's libgd_jspi target does, replacing the prebuilt archive in the tree.
if [ "$variant" = lean ] && [ "${ENGINE_GD:-yes}" = yes ]; then
  python3 -I "$here/patches/libgd-noavif.py" "$compile/libgd/Dockerfile"
  (cd "$compile" && docker build -f ./libgd/Dockerfile -t pagefeather-engine-libgd . --build-arg JSPI=1 --progress=plain > "$out/libgd-build.log" 2>&1) || { tail -60 "$out/libgd-build.log"; exit 1; }
  rm -rf "$compile/libgd/jspi/dist/root/lib"; mkdir -p "$compile/libgd/jspi/dist/root/lib"
  cid=$(docker create pagefeather-engine-libgd)
  for d in lib include bin; do docker cp "$cid:/root/install/$d" "$compile/libgd/jspi/dist/root/lib"; done
  docker rm "$cid" > /dev/null
  phase libgd
fi
[ -x "$here/tools/node_modules/.bin/prettier" ] || { echo "run npm ci in engine/tools first (the pinned prettier)" >&2; exit 1; }

# 3. PHP, as build.js runs it (context packages/php-wasm).
host_out="$compile/../web-builds/8-3/jspi"
args=(PHP_VERSION="$PHP_VERSION" PHP_REF="$PHP_REF" OPENSSL_VERSION=1.1.0h
  WITH_FILEINFO=yes WITH_LIBXML=yes WITH_SOAP=yes WITH_LIBZIP=yes WITH_EXIF=yes WITH_GD=yes
  WITH_MBSTRING=yes WITH_MBREGEX=yes WITH_CLI_SAPI=yes WITH_OPENSSL=yes WITH_NODEFS=no WITH_CURL=yes
  WITH_SQLITE=yes WITH_SOURCEMAPS=no OUTPUT_DIR_ON_HOST="$host_out" WITH_DEBUG=no
  DEBUG_DWARF_COMPILATION_DIR="$compile/.." WITH_ICONV=yes WITH_MYSQL=no WITH_WS_NETWORKING_PROXY=yes
  WITH_IMAGICK=no EMSCRIPTEN_ENVIRONMENT=web WITH_JSPI=yes WITH_OPCACHE=yes STACK_SIZE=1MB)
if [ "$variant" = lean ]; then
  # Later entries win in build-arg order. No network in a Worker: curl and soap; mb_ereg is used only
  # inside symfony polyfills: mbregex (and oniguruma).
  args+=(WITH_CURL=no WITH_SOAP=no WITH_MBREGEX=no WITH_GD="${ENGINE_GD:-yes}")
  # ENGINE_FILEINFO=no: a MEASURED arm only, never shipped (the lead's ruling, 2026-11-14): fileinfo's
  # compiled-in magic database is 7.59 MiB of .rodata (the linker map of run 43648222519).
  [ "${ENGINE_FILEINFO:-yes}" = yes ] || args+=(WITH_FILEINFO=no)
  # ENGINE_MAGIC=trim: the trimmed fileinfo database (S2b, engine/fileinfo/build-db.sh).
  args+=(PF_MAGIC="${ENGINE_MAGIC:-full}")
fi
bargs=(); for a in "${args[@]}"; do bargs+=(--build-arg "$a"); done
(cd "$compile" && docker build -f php/Dockerfile .. --tag=pagefeather-engine-build --progress=plain "${bargs[@]}" > "$out/docker-build.log" 2>&1) || { tail -60 "$out/docker-build.log"; exit 1; }
phase php

# 4. The outputs, as build.js copies them.
docker run --rm -v "$out:/output" pagefeather-engine-build sh -c "cp -rf /root/output/* /output && chown -R $(id -u):$(id -g) /output"
printf '%s\n' "${args[@]}" > "$out/build-args.txt"
echo "ENGINE_VARIANT=$variant ENGINE_GD=${ENGINE_GD:-yes} ENGINE_FILEINFO=${ENGINE_FILEINFO:-yes} ENGINE_MAGIC=${ENGINE_MAGIC:-full} ENGINE_PIN_ENV=${ENGINE_PIN_ENV:-0}" >> "$out/build-args.txt"
# The linker inputs (wasm-ld --trace, lean only): one path per line, archive members folded into the archive.
if [ "$variant" = lean ]; then
  sed -E 's/^#[0-9]+ [0-9.]+ //' "$out/docker-build.log" | grep -E '^/[^ ]+\.(a|o)(\([^)]*\))?$' | sed -E 's/\(.*\)$//' | sort -u > "$out/link-inputs.txt"
  [ -s "$out/link-inputs.txt" ] || { echo "no link inputs traced" >&2; exit 1; }
  echo "link inputs: $(wc -l < "$out/link-inputs.txt")"
fi
lj=$(find "$out" -name php_8_3.js | head -1)
cp "$lj" "${lj%.js}.raw.js"
"$here/tools/node_modules/.bin/prettier" --config "$here/tools/.prettierrc" --write "$lj" > /dev/null
{ echo "UPSTREAM_COMMIT=$UPSTREAM_COMMIT"; echo "PHP_REF_COMMIT=$PHP_REF_COMMIT"; echo "EMSDK_VERSION=$EMSDK_VERSION";
  docker run --rm playground-php-wasm:base bash -lc "source /root/emsdk/emsdk_env.sh >/dev/null 2>&1; emcc --version | head -1; git -C /root/emsdk rev-parse HEAD" ; } > "$out/manifest.txt" 2>&1 || true
(cd "$out" && find . -type f \( -name "*.wasm" -o -name "*.js" -o -name "*.so" \) -exec shasum -a 256 {} + | sort -k2 > SHA256SUMS)
phase extract
cat "$out/SHA256SUMS"
