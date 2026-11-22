# Conformance runs: WordPress's and WooCommerce's own test suites (#759)

The support matrix (#759) comes from running the projects' own test suites against a site on each tier. Those suites
need content that no real site may carry, so a deploy that carries it is for a throwaway only.

## The content and the gate (#764)

`tests/conformance/prepare-content.sh` (#763) builds the content and prints the build line. It is the one source:
WooCommerce Cleanup (`GET wc-cleanup/v1/reset` deletes every order, product, coupon, term and media file and truncates
tables), the WooCommerce e2e test helper (sets and deletes options over REST), Gutenberg's test plugins and themes,
and the throwaway marker mu-plugin `pf-conformance-throwaway.php`. Both upstream suites also delete all posts.

`deploy/conformance.sh` keys on that **content**, never on a flag, so it cannot reach a site by a path that skips the
check. The content is present when any of these holds:

- `IMPORT_MU_PLUGINS` names `pf-conformance-throwaway.php`;
- `IMPORT_PLUGINS` names `woocommerce-cleanup`, `woocommerce-e2e-test-helper` or `gutenberg-test-plugins`;
- `SUITE` or `THEME_SUITE` points into `tests/conformance/` (the conformance-only pins);
- `IMPORT_CONTENT` is a `wp-content` that holds `mu-plugins/pf-conformance-throwaway.php`, whatever `IMPORT_*` says.

With the content, a deploy needs `CONFORMANCE=on` (the run states that it carries this content: a deploy-time
statement only, never rendered or recorded), `THROWAWAY=1`, and a named site that is not live (neither `deploy/live-sites/<name>.env`
nor `deploy/wfp/live-sites/<name>`; ggc and ggc-test are refused). It is checked, before any step, at the entry of
`deploy/deploy.sh` and of every Workers for Platforms command (`site add`, `site update`, each site of `update --all`,
`site.sh up`, `up.sh`). A `site update` checks again on the site's **recorded** build inputs, which can carry the
content, and `render_user` checks as the last guard.

## A run

1. **Build and deploy:** the throwaway with `prepare-content.sh`'s line, `CONFORMANCE=on THROWAWAY=1`, and these settings:
   - `TURNSTILE_LOGIN` must be `off`. The suite login post has no token.
   - `TURNSTILE_LOSTPASSWORD` must be `off`. The suite lost-password posts cannot complete the challenge.
   - `TURNSTILE_SITEKEY` must be `1x00000000000000000000AA`. That is the always-pass test site key.
   - `TURNSTILE_SECRET` must be `1x0000000000000000000000000000000AA`. That is the always-pass test secret.
   - Do not set `TURNSTILE_WOO` or `TURNSTILE_COMMENTS` to `off`. Those gates stay on.
   - The deploy refuses any other site key or secret. A real site key stops classic checkout (#940).
   - `WOO_EXTRAS` must NOT be `off`: it forces `woocommerce_allow_tracking` off, which the WooCommerce suite needs on.
   - `HTTP_ALLOW_HOSTS` must be `.wordpress.org,.woocommerce.com,.gravatar.com,cldup.com`: the default list plus `cldup.com`.
     Gutenberg's `specs/editor/blocks/image.spec.js` "should upload external image to media library only when the toolbar
     button is clicked" sideloads `https://cldup.com/...` on the server. The default list refuses it (`POST /wp/v2/media`
     500, "host not in HTTP_ALLOW_HOSTS: cldup.com", cf759hw 2026-11-22). This is operator install config, as a real
     operator who wants external image sideload sets it (the lead's ruling, #759). The default still refuses it.
2. **Seed** (it also activates the two WooCommerce test plugins the line copied in; Gutenberg's stay inactive): `B=<site> ADMIN_PASSWORD=<the workspace's> python3 -I tests/conformance/seed.py <out>` (#775). It owns all
   setup and checks each item. `<out>/creds.env` (mode 600, `export` lines) holds the admin's account password, which
   is an application password (one value passes both the login form and Basic, #762), and the customer's.
   For the wc and wc-api suites, seed with `SEED_RESET_STORE=1`: the seed first restores Basic auth (a new
   application password), then resets the store (`GET wc-cleanup/v1/reset` with that password, as upstream's
   "reset" project does), only on a marked throwaway, before any content step, and records it in `seed.json`.
   As soon as that reset answers, success or failure, the seed revokes the application password it just minted
   (`DELETE /wp/v2/users/<id>/application-passwords/<uuid>`). If the revoke fails, the seed stops and says so.
   A wp run's revoke-all spec leaves the form login working and Basic dead (#1151). The reset does not send the
   password from creds.env. Without the reset the store keeps every product of earlier runs, and the shop page
   differs from stock.
3. **Run:** `. <out>/creds.env`, then `runner.py prepare` (it checks the seed and never writes), then the suite
   (`tests/conformance/vps-run.sh`). Each run asserts that the auth setup really logged in (`runner.py check-state`).
4. **The REST routes:** `tests/conformance/routes.py` (#779) over the site's own index, with `WP_PASSWORD`.
5. **Reseed** between the API half and the browser half: `seed.py <out>` again, with `ADMIN_PASSWORD` unset.
   **Reseed after every wp run, too.** The wp suite's "revoke all the application passwords" spec revokes the seed's
   application password, so Basic auth answers 401 until the next seed (measured 2026-11-20 on `cf759p`: a REST upload
   got 401 right after a wp run). The account password still matches it, so the next seed logs in through the form.
   That seed mints a new application password before the store reset, and revokes it as soon as the reset answers (#1151).
6. **A WordPress-only site** (no WooCommerce, e.g. a Workers Free tier): seed with `SEED_NO_WOO=1`. The seed then skips the
   WooCommerce items and names each one as skipped in `seed.json`; it fails if the site does have `wc/v3`. Run wp and gb only.

## Credentials in collected files (#1291)

A failing request's dump prints the site's Basic credentials. The WooCommerce suite's Axios errors print the full URL, and Playwright's error context prints the request headers. Two shapes:
- URL userinfo: `https://admin:<password>@<host>/...`
- an `Authorization: Basic <token>` (or `Bearer`) header, in any quoting.

They are throwaway admin application passwords. Even so, nothing that carries them may leave the box:
- **`vps-run.sh collect` redacts** the collected text files and the run's `report.json` in place before it archives them (`tests/conformance/redact.py`). The password becomes `***` (`admin:***@`, `Basic ***`). If the redact fails, collect STOPs and archives nothing.
- **A box or laptop script redacts its own run log** before uploading or sharing it: `tests/conformance/vps-run.sh redact <log>`.
- **`trace.zip` files stay on the laptop.** A trace records request headers, `Authorization` among them, and a zip cannot be redacted without rewriting it. So `traces-*.tgz` and extracted traces never go into an artifact, an issue, a PR or a results row. Only their findings do: a status, a time, an x-pf-call, a ray.

Check before you share a file: `grep -cE '://[^/ :@]+:[^@ /*]+@|[Aa]uthorization["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?[[:space:]]*(Basic|Bearer)[[:space:]]+[A-Za-z0-9+/=._~-]{4,}' <file>` must print 0. Never print the matches themselves.

## Browsers on Cloudflare Browser Run

`PF_BROWSER=browser-run` runs a suite's browsers on Cloudflare Browser Run (hosted Chromium over CDP) instead of on the
runner machine. `vps-run.sh` preloads `tests/conformance/pf-browser-run.cjs`, which turns `chromium.launch` into
`connectOverCDP`. Set `PF_BROWSER_RUN_ACCOUNT` (the account id) and `PF_BROWSER_RUN_TOKEN_FILE` (a mode 600 file with a
Browser Run token; the token is never printed). `PF_WORKERS` sets the worker count there; the default is 1, and locally it is
always 1.

- Chromium only: firefox and webkit are refused.
- The remote Chromium is a different build from the pinned local one. Each worker logs `@event browser-run` with its
  version. A row says which browser ran, and a Browser Run row is never mixed with a local one.
- Launch options cannot reach a remote browser (`connectOverCDP` attaches to one that is already running). Each worker's
  `@event browser-run` line names the options the suite passed (`dropped_launch_options`, and `dropped_args` for flags).
  At the pins: the wp and gb suites pass only `headless` (and gb's webkit project, refused here); wc passes
  `channel: 'chromium'`, so locally wc runs Chrome for Testing in new headless mode, while on Browser Run it is
  Cloudflare's Chromium. No suite passes `args` (no `--disable-web-security` or similar). Context options (viewport,
  locale, `ignoreHTTPSErrors`, `reducedMotion`, `strictSelectors`) are per context and still apply.
- The baseline of this instrument (`cf759p`, the wp suite, 2026-11-20; [results.md](results.md) row "Browser Run
  baseline"): Browser Run at 1 worker 18 of 18, local at 1 worker 17 of 18 (the one difference a #1022 memory reset on
  the site, not the browser), Browser Run at 4 workers 15 of 18 (interference). Browser Run is the default suite
  browser for wp and wc, at one worker per site.
- Browser Run is not valid for the Gutenberg keyboard and clipboard specs. On `cf759hw` (2026-11-21, [results.md](results.md)
  row "gb Browser Run") those specs fail on Browser Run and pass on a local browser. The cause is not identified. Gutenberg
  runs go on a Linux box with local Chrome. The full `cf759a` Browser Run gb row is unclassified for this reason (#1201).
- A remote browser reaches public URLs only: a workers.dev throwaway, yes; a local wp-env baseline, no.
- One worker per site. The wp and gb specs share the site's state: `requestUtils.deleteAllPosts()` runs before each test,
  and the posts have fixed titles. Measured on `cf759p`, 2026-11-20: 4 workers gave 15 of 18 (two posts with one title, a
  post already trashed by another worker) against 18 of 18 with 1. Run more suites on more sites at once for speed, never
  more workers on one site.

## Does a site keep its uploads? (media_probe.py)

The wp suite's only media spec tests a FAILED upload, so it passes with or without durable media (measured on `cf759f`,
2026-11-20: 18 of 18 with no R2 binding). `tests/conformance/media_probe.py` is the instrument for "uploads persist":

    B=<site> WP_USERNAME=... WP_PASSWORD=... python3 -I tests/conformance/media_probe.py <out.json> [--wait 90] [--keep]

It uploads a PNG it makes itself over REST (201). It GETs the full file (the same bytes) and each generated size (200,
an image type) on fresh connections. It waits, GETs a page, reads every file again, then deletes the attachment and
expects the full file to answer 404. An isolate's identity cannot be seen from outside: the wait and fresh connections
are the instrument, and the report says so. A row that says media works names this probe as its instrument.

## Upstream notes for the matrix

- **WooCommerce Cleanup's reset prints a database error on every database:** it runs
  `DELETE FROM wp_woocommerce_tax_classes`, a table WooCommerce has not created since 3.7 (`wc_tax_rate_classes`). The
  reset goes on and answers 200, and its `TRUNCATE TABLE` works on our SQLite (measured locally, 2026-11-16).
- **Upstream's `image-01.png` is a JPEG,** so WordPress stores it as `image-01.jpg`, on stock too. Match it by stem.
