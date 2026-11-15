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

## Fibers (#624)

`Fiber::start()` must not abort the wasm runtime. The check `fibers: start() does not abort the runtime` runs the probe from the issue. On the lean engine (static, no dylink section) the runtime must survive that probe and the next `php.run()` must work. On the npm engine the same probe aborts. The check passes there and records the abort as a known gap (`@event fiber-gap`). The npm package is upstream's binary.

The missing call is `getcontext`. wasm32 has no boost.context assembly, so the build passes `--disable-fiber-asm` and PHP uses ucontext. The loader defines `getcontext`, `makecontext` and `swapcontext` as abort stubs. Each prints `missing function: ${name}` (the name is not filled in) and `abort()` becomes `unreachable`. `Fiber::start()` calls `getcontext` first, so that is the frame in the stack.

The lean build refuses the switch. `engine/patches/no-fibers.patch`, applied only when `ENGINE_VARIANT=lean`, makes `zend_fiber_init_context` throw `Error` with the message `Fibers are not supported on this platform` and return before `getcontext`. `Fiber::start` already turns that failure into the thrown error. The next request still runs.

A working Fiber needs a JSPI context switch across the Zend VM: emscripten's fiber API, and every frame on the switch listed so a suspend can rewind. That is a new execution substrate. A frame left off that list aborts the runtime the same way `getcontext` does. The catchable Error keeps the runtime serving the next request. The unchanged build does not get the patch, so the reproduction comparison stays byte-identical.

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

**WordPress quirks.** Some types are in WordPress's list but WordPress 7.1.4 itself refuses them on any host with
PHP's full libmagic 5.43 database, for a real file. libmagic's name for the format differs from WordPress's, and
`wp_check_filetype_and_ext()` then refuses it. These are not accepted types in practice. The tests keep them
apart (`wp-quirk` in `fileinfo/fixtures.py`, each with its reason) and require the trimmed engine to refuse them
exactly as the full one does:

| extension | libmagic says | WordPress expects |
|---|---|---|
| gz | application/gzip | application/x-gzip |
| rar | application/x-rar | application/rar |
| class | application/x-java-applet | application/java |
| mdb | application/x-msaccess | application/vnd.ms-access |
| wpd | application/vnd.wordperfect | application/wordperfect |
| mpp | application/x-ole-storage (libmagic names no Project type) | application/vnd.ms-project |
| ico | image/vnd.microsoft.icon | image/x-icon |
| psd | image/psd (getimagesize) | application/octet-stream |
| xcf | image/x-xcf | application/octet-stream |
| wma | video/x-ms-asf (WMA is an ASF container) | audio/x-ms-wma |
| mka | video/x-matroska | audio/x-matroska |
| dfxp | text/xml | application/ttaf+xml |
| css, js, tsv, wax, wmx | text/plain | text/css, application/javascript, text/tab-separated-values, audio/x-ms-wax, video/x-ms-wmx |

Fonts (ttf, otf, woff, woff2) are not media-library uploads: core accepts them through the Font Library, which
widens `upload_mimes` for the upload. The tests upload them there.

**The tests:**

- `tests/fileinfo-sniff.test.mjs`: every accepted and disguise fixture (`fileinfo/fixtures.py`) must
  sniff exactly as the full database does.
- `tests/upload-sniff.py` with `tests/upload-sniff-compare.py`: WordPress's own upload decision for every
  fixture must be the same as on an engine with the full database.

Both have red controls in the `fileinfo-gates` job: with no rejection signatures, and with no fileinfo,
they must fail.

## OPcache lazy function bodies (#582 S4)

