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

- **M2a, the layout (this flag today).** `opcache/pf-lazy-bodies.patch` makes OPcache place the body parts
  of every function and method (literals, opcodes, live ranges, try/catch; not the main script) in a
  tail region of each script's block. The file cache header records where the tail starts
  (`pf_body_offset`, `pf_body_size`), and the system id changes with the flag, so lazy and eager files
  never mix. Files still load EAGERLY: nothing about running PHP changes.
- `tools/bin-split.py <opcache.zip>` checks the layout of every `.bin` and sums it. The header size is
  read from each file's own length (80 bytes with the patch, 72 without), so `--expect-eager` passes an
  eager zip and the default mode refuses it (the red control in the `lazy-bodies` job).
- M2b (the lazy load at first call) and M2c (the measurement against M1) come next.
