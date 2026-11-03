#!/bin/bash
# Build vendor/php_8_3.js from the pinned @php-wasm/web-8-3 JSPI loader.
# workerd has no import.meta.url, so the first statement (two lines) that
# builds the wasm URL from it is replaced. The Worker passes the wasm module
# itself through instantiateWasm, so the file name is never fetched.
set -euo pipefail
cd "$(dirname "$0")"
src=node_modules/@php-wasm/web-8-3/jspi/php_8_3.js
mkdir -p vendor
{ echo "const dependencyFilename = 'php_8_3.wasm';"; tail -n +3 "$src"; } > vendor/php_8_3.js
head -1 vendor/php_8_3.js
