# Design: plugins and themes installed from wp-admin persist (pagefeather#407, alpha gate #422 Gate 2)

> **SUPERSEDED (2026-11-13) by #458.** Conrad ruled that core, plugin and theme installs and updates are code deploys, not wp-admin work. `CODE_PERSIST` was removed, and every site is code-locked. This document stays as the design record of what was built and measured (#433).

Status: DESIGN ONLY, at the lead's gate. Written 2026-11-13 by rollins (seat rollins-sb1114b).
Builds on #293 (lever B) and the #394 measurements of the same day. A number with no source is
labeled unmeasured.

## 0. The rule and the constraint

- **The rule** (Conrad, 2026-11-13): an install from wp-admin stays installed, as in WordPress.
  Updates and deletes behave as usual too.
- **The constraint** (#394, measured on pf394a): isolate memory is the product's blocker today. A
  `post-new.php` render is WASM 133 to 143 MiB plus the 44 MiB bundle, against a reset point near
  188 MiB. Any byte an installed plugin keeps resident comes out of that same budget. #293 already
  said it: persistence does not move the memory wall. So this design has to share the #394 bundle
  machinery, not add a second resident store.

## 1. Today

- PHP's files are an in-memory file system rebuilt from `site.zip` at each runtime boot
  (`index.js` `boot()`, 1115 to 1162). An install unzips into it and is gone at the next boot.
  On b-dosql, most requests boot (#394), so an install is lost almost at once.
- The database keeps the plugin in `active_plugins`. WordPress then deactivates it at the next
  admin load, because the file is missing. That is a silent state change.
- One-click sites lock installs (`DISALLOW_FILE_MODS`, `site-lock.mjs:15`, #401) until this lands.

## 2. The design: a code store in R2, indexed in the site's own SQLite

### 2.1 Capture (an mu-plugin plus one new Worker op)

- `php/code-persist.php` (mu-plugin) hooks `upgrader_process_complete`, for plugin and theme,
  install and update, and `deleted_plugin` / `deleted_theme`. It runs only for a user with
  `install_plugins` / `install_themes`, or `delete_*`.
- On install or update it sends one op through the existing bridge (`skyphusion_worker_call`,
  `php/d1-pdo.php:26`, handled in `index.js` `handleMessage`, 973): `{code: "put", type, slug}`.
- The Worker op (beside `r2op`, `index.js:1394`):
  1. checks that the path is exactly `wp-content/{plugins,themes}/<slug>`: no `..`, no symlink,
     a size cap;
  2. zips that directory from the in-memory file system (fflate, deflate);
  3. PUTs it to the site's own bucket `MEDIA` at `_code/<type>/<slug>/<sha256>.zip`
     (content-addressed, so a retry is idempotent);
  4. THEN writes one row to `_pf_code(type, slug, version, key, sha256, bytes, files, updated_at)`
     in the object's SQLite;
  5. bumps `_pf_code_state.gen`.
- **Never silent:** if the PUT or the row fails, the op returns an error. The mu-plugin turns it
  into a `WP_Error` that the installer shows, AND removes the unzipped directory, so the site does
  not look installed when it is not. The order (object first, then row) means a crash leaves at
  worst an orphan object, never a row that points at nothing. A cron sweep deletes orphans.
- **Delete:** row first, then the object.
- **Update:** a new object and the row replaced in one statement, then the old object deleted.

### 2.2 Load (boot, and a cheap check per request)

- At runtime boot, before the first `php.run` (async, so no sync-read problem), the Worker:
  1. reads `_pf_code`;
  2. GETs each object from R2 in parallel;
  3. mounts it with the same lazy path as `site.zip` (`zipEntries` + `lazyFile`, `index.js`
     316 to 417) under `wp-content/<type>s/<slug>`.
- Each request start reads `_pf_code_state.gen` (one SQLite read). If it moved, the runtime mounts
  the change before `php.run`. That keeps a pool of runtimes, or a runtime booted before an
  install, correct.
- **Precedence:** a slug that the BUILD ships (core, WooCommerce, `IMPORT_PLUGINS`) is the
  build's. v1 refuses a wp-admin install or update over a build slug: `upgrader_pre_install`
  returns a WP_Error, and that slug's update offer is hidden. Those slugs carry the primed OPcache
  that the memory budget depends on (#313). Updating them stays a deploy. A row for a build slug
  is ignored at boot and logged.

### 2.3 Memory: why this must ride on #394

- Mounted the way `site.zip` is today, every installed zip stays RESIDENT in the isolate.
  Elementor alone is a 22.3 MB zip (#293). That is exactly the budget #394 is short of.
- So v1 ships with an **installed-code budget** (`CODE_BUDGET_MB`, default set from the #394 L1
  measurement). An install that would pass the budget is refused with a plain admin notice:
  "this plugin needs more memory than this site has". It is not accepted and then broken.
- The real fix is the same as #394 L2. Installed code joins the bundle's hot-set-plus-miss-path
  machinery: the files the plugin actually reads stay resident, and the rest is fetched only on a
  miss. Then an installed plugin costs about what it READS (M0: a request reads about 1 MiB of 69
  MiB of source), not its zip size.
- **OPcache:** an installed plugin is not in `opcache.zip`. At OPcache 48 the shared memory is
  already full (M0 local: 112 bytes free, 1,305 scripts). So its scripts compile per request into
  the PHP heap, and WASM grows. v2 persists the runtime's own OPcache file-cache entries for
  `_code` paths to R2 (`_code/.../<sha>.opcache.zip`), keyed by PHP's system id directory, so a
  new PHP build ignores them safely. That compile cost is unmeasured: experiment 1 of #293.

### 2.4 Deploys and resets

- A deploy (`site update`) rebuilds the bundle only. `_pf_code` and the R2 objects survive it,
  because they are data, not code.
- An isolate reset loses nothing: the next boot remounts from R2.
- A rollback of the bundle keeps the installed plugins, as on a LAMP host.
- Snapshots (`snapshot.py`) gain the `_code/` prefix.

## 3. Order of work, and what blocks what

1. **Now, small, independent:** the capture and load path, with the code budget, behind
   `CODE_PERSIST=on`. Plus a WP-native check: an installed plugin survives a forced runtime boot
   (`/_install`-style test route) and an isolate reset. About 3 days with tests.
2. **#293 experiment 2** (no build): time an R2 GET of 0.3 / 5 / 22 MB from the site object, cold
   and warm, on pf394a. #293 measured a HEAD at about 0.7 s cold. That adds to every boot, which
   #394 is making rare.
3. After #394 L1 frees memory: set `CODE_BUDGET_MB` from measured headroom. Run Gate 2 on the
   sample store for SEOPress and Yoast first (small), then Elementor: install from wp-admin,
   survive a deploy and a reset, activate, admin screens, settings save, visible job, 0 write-loss
   over 10 rounds.
4. After #394 L2: installed code joins the hot-set machinery, and the budget can rise.

## 4. Risks

- **Memory** (above): until #394 frees room, a persisted plugin can make admin pages fail MORE
  often. The budget keeps that honest, not hidden.
- **The install request itself** is an admin write on an isolate at its limit (#394). Zipping a
  22 MB plugin in the same request costs JS heap. Unmeasured. If the install request then resets,
  the existing write-loss 500 answers, and the content address makes a retry safe.
- **Cost:** R2 Class A per install (one PUT); Class B per boot per installed plugin (one GET each).
  At rest that is near zero, inside the free tier: R2 pricing, read 2026-11-13.
- **Plugins that write into their own directory at runtime** (caches, generated CSS, as Elementor
  does under `uploads`, which is already R2): writes inside `wp-content/plugins/<slug>` after
  install are not persisted. v1 documents it; the plugin suite run shows which ones need more.
- **Security:** only the install capability triggers a PUT. The op confines the path to one slug
  directory. The objects are private (R2, no public route). Same trust as WordPress: an admin who
  can install a plugin can run code.

## 4a. Approach a (Hyperdrive MySQL), added 2026-11-13

Conrad ruled that the Hyperdrive path stays open for WooCommerce stores (it is the only path to high
concurrency). So the code store must work on approach `a` too, where PHP runs in the Worker and the
database is MySQL, with no Durable Object SQLite.

- **Shared:** the R2 objects (`_code/<type>/<slug>/<sha256>.zip`), the mu-plugin, the boot mount,
  the sha check, and the budget. Approach `a` boots through the same `index.js` `boot()`
  (`index-a.js` only swaps the database handler).
- **The index is an adapter** (`code-store.mjs`):
  - `sqliteIndex` on b-dosql;
  - `mysqlIndex` on `a`: two tables, `pf_code` and `pf_code_state`, in the site's MySQL, through
    the same bridge WordPress uses (`dbHandler`).
  The SQL is the subset both engines accept. Writes run in `BEGIN` / `COMMIT`, and every value is
  validated or an integer before it becomes a literal.
- **Why MySQL and not an R2 manifest object:** the index then lives with WordPress's own data. A
  database backup or restore restores the matching plugin set, and a write is one transaction. An R2
  manifest would need conditional puts and a HEAD per check (Class B per request on a busy store).
- **Many isolates:** `a` scales out (123 isolates at 50 concurrent, `docs/results.md:182`). Each
  isolate checks the generation at most every `CODE_CHECK_S` seconds (default 5), so an install
  shows on the other isolates within that time. b-dosql checks on every request: one object, one
  SQLite read.
- **Not yet on `a`:** the daily orphan sweep. It runs from the b-dosql alarm, and `a` has no
  Durable Object. Orphans are harmless (never loaded). The sweep for `a` comes with its cron path.
- **Tests:** every store test runs against both adapters on a real SQLite
  (`tests/code-store.test.mjs`: the crash windows, including a COMMIT that fails after the row was
  written; the budget boundary; a second isolate; the check interval; no quote or backslash from a
  value ever reaches a statement). The SQL on a real MySQL is checked on the `a` throwaway in Gate 2.

## 5. Not in v1

- Core updates (#406).
- wp-admin updates of build-shipped plugins.
- File edits from the plugin editor (`DISALLOW_FILE_EDIT` stays).
