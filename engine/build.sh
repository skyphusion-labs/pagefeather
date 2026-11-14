#!/bin/bash
# Build the pagefeather engine (PHP 8.3, web, JSPI) from the pinned upstream pipeline (#582), with docker.
#   engine/build.sh <out-dir>
# S1: upstream UNCHANGED, with the same build args as Playground's build.js uses for
# "--PLATFORM=web --PHP_VERSION=8.3.36 --WITH_JSPI=yes" (its platformDefaults.all plus web).
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
(cd "$compile/base-image" && docker build -f ./Dockerfile -t playground-php-wasm:base --progress=plain . > "$out/base-image.log" 2>&1) || { tail -60 "$out/base-image.log"; exit 1; }
phase base-image

# 3. PHP, as build.js runs it (context packages/php-wasm).
host_out="$compile/../web-builds/8-3/jspi"
args=(PHP_VERSION="$PHP_VERSION" PHP_REF="$PHP_REF" OPENSSL_VERSION=1.1.0h
  WITH_FILEINFO=yes WITH_LIBXML=yes WITH_SOAP=yes WITH_LIBZIP=yes WITH_EXIF=yes WITH_GD=yes
  WITH_MBSTRING=yes WITH_MBREGEX=yes WITH_CLI_SAPI=yes WITH_OPENSSL=yes WITH_NODEFS=no WITH_CURL=yes
  WITH_SQLITE=yes WITH_SOURCEMAPS=no OUTPUT_DIR_ON_HOST="$host_out" WITH_DEBUG=no
  DEBUG_DWARF_COMPILATION_DIR="$compile/.." WITH_ICONV=yes WITH_MYSQL=no WITH_WS_NETWORKING_PROXY=yes
  WITH_IMAGICK=no EMSCRIPTEN_ENVIRONMENT=web WITH_JSPI=yes WITH_OPCACHE=yes STACK_SIZE=1MB)
bargs=(); for a in "${args[@]}"; do bargs+=(--build-arg "$a"); done
(cd "$compile" && docker build -f php/Dockerfile .. --tag=pagefeather-engine-build --progress=plain "${bargs[@]}" > "$out/docker-build.log" 2>&1) || { tail -60 "$out/docker-build.log"; exit 1; }
phase php

# 4. The outputs, as build.js copies them.
docker run --rm -v "$out:/output" pagefeather-engine-build sh -c "cp -rf /root/output/* /output && chown -R $(id -u):$(id -g) /output"
printf '%s\n' "${args[@]}" > "$out/build-args.txt"
{ echo "UPSTREAM_COMMIT=$UPSTREAM_COMMIT"; echo "PHP_REF_COMMIT=$PHP_REF_COMMIT"; echo "EMSDK_VERSION=$EMSDK_VERSION";
  docker run --rm playground-php-wasm:base bash -lc "source /root/emsdk/emsdk_env.sh >/dev/null 2>&1; emcc --version | head -1; git -C /root/emsdk rev-parse HEAD" ; } > "$out/manifest.txt" 2>&1 || true
(cd "$out" && find . -type f \( -name "*.wasm" -o -name "*.js" -o -name "*.so" \) -exec shasum -a 256 {} + | sort -k2 > SHA256SUMS)
phase extract
cat "$out/SHA256SUMS"
