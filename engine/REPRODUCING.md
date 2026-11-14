# Reproducing the engine we ship

Stage S1 of issue #582. Measured 2026-11-14 on GitHub-hosted `ubuntu-latest`, workflow
`pagefeather-engine.yml`.

## The standard

We build WordPress Playground's pipeline unchanged (`engine/build.sh`, pins in `engine/UPSTREAM`).
Two builds that set `PHP_UNAME` and `SOURCE_DATE_EPOCH` to the shipped binary's values
(`ENGINE_PIN_ENV=1`) must:

1. be byte-identical to each other (the `determinism` job), and
2. equal the shipped `@php-wasm/web-8-3` 3.1.62 wasm **except its second embedded compile time**
   (`engine/tools/repro-check.mjs`).

Bit-for-bit identity with the shipped wasm cannot be reached. The shipped wasm embeds two
`__TIME__` values from two compile units (`09:42:29` and `09:42:58`), and one `SOURCE_DATE_EPOCH`
gives both units the same time.

## Why the unchanged build differs

Only the `datacount`, `code` and `data` sections differ. Type, import, function, export, element
and global are identical. The printable strings name two build-host facts:

- PHP's configure-time `uname -a`. The shipped build ran on `linuxkit ... aarch64` (Docker on an
  ARM host). Ours runs on `azure` or `aws ... x86_64`. The strings have different lengths.
- The compiler's `__DATE__` and `__TIME__`.

A length change in the data moves every later address, and the code holds those addresses as
constants.

## Why a pinned build differs

With both facts pinned, the only string difference is the lost `09:42:58`. Both compile units then
emit `09:42:29`, and the linker merges the two equal strings. The wasm is 8 bytes shorter, and later
addresses move down:

- global: 51 differing bytes, all of them an address moved by 16 (or its LEB128 carry).
- code: 11,956 differing bytes. 11,953 of them are an address moved by 9 (the merged string) or 16
  (after alignment), as LEB128 shows it. The residue is 3 bytes: one constant moved by 8, and one
  `i32.const` moved by 1538. **Inference, not verified:** string-pool merging lays out the merged
  strings unevenly. `repro-check.mjs` pins this residue exactly, so a change in either direction
  fails.

## The checks go red

`repro-check.mjs` was run on five inputs. It holds on both pinned builds. It fails on the unchanged
build (the host strings), on the `prepare.sh` copy (`frankenphp` gone, memory section changed) and
on the shipped wasm against itself (no string lost). `wasm-compare.mjs` has a control step in the
job that must report "differs" on two different files.

## The loader

After upstream's own prettier 3.8.2 and its `.prettierrc`, our loader equals the shipped
`php_8_3.js` except one line: `dependenciesTotalSize`, the wasm's size. The shipped loader passes
`prettier --check`. The two pinned builds' loaders are byte-identical.

## Time

A cold build with no cache takes 468 to 605 s for `engine/build.sh` (checkout 71 to 93 s, base image
99 to 125 s, PHP 293 to 401 s), and the whole job about 8 to 11 minutes. It uses upstream's prebuilt
library archives. The runner had 88 GB of free disk before the build.
