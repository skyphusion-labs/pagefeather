# engine

The pagefeather engine (issue #582): our own WebAssembly build of PHP 8.3. The product name is
"pagefeather engine", never a name with "PHP" in it (PHP License clause 4, Conrad's ruling of
2026-11-14); its notices say that it includes PHP. Today the Worker runs WordPress
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

## The fileinfo database (#582 S2b)

WordPress checks every upload with `wp_check_filetype_and_ext()`, and for a file that is not an image it
asks fileinfo (`finfo_file`) for the real type. php-src compiles libmagic's whole database into the
engine: 7.59 MiB of static memory, the largest single item in it. The pagefeather engine keeps
fileinfo and builds a smaller database from the same source.

**What it holds** (Conrad's spec and the lead's ruling, 2026-11-14):

- the types WordPress accepts for upload: `wp_get_mime_types()` as `get_allowed_mime_types()` leaves it,
  plus the Font Library's otf, ttf, woff and woff2 (`fileinfo/accepted.txt`);
- rejection signatures: executables (PE, ELF, Mach-O), scripts, PHP, HTML, XML, SVG, JavaScript, Java and
  Flash (`fileinfo/rejection.txt`). WordPress does not accept these. They are kept so that one of them,
  renamed to an accepted extension, still sniffs as what it is, and WordPress refuses it.

**How it is built:** `fileinfo/build-db.sh` runs inside the build image. It builds file 5.43, the libmagic
version php-src 8.3.36 bundles. It first proves the pipeline: the full database it compiles must equal
php-src's own `data_file.c`, byte for byte. Then `fileinfo/select.py` keeps only the entries of the types
above, and the result replaces `data_file.c`. Measured 2026-11-14: 334 of 3,653 entries, 1.66 MiB; the
engine's static data end is 5.44 MiB (11.37 MiB with the full database).

**The known limit.** WordPress accepts a sniff of `application/octet-stream` for any `application/`,
`video/` or `audio/` extension. A full database names almost every format; this one names only the
accepted types and the rejection signatures. So a HARMLESS file of a type WordPress does not accept,
renamed to an accepted `application/`, `video/` or `audio/` extension, is ACCEPTED here, where a host
with the full database refuses it. Example: a SQLite database renamed `report.doc`. The lead accepted
this on 2026-11-14:

- every dangerous class is still refused, renamed to any accepted extension;
- images are not affected (`getimagesize` decides, and octet-stream is refused for `image/` types);
- the memory saved is 5.93 MiB of static data.

The test `the known differences are still different` pins the two examples (a SQLite database as
`.doc`, PostScript as `.pdf`), so a change to this limit is noticed.

**The tests:**

- `tests/fileinfo-sniff.test.mjs`: every accepted and disguise fixture (`fileinfo/fixtures.py`) must
  sniff exactly as the full database does.
- `tests/upload-sniff.py` with `tests/upload-sniff-compare.py`: WordPress's own upload decision for every
  fixture must be the same as on an engine with the full database.

Both have red controls in the `fileinfo-gates` job: with no rejection signatures, and with no fileinfo,
they must fail.