Most function bodies an editor screen loads never run: 31 of 42 MiB on the editor screens (M1, #582
issuecomment-6887162662, measured with `ENGINE_OPCACHE_STATS=1`). The lazy-body work keeps them out of
OPcache's shared memory until a function is first called. It is built in slices behind
`ENGINE_LAZY_BODIES=1`, off by default (the plan: #582 issuecomment-6888051884).

- **M2a, the layout.** `opcache/pf-lazy-bodies.patch` makes OPcache place the body parts
  of every function and method (literals, opcodes, live ranges, try/catch; not the main script) in a
  tail region of each script's block. The file cache header records where the tail starts
  (`pf_body_offset`, `pf_body_size`), and the system id changes with the flag, so lazy and eager files
  never mix.
- `tools/bin-split.py <opcache.zip>` checks the layout of every `.bin` and sums it. The header size is
  read from each file's own length (88 bytes with the patch, 72 without), so `--expect-eager` passes an
  eager zip and the default mode refuses it (the red control in the `lazy-bodies` job).
- The split runs only in a shared-memory persist. When shared memory is full, OPcache persists the script
  again for the file cache (`store_script_in_file_cache`). That second calc runs with `corrupted` set and
  counts strings the first calc had already interned. Upstream then over-counts, which it only warns about,
  so that persist stays unsplit. A head that does not end where calc said never bails the request
  (`ACCEL_LOG_ERROR` calls `zend_bailout`): it is logged as a warning and counted, and the script is stored
  unsplit. `opcache_get_status()["pagefeather_lazy_bodies"]` (also `/_mem`'s `ini.lb`) holds `split_scripts`,
  `body_bytes`, `mismatch`, `overlap` and `noregion`. `noregion` counts a body block reached with no body region; that block is left unsplit, with a warning and never a bailout. Only the startup entropy check logs an error, which stops the runtime loudly before any request.
- `spikes/b2-wordpress/tests/lazy-bodies-e2e.sh` is the gate on that. It runs e2e.sh from an empty OPcache at
  the default 48 MB, where part of WordPress and WooCommerce takes the fallback, and requires
  `split_scripts > 0`, `mismatch == 0` and `noregion == 0`. Its red control is lean-trim, which has no counters.
- Only scripts persisted into shared memory are split. So `opcache.sh` takes `PRIME_OPCACHE_MB`, the shared
  memory of the priming run only (opt-in). At the runtime default of 48 MB, 765 of 2,076 admin-e2e scripts
  overflow into the fallback and would ship unsplit (#610). 128 holds all of them. The `lazy-bodies` job
  primes lean-lazy at 128 and reads the split count with `LB_MC=128 tests/lazy-bodies-e2e.sh`. Unset keeps
  today's priming, so the eager zips that ship now are unchanged. It becomes the default with the
  lazy-body default (S5).
- **M2b, the lazy load (#582 issuecomment-6889399893).** Each lazy body is one span of the tail, with its
  own table of interned strings and an adler32, in a per-script body directory. A script that loads from
  the file cache into shared memory reads only its head. Each named function and method points at a
  shared trampoline of 256 ops (`ZEND_PF_LAZY_BODY`, op k carries k). Its frame fields are real, so the
  caller pushes the right frame. The first call reads the span and its strings from the `.bin`, checks the
  adler32 and unserializes them into one chunk. Only then does it write the body into every op_array that
  shares it, and it continues at op k of the real body.
- **A failed load** (a short read, EIO from a remote pack, a bad checksum) installs nothing. It throws a
  catchable `Error` that names the function and the path, and the next call tries again. It never bails.
- **Never lazy:** the main script, closures, a function with 256 or more declared parameters, a script
  compiled at run time, and a file that the store marks with `pf_xref`. `pf_xref` counts pointers into the
  tail from outside their own body. Example: the optimizer shares a class constant's array with a method
  literal, so the constant points into that method's body. Such a file always loads whole.
- **Code that reads opcodes without a call** asks for the body first: named arguments that skip a default
  (`zend_handle_undef_args`), Reflection default values, and the text of an inheritance error. The trait
  collision check compares body ids (`zend_pf_body_id`), not opcodes pointers, because every unloaded body
  shares the trampoline.
- `opcache.pagefeather_lazy_load=0` loads whole files on the same engine (the eager arm of the tests).
  `opcache.protect_memory=1` also turns the lazy load off, because the load writes shared memory.
- **Counters** in `pagefeather_lazy_bodies`: `lazy_scripts`, `eager_scripts`, `xref_scripts`, `body_loads`,
  `body_fail`, `body_bytes_loaded`, `body_bytes_resident`, `body_load_ns` and `copy_installs`.
- **Tests:** `opcache/lazy/` holds the fixtures and `probe.php` (tests 1 to 11 and 13 of the design).
  `opcache/lazy/run-native.sh` runs it on a native php-cli built with the patch, lazy, eager and compiled.
  `opcache/lazy/mutations.py` breaks each mechanism and requires its case to go red. The
  `lazy-native` job runs both. `spikes/b2-wordpress/tests/lazy-bodies.test.mjs` runs the same probe on the
  wasm engine, plus the read-hook delay (12), a remote read that fails once (14) and observers on
  lean-stats-lazy (16). `LB_PRIMED=1 tests/lazy-bodies-e2e.sh` runs e2e.sh and woo.py from a primed zip and
  requires `body_fail == 0`. It also prints the M2c reading for the first `post-new.php` after a boot.
- M2c (the measurement against M1, and the fallback if the first editor request after a boot spends over
  250 ms or 5% of its time in body loads) comes next.
