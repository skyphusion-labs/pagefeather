#!/bin/bash
# The c-cpp build CodeQL traces (#608): php-src at the pinned tag, with the same ext/opcache the engine
# compiles (Playground's static glue, then every engine/opcache/*.patch), built NATIVELY with gcc.
#   engine/opcache/codeql-build.sh <work-dir>
# Why native and not engine/build.sh: the engine build is an emscripten docker build (base image, libs,
# the whole of PHP, then link), far too heavy for every pull request. CodeQL needs the patched C to
# COMPILE, not to link to wasm, so this configures php-src natively with only opcache and compiles the
# ext/opcache objects. It also compiles engine/opcache/opcache_module_stats.c (the M1 measurement glue,
# which replaces opcache_module.c in that build) as its own translation unit.
# Every pin comes from engine/UPSTREAM, and each check below stops the build, so a patch that does not
# apply, or a tree that is not the pinned one, is a red job and never a vacuous green scan.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
work=${1:?usage: engine/opcache/codeql-build.sh <work-dir>}
mkdir -p "$work"; work=$(cd "$work" && pwd)
# shellcheck source=../UPSTREAM
. "$here/UPSTREAM"
fail() { echo "::error::$*" >&2; exit 1; }

# 1. php-src at the tag, checked against the pinned commit.
php="$work/php-src"
rm -rf "$php"
git clone -q --depth 1 --branch "$PHP_REF" https://github.com/php/php-src "$php"
got=$(git -C "$php" rev-parse HEAD)
[ "$got" = "$PHP_REF_COMMIT" ] || fail "php-src $PHP_REF is $got, not $PHP_REF_COMMIT"
echo "php-src $PHP_REF at $got"

# 2. Playground's opcache glue (opcache_module.c, php_opcache.h), from the pinned compile tree, as the
#    Dockerfile's COPY ./compile/opcache/ /root/php-src/ext/opcache does.
pg="$work/playground"
rm -rf "$pg"; git init -q "$pg"
git -C "$pg" remote add origin "$UPSTREAM_REPO"
git -C "$pg" sparse-checkout set --no-cone packages/php-wasm/compile/opcache >/dev/null
git -C "$pg" fetch -q --depth 1 --filter=blob:none origin "$UPSTREAM_COMMIT"
git -C "$pg" checkout -q FETCH_HEAD
got=$(git -C "$pg" rev-parse HEAD:packages/php-wasm/compile)
[ "$got" = "$UPSTREAM_COMPILE_TREE" ] || fail "compile tree is $got, not $UPSTREAM_COMPILE_TREE"
cp "$pg/packages/php-wasm/compile/opcache/"* "$php/ext/opcache/"

# 3. The engine's patches, as engine/build.sh applies them: --check first, then apply. A patch that does
#    not apply stops here.
n=0
: > "$work/applied-patches.txt"
for p in "$here"/opcache/*.patch; do
  [ -f "$p" ] || continue
  git -C "$php" apply --check "$p" || fail "$(basename "$p") does not apply to php-src $PHP_REF"
  git -C "$php" apply "$p"
  echo "engine/opcache/$(basename "$p")" >> "$work/applied-patches.txt"  # for codeql-sarif-map.py
  echo "applied $(basename "$p")"; n=$((n + 1))
done
[ "$n" -gt 0 ] || fail "no engine/opcache/*.patch found"
c=$(grep -c 'pagefeather lazy bodies' "$php/ext/opcache/zend_persist.c" || true)
[ "${c:-0}" -gt 0 ] || fail "the pf-lazy-bodies marker is not in ext/opcache/zend_persist.c after the patch"
echo "marker in zend_persist.c: $c"

# 4. config.m4 as the Dockerfile edits it for PHP 8.3 (static opcache plus the glue module). Each edit
#    must match, so an upstream change cannot silently skip one.
m4="$php/ext/opcache/config.m4"
for e in 's/have_shm_mmap_anon=no/have_shm_mmap_anon=yes/g' 's/shared,,/no,,/g' \
         's/ext_shared=yes/ext_shared=no/g' 's/shared_alloc_mmap.c/shared_alloc_mmap.c opcache_module.c/g'; do
  from=${e#s/}; from=${from%%/*}
  grep -q -- "$from" "$m4" || fail "config.m4 has no '$from' for the edit $e"
  sed -i -e "$e" "$m4"
done

# 5. Configure natively with only opcache (flags as the Dockerfile's), then compile the opcache objects.
cd "$php"
./buildconf --force > "$work/buildconf.log" 2>&1 || { tail -40 "$work/buildconf.log"; fail "buildconf failed"; }
./configure --disable-all --disable-cgi --disable-phpdbg --enable-opcache --disable-opcache-jit \
  --disable-huge-code-pages > "$work/configure.log" 2>&1 || { tail -60 "$work/configure.log"; fail "configure failed"; }
# The bison headers the opcache sources include. Zend/Makefile.frag names them with an absolute srcdir,
# so the targets are read from the Makefile; both must be found.
mapfile -t gen < <(grep -oE '^[^ :#]*Zend/zend_(language|ini)_parser\.h' Makefile | sort -u)
[ "${#gen[@]}" -eq 2 ] || fail "expected 2 Zend parser header targets in the Makefile, found ${#gen[@]}: ${gen[*]:-none}"
make -j"$(nproc)" "${gen[@]}" > "$work/make-gen.log" 2>&1 \
  || { tail -40 "$work/make-gen.log"; fail "generating the Zend parser headers failed"; }
mapfile -t objs < <(grep -oE 'ext/opcache/[A-Za-z0-9_/]+\.lo' Makefile | sort -u)
[ "${#objs[@]}" -gt 0 ] || fail "no ext/opcache objects in the Makefile"
for f in zend_persist ZendAccelerator zend_file_cache opcache_module; do
  printf '%s\n' "${objs[@]}" | grep -qx "ext/opcache/$f.lo" || fail "ext/opcache/$f.lo is not a build object"
done
make -j"$(nproc)" "${objs[@]}" > "$work/make.log" 2>&1 || { tail -60 "$work/make.log"; fail "compiling ext/opcache failed"; }
echo "compiled ${#objs[@]} ext/opcache objects"

# 6. The M1 stats glue, compiled with the same include path as the opcache objects.
gcc -c -O0 -DHAVE_CONFIG_H -DZEND_ENABLE_STATIC_TSRMLS_CACHE=1 -I. -Imain -IZend -ITSRM -Iext/opcache \
  "$here/opcache/opcache_module_stats.c" -o "$work/opcache_module_stats.o"
echo "compiled engine/opcache/opcache_module_stats.c"
