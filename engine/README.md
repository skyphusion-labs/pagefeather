# engine

Pagefeather's own PHP 8.3 WebAssembly engine (issue #582). Today the Worker runs WordPress
Playground's prebuilt `@php-wasm/web-8-3` 3.1.62, patched by `spikes/b2-wordpress/prepare.sh`.
This directory will hold the build of our own engine. The design is in issue #582.

- `expect/`: what an engine must be: the PHP version, the SAPI name, the exact list of loaded
  extensions and the initial memory in pages. `upstream-3.1.62.json` describes today's engine.
- The contract checks are `spikes/b2-wordpress/tests/engine-contract.mjs`. The test
  `engine-contract.test.mjs` runs each check on the engine under test (they must pass). It also runs
  each check on the npm 3.1.62 artifact as shipped, or on a targeted mutation (each must fail).

Run it on another build:

    ENGINE_JS=<loader.js> ENGINE_WASM=<php.wasm> ENGINE_EXPECT=<expect.json> \
      node --test spikes/b2-wordpress/tests/engine-contract.test.mjs

It needs `npm ci` and `./prepare.sh` in `spikes/b2-wordpress`, and Node 24 or later (JSPI).
